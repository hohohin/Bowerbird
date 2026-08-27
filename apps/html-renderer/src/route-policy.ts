/**
 * 浏览器请求拦截策略（纯函数）—— HTML-RENDER-PLAN.md §5.1 双层离线保证的浏览器层。
 *
 * 页面只允许访问两个虚拟 origin：
 *   - http://bowerbird-render.invalid/document  —— 由本服务 fulfill 的文档本体；
 *   - http://bowerbird-assets.invalid/<key>     —— 由本服务按资源表 fulfill 的图片。
 * 其余一切请求（http/https/file/data/ws/about/任何 scheme、任何 host）一律 abort。
 * 模型无法表达任何真实 URL（sanitizer 先拒绝），这里是第二层确定性防线。
 */

export const DOCUMENT_URL = "http://bowerbird-render.invalid/document";
export const ASSETS_HOST = "bowerbird-assets.invalid";

export type RouteDecision =
  | { action: "fulfill_document" }
  | { action: "fulfill_resource"; key: string }
  | { action: "abort" };

const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function classifyRouteRequest(url: string): RouteDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { action: "abort" };
  }
  if (parsed.protocol !== "http:") return { action: "abort" };
  if (parsed.hostname === "bowerbird-render.invalid") {
    if (parsed.pathname === "/document" && parsed.search === "" && parsed.hash === "") {
      return { action: "fulfill_document" };
    }
    return { action: "abort" };
  }
  if (parsed.hostname === ASSETS_HOST) {
    const key = parsed.pathname.slice(1);
    if (parsed.search === "" && RESOURCE_KEY_PATTERN.test(key)) {
      return { action: "fulfill_resource", key };
    }
    return { action: "abort" };
  }
  return { action: "abort" };
}
