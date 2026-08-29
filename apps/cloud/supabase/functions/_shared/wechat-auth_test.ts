import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { ApiError } from "./errors.ts";
import {
  assertWechatCode,
  assertWechatLoginState,
  buildQrconnectUrl,
  parseWechatAccessToken,
  parseWechatUserinfo,
  wechatError,
  wechatIdentityEmail,
  wechatUserMetadata,
} from "./wechat-auth.ts";

Deno.test("qrconnect url carries app id, encoded callback and state", () => {
  const url = new URL(buildQrconnectUrl("wx1234567890", "https://bowerbird.cn/wechat-callback", "dt_01HAAAAAAA0AAAAA0A0A0A0AA"));
  assertEquals(url.origin + url.pathname, "https://open.weixin.qq.com/connect/qrconnect");
  assertEquals(url.searchParams.get("appid"), "wx1234567890");
  assertEquals(url.searchParams.get("redirect_uri"), "https://bowerbird.cn/wechat-callback");
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("scope"), "snsapi_login");
  assertEquals(url.searchParams.get("state"), "dt_01HAAAAAAA0AAAAA0A0A0A0AA");
  assertEquals(url.hash, "#wechat_redirect");
});

Deno.test("login state must carry a desktop or website prefix", () => {
  for (const state of ["dt_01HAAAAAAA0AAAAA0A0A0A0AA", "web_0123456789abcdef0123456789abcdef"]) {
    assertWechatLoginState(state);
  }
  for (const state of ["", "dt_short", "web_", "app_01HAAAAAAA0AAAAA0A0A0A0AA", `dt_${"x".repeat(65)}`, 42, null]) {
    assertThrows(() => assertWechatLoginState(state), ApiError, "state 无效");
  }
});

Deno.test("wechat code is shape-checked before hitting the WeChat API", () => {
  assertWechatCode("0123456789abcdef");
  assertWechatCode("code-with-dash_and_under");
  for (const code of ["", "short", "has space inside", "中文字符code", "x".repeat(129), 7]) {
    assertThrows(() => assertWechatCode(code), ApiError, "授权码无效");
  }
});

Deno.test("identity email is deterministic and separates unionid from openid", async () => {
  const byUnionid = await wechatIdentityEmail("unionid-abc");
  const byUnionidAgain = await wechatIdentityEmail("unionid-abc");
  const byOpenid = await wechatIdentityEmail("openid-xyz");
  assertEquals(byUnionid, byUnionidAgain);
  assertEquals(/^wx[0-9a-f]{24}@wx\.noreply\.bowerbird\.cn$/.test(byUnionid), true);
  assertEquals(byUnionid === byOpenid, false);
});

Deno.test("access token envelope maps errcode to caller-side or upstream errors", () => {
  const token = parseWechatAccessToken({
    access_token: "ACCESS_TOKEN",
    expires_in: 7200,
    openid: "OPENID",
    unionid: "UNIONID",
  });
  assertEquals(token, { accessToken: "ACCESS_TOKEN", openid: "OPENID", unionid: "UNIONID" });

  const missingUnionid = parseWechatAccessToken({ access_token: "A", openid: "O" });
  assertEquals(missingUnionid.unionid, null);

  for (const [payload, expectedCode] of [
    [{ errcode: 40029, errmsg: "invalid code" }, "invalid_request"],
    [{ errcode: 40163, errmsg: "code been used" }, "invalid_request"],
    [{ errcode: 45011, errmsg: "api limit" }, "upstream_failed"],
    [{ errcode: 1000, errmsg: "other" }, "upstream_failed"],
    [{ access_token: "A" }, "upstream_failed"],
  ] as const) {
    try {
      parseWechatAccessToken(payload);
      throw new Error("expected parseWechatAccessToken to throw");
    } catch (error) {
      assertEquals(error instanceof ApiError, true);
      assertEquals((error as ApiError).code, expectedCode);
    }
  }
  assertEquals(wechatError(45011).retryable, true);
  assertEquals(wechatError(40029).retryable, false);
});

Deno.test("userinfo parsing is best effort and tolerates error envelopes", () => {
  const profile = parseWechatUserinfo({
    openid: "OPENID",
    nickname: "园丁鸟",
    headimgurl: "https://thirdwx.qlogo.cn/mmopen/vi_32/xxx/132",
    unionid: "UNIONID",
  });
  assertEquals(profile, {
    nickname: "园丁鸟",
    headimgurl: "https://thirdwx.qlogo.cn/mmopen/vi_32/xxx/132",
    unionid: "UNIONID",
  });

  assertEquals(parseWechatUserinfo({ errcode: 40003, errmsg: "invalid openid" }), null);
  assertEquals(parseWechatUserinfo({ nickname: "no openid" }), null);
  assertEquals(parseWechatUserinfo("junk"), null);
});

Deno.test("user metadata marks the wechat provider and refresh timestamp", () => {
  const metadata = wechatUserMetadata({
    openid: "OPENID",
    unionid: "UNIONID",
    nickname: "园丁鸟",
    headimgurl: "https://thirdwx.qlogo.cn/132",
  });
  assertEquals(metadata.provider, "wechat");
  assertEquals(metadata.openid, "OPENID");
  assertEquals(metadata.unionid, "UNIONID");
  assertEquals(metadata.nickname, "园丁鸟");
  assertEquals(metadata.avatar_url, "https://thirdwx.qlogo.cn/132");
  assertEquals(typeof metadata.wechat_linked_at, "string");
});
