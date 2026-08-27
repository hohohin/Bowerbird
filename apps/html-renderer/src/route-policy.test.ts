/**
 * 路由分类单测 —— §5.1 浏览器层离线边界。
 * 只有两个虚拟 origin 的精确形态可 fulfill；其余一切（含 https/file/data/ws/localhost/
 * 元数据地址/查询串/子路径）一律 abort。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRouteRequest, DOCUMENT_URL, ASSETS_HOST } from "./route-policy.ts";

test("document virtual origin is fulfilled exactly", () => {
  assert.deepEqual(classifyRouteRequest(DOCUMENT_URL), { action: "fulfill_document" });
  assert.equal(classifyRouteRequest("http://" + "bowerbird-render.invalid" + "/document?v=1").action, "abort");
  assert.equal(classifyRouteRequest("http://bowerbird-render.invalid/other").action, "abort");
  assert.equal(classifyRouteRequest("http://bowerbird-render.invalid/document#frag").action, "abort");
});

test("asset virtual origin maps key; malformed keys abort", () => {
  assert.deepEqual(classifyRouteRequest(`http://${ASSETS_HOST}/ref-1`), { action: "fulfill_resource", key: "ref-1" });
  assert.equal(classifyRouteRequest(`http://${ASSETS_HOST}/bad key`).action, "abort");
  assert.equal(classifyRouteRequest(`http://${ASSETS_HOST}/`).action, "abort");
  assert.equal(classifyRouteRequest(`http://${ASSETS_HOST}/a/b`).action, "abort");
  assert.equal(classifyRouteRequest(`http://${ASSETS_HOST}/x?v=1`).action, "abort");
});

test("everything else aborts: public, private, localhost, metadata, schemes", () => {
  const urls = [
    "https://example.com/",
    "http://example.com/",
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/",
    "http://10.0.0.1/",
    "http://192.168.1.1/router",
    "file:///etc/passwd",
    "data:text/html;base64,PHNjcmlwdD4=",
    "about:blank",
    "ws://example.com/socket",
    "wss://example.com/socket",
    "blob:https://example.com/xyz",
    "javascript:alert(1)",
    "ftp://example.com/x",
    "not a url",
  ];
  for (const url of urls) {
    assert.equal(classifyRouteRequest(url).action, "abort", url);
  }
});
