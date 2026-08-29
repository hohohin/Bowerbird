import { ApiError } from "./errors.ts";

// Pure helpers for the wechat-login edge function. Kept side-effect free so the
// Deno tests cover URL building, identity derivation and error mapping without
// touching the WeChat API.

export const WECHAT_STATE_PREFIX_DESKTOP = "dt_";
export const WECHAT_STATE_PREFIX_WEB = "web_";
const IDENTITY_EMAIL_DOMAIN = "wx.noreply.bowerbird.cn";
const QRCONNECT_URL = "https://open.weixin.qq.com/connect/qrconnect";

export interface WechatTokenResult {
  accessToken: string;
  openid: string;
  unionid: string | null;
}

export interface WechatUserInfo {
  nickname: string | null;
  headimgurl: string | null;
  unionid: string | null;
}

export interface WechatIdentityMetadata {
  openid: string;
  unionid: string | null;
  nickname: string | null;
  headimgurl: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * state 由发起端生成并原样回流：桌面 `dt_`（Rust pending 槽校验）、官网 `web_`
 * （中转页 sessionStorage 校验）。这里只做形状校验，防垃圾请求打到微信接口。
 */
export function assertWechatLoginState(state: unknown): asserts state is string {
  if (
    typeof state !== "string" ||
    !/^(?:dt_|web_)[A-Za-z0-9_-]{16,64}$/.test(state)
  ) {
    throw new ApiError("invalid_request", "微信登录 state 无效，请重新发起登录");
  }
}

export function assertWechatCode(code: unknown): asserts code is string {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(code)) {
    throw new ApiError("invalid_request", "微信登录授权码无效，请重新扫码");
  }
}

export function buildQrconnectUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    appid: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "snsapi_login",
    state,
  });
  return `${QRCONNECT_URL}?${params.toString()}#wechat_redirect`;
}

/**
 * 微信身份 → 确定性合成邮箱。同一微信（unionid 优先，缺失回退 openid）始终落在同一
 * auth.users 行；邮箱只作身份键，不发邮件（generateLink 建 号即 email_confirm）。
 */
export async function wechatIdentityEmail(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `wx${hex.slice(0, 24)}@${IDENTITY_EMAIL_DOMAIN}`;
}

export function wechatError(errcode: number): ApiError {
  const message = wechatErrorMessage(errcode);
  // 授权码无效/已使用是调用侧问题，其余（频率限制、服务繁忙等）视为上游故障。
  const code = errcode === 40029 || errcode === 40163 ? "invalid_request" : "upstream_failed";
  return new ApiError(code, message, code === "upstream_failed");
}

function wechatErrorMessage(errcode: number): string {
  switch (errcode) {
    case 40029:
      return "微信登录授权码无效，请重新扫码";
    case 40163:
      return "微信登录授权码已被使用，请重新扫码";
    case 40226:
      return "用户拒绝了微信授权，请重新扫码并确认";
    case 45011:
      return "微信接口频率限制，请稍后重试";
    case -1:
      return "微信系统繁忙，请稍后重试";
    default:
      return `微信登录失败（错误码 ${errcode}），请重新扫码`;
  }
}

/** 解析 /sns/oauth2/access_token 响应；errcode 非零或字段缺失按上游错误抛出。 */
export function parseWechatAccessToken(json: unknown): WechatTokenResult {
  const record = asRecord(json);
  const errcode = typeof record.errcode === "number" ? record.errcode : 0;
  const accessToken = nonEmptyString(record.access_token);
  const openid = nonEmptyString(record.openid);
  if (errcode !== 0 || !accessToken || !openid) throw wechatError(errcode);
  return { accessToken, openid, unionid: nonEmptyString(record.unionid) };
}

/** 解析 /sns/userinfo 响应；尽力而为——失败返回 null，不阻塞登录。 */
export function parseWechatUserinfo(json: unknown): WechatUserInfo | null {
  const record = asRecord(json);
  if (typeof record.errcode === "number" && record.errcode !== 0) return null;
  const openid = nonEmptyString(record.openid);
  if (!openid) return null;
  return {
    nickname: nonEmptyString(record.nickname),
    headimgurl: nonEmptyString(record.headimgurl),
    unionid: nonEmptyString(record.unionid),
  };
}

/** 每次登录刷新 user_metadata，昵称/头像变更随新会话下发。 */
export function wechatUserMetadata(identity: WechatIdentityMetadata): Record<string, unknown> {
  return {
    provider: "wechat",
    openid: identity.openid,
    unionid: identity.unionid,
    nickname: identity.nickname,
    avatar_url: identity.headimgurl,
    wechat_linked_at: new Date().toISOString(),
  };
}
