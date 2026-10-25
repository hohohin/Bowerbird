import assert from "node:assert/strict";
import { test } from "node:test";
import { userErrorMessage } from "../user-error.js";

test("unknown diagnostics never become visible, including Chinese wrappers and error objects", () => {
  for (const error of [
    new Error("HotKey already registered: HotKey { mods: Modifiers(0x0), key: F1 }"),
    new Error("读取失败：SQLITE_BUSY at C:\\private\\library.db"),
    new Error("微信登录未配置（缺 WECHAT_APP_SECRET）"),
    { error: { message: "postgres connection secret=example" } },
    { message: "Unauthorized bearer secret" }, null, undefined,
  ]) assert.equal(userErrorMessage(error, "操作暂不可用。"), "操作暂不可用。");
});

test("known validation, login, network and limits keep actionable Chinese guidance", () => {
  assert.match(userErrorMessage(new Error("最多支持 8 张参考图")), /8 张.*减少/);
  assert.match(userErrorMessage(new Error("此账号没有兑换码管理权限")), /管理员账号/);
  assert.match(userErrorMessage({ status: 401, message: "invalid token" }), /重新登录/);
  assert.match(userErrorMessage({ error: { code: "over_email_send_rate_limit" } }), /频繁/);
  assert.match(userErrorMessage(new TypeError("Failed to fetch")), /检查网络/);
  assert.match(userErrorMessage({ status: 402 }), /积分不足/);
});

test("timeouts do not claim the operation failed or invite a duplicate submission", () => {
  for (const error of [{ name: "AbortError" }, { name: "TimeoutError" }, { status: 504 }]) {
    assert.match(userErrorMessage(error), /暂未确认结果.*刷新/);
    assert.doesNotMatch(userErrorMessage(error), /失败|重试/);
  }
});
