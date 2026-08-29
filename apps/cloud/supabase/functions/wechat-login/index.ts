import { createClient } from "jsr:@supabase/supabase-js@2";
import { ApiError, errorResponse, jsonResponse, requestId, safeLog } from "../_shared/errors.ts";
import { assertBodySize, corsHeaders } from "../_shared/limits.ts";
import {
  assertWechatCode,
  assertWechatLoginState,
  buildQrconnectUrl,
  parseWechatAccessToken,
  parseWechatUserinfo,
  wechatIdentityEmail,
  wechatUserMetadata,
  type WechatIdentityMetadata,
} from "../_shared/wechat-auth.ts";

// WeChat Open Platform "website app" QR login, exchange half. The browser half is a static
// relay page on the ICP-filed domain (bowerbird.cn/wechat-callback); it forwards
// code+state either to the bowerbird:// deep link (desktop) or back into this function
// (website). This function is the only place that touches WECHAT_APP_SECRET.
//
// Sessions are minted through GoTrue itself: service-role generateLink(magiclink) creates
// the auth.users row (billing trigger fires) and a token_hash, then /auth/v1/verify issues
// a native access+refresh pair — the desktop keyring refresh chain works unchanged.

const WECHAT_API_TIMEOUT_MS = 15_000;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new ApiError("not_configured", `微信登录未配置（缺 ${name}）`);
  return value;
}

function namedKey(objectEnv: string, directEnv: string, legacyEnv: string): string {
  const direct = Deno.env.get(directEnv)?.trim();
  if (direct) return direct;
  const objectValue = Deno.env.get(objectEnv)?.trim();
  if (objectValue) {
    try {
      const value = (JSON.parse(objectValue) as Record<string, string>).default?.trim();
      if (value) return value;
    } catch {
      throw new ApiError("not_configured", `${objectEnv} 格式无效`);
    }
  }
  const legacy = Deno.env.get(legacyEnv)?.trim();
  if (legacy) return legacy;
  throw new ApiError("not_configured", `${directEnv} 未配置`);
}

function supabaseUrl(): string {
  return requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
}

async function wechatFetch(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(WECHAT_API_TIMEOUT_MS) });
  const json = await response.json().catch(() => null);
  if (!response.ok || json === null) throw new ApiError("upstream_failed", "微信接口暂不可用，请稍后重试", true);
  return json;
}

async function exchangeWechatSession(
  code: string,
): Promise<{ tokens: Record<string, unknown>; userId: string | undefined; identity: string }> {
  const appId = requiredEnv("WECHAT_APP_ID");
  const appSecret = requiredEnv("WECHAT_APP_SECRET");

  // 1. code → access_token + openid (+ unionid when bound on the open platform account).
  const tokenJson = await wechatFetch(
    `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(appId)}&secret=${
      encodeURIComponent(appSecret)
    }&code=${encodeURIComponent(code)}&grant_type=authorization_code`,
  );
  const token = parseWechatAccessToken(tokenJson);

  // 2. Profile is best effort; a failed /sns/userinfo must not block login.
  let profile: WechatIdentityMetadata = {
    openid: token.openid,
    unionid: token.unionid,
    nickname: null,
    headimgurl: null,
  };
  let userinfoUnionid: string | null = null;
  try {
    const userinfoJson = await wechatFetch(
      `https://api.weixin.qq.com/sns/userinfo?access_token=${
        encodeURIComponent(token.accessToken)
      }&openid=${encodeURIComponent(token.openid)}`,
    );
    const userinfo = parseWechatUserinfo(userinfoJson);
    if (userinfo) {
      userinfoUnionid = userinfo.unionid;
      profile = { ...profile, nickname: userinfo.nickname, headimgurl: userinfo.headimgurl };
    }
  } catch {
    // Keep the identity-only profile from step 1.
  }

  // 3. Deterministic identity email — same WeChat always lands on the same auth.users row.
  const identity = token.unionid ?? userinfoUnionid ?? token.openid;
  const email = await wechatIdentityEmail(identity);
  const metadata = wechatUserMetadata(profile);

  // 4. Mint a real GoTrue session: generateLink creates the user (billing trigger fires on
  //    first login) and returns a one-time token_hash; verify exchanges it for tokens.
  const admin = createClient(supabaseUrl(), namedKey(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { data: metadata },
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash || !link.user?.id) {
    throw new ApiError("internal_error", "微信登录会话创建失败，请重试", true);
  }
  await admin.auth.admin.updateUserById(link.user.id, { user_metadata: metadata });

  const verify = await fetch(`${supabaseUrl()}/auth/v1/verify`, {
    method: "POST",
    headers: {
      "apikey": namedKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"),
      "content-type": "application/json",
    },
    body: JSON.stringify({ token_hash: tokenHash, type: "magiclink" }),
    signal: AbortSignal.timeout(WECHAT_API_TIMEOUT_MS),
  });
  const session = await verify.json().catch(() => null);
  if (
    !verify.ok || !session || typeof (session as Record<string, unknown>).access_token !== "string" ||
    typeof (session as Record<string, unknown>).refresh_token !== "string"
  ) {
    throw new ApiError("internal_error", "微信登录会话签发失败，请重试", true);
  }
  return { tokens: session as Record<string, unknown>, userId: link.user.id, identity };
}

Deno.serve(async (request) => {
  const id = requestId(request);
  let cors: HeadersInit = {};
  let userId: string | undefined;
  try {
    cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method === "GET") {
      // Entry point: build the qrconnect URL so appid/callback domain live only in Secrets.
      const state = new URL(request.url).searchParams.get("state");
      assertWechatLoginState(state);
      const qrconnectUrl = buildQrconnectUrl(
        requiredEnv("WECHAT_APP_ID"),
        requiredEnv("WECHAT_REDIRECT_URI"),
        state,
      );
      safeLog({ requestId: id, service: "wechat-login", status: "qr_issued" });
      return jsonResponse({ qrconnect_url: qrconnectUrl }, 200, cors);
    }

    if (request.method !== "POST") throw new ApiError("invalid_request", "仅支持 GET / POST", false, 405);
    assertBodySize(request);
    const body = (await request.json().catch(() => null)) as { code?: unknown; state?: unknown } | null;
    if (!body) throw new ApiError("invalid_request", "请求体必须是 JSON");
    assertWechatCode(body.code);
    assertWechatLoginState(body.state);
    // state 仅作形状校验与日志；跨端绑定由桌面 pending 槽 / 官网 sessionStorage 各自校验。

    const { tokens, userId: sessionUserId } = await exchangeWechatSession(body.code);
    userId = sessionUserId;
    safeLog({ requestId: id, userId, service: "wechat-login", status: "ok" });
    return jsonResponse(tokens, 200, cors);
  } catch (error) {
    safeLog({
      requestId: id,
      userId,
      service: "wechat-login",
      status: error instanceof ApiError ? error.code : "internal_error",
    });
    return errorResponse(error, id, cors);
  }
});
