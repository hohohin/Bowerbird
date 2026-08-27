/**
 * 受限 HTML/CSS sanitizer —— HTML-RENDER-PLAN.md §5.2（H1-T2）。
 *
 * 定位：**输入质量与减面措施**；容器断网 + 浏览器层全请求拦截才是最终能力边界。
 * 实现为确定性字符级 tokenizer（不用正则解析标签），策略是严格白名单：
 *   - 标签白名单（排版所需子集；script/iframe/object/embed/base/form/svg/a 等一律拒绝）；
 *   - 属性白名单（每标签闭集；未知属性即拒绝，包括 loading/decoding/srcset/on*）；
 *   - 图片引用只接受 `asset:<key>` 占位（url()/src 同规），不做任何 URL 解析；
 *   - CSS：拒绝反斜杠转义与注释；at-rule 只允许 @media/@supports；url() 只允许 asset: 形态；
 *   - 拒绝注释 / CDATA / 处理指令 / 未知声明；
 *   - 数量/深度/文本/样式上限（limits.ts）。
 * 返回被引用的资源 key 闭集，供 render-service 与资源表比对。
 */
import { RENDER_LIMITS } from "./limits.ts";

export type SanitizeOk = {
  ok: true;
  referencedResourceKeys: string[];
  stats: { tagCount: number; maxDepth: number; textChars: number; styleBytes: number };
};

export type SanitizeFail = {
  ok: false;
  code: "render_html_unsafe" | "render_input_invalid" | "render_document_too_large";
  reason: string;
};

export type SanitizeResult = SanitizeOk | SanitizeFail;

/** 允许的开放标签（含闭合标签要求；void 见 VOID_TAGS）。 */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "html", "head", "meta", "title", "style", "body",
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "section", "article", "header", "footer", "main", "nav", "aside",
  "figure", "figcaption", "blockquote", "pre", "code",
  "em", "strong", "b", "i", "u", "s", "small", "sub", "sup",
  "img", "br", "hr",
]);

const VOID_TAGS: ReadonlySet<string> = new Set(["img", "br", "hr", "meta"]);

/** 打开这些标签时，栈顶的同族未闭合标签按 HTML 规则隐式闭合。 */
const AUTOCLOSE_TOP: Readonly<Record<string, ReadonlySet<string>>> = {
  p: new Set(["p"]),
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  option: new Set(["option"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  tr: new Set(["tr", "td", "th"]),
  thead: new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]),
  tbody: new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]),
  tfoot: new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]),
};

/** 全局属性白名单。 */
const GLOBAL_ATTRS: ReadonlySet<string> = new Set(["class", "id", "style", "lang"]);
/** 各标签专有属性白名单。 */
const TAG_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  meta: new Set(["charset"]),
  img: new Set(["src", "width", "height", "alt"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  ol: new Set(["start"]),
};

const ASSET_REF_PATTERN = /^asset:([A-Za-z0-9_-]{1,64})$/;
const CSS_URL_ASSET_PATTERN = /^url\(\s*["']?asset:([A-Za-z0-9_-]{1,64})["']?\s*\)$/;
const INT_ATTR_PATTERN = /^(0|[1-9][0-9]{0,6})$/;

export function sanitizeHtml(html: string): SanitizeResult {
  const len = html.length;
  const stack: string[] = [];
  const referenced = new Set<string>();
  let tagCount = 0;
  let maxDepth = 0;
  let textChars = 0;
  let styleBytes = 0;
  let i = 0;

  while (i < len) {
    const ch = html[i];
    if (ch !== "<") {
      // 文本节点
      let next = html.indexOf("<", i);
      if (next === -1) next = len;
      textChars += next - i;
      if (textChars > RENDER_LIMITS.maxTextChars) return unsafe("text_length_exceeds_limit");
      i = next;
      continue;
    }

    // '<' 之后
    if (i + 1 >= len) return unsafe("dangling_lt");
    const next1 = html[i + 1];
    if (next1 === "!") {
      // 允许 <!DOCTYPE html>（大小写不敏感、无属性）；注释/CDATA 一律拒绝。
      const rest = html.slice(i, i + 16).toLowerCase();
      if (rest.startsWith("<!doctype")) {
        const close = html.indexOf(">", i);
        if (close === -1) return unsafe("malformed_doctype");
        const decl = html.slice(i + 9, close).trim().toLowerCase();
        if (decl !== "html") return unsafe("doctype_not_html");
        i = close + 1;
        continue;
      }
      return unsafe("comment_or_declaration_forbidden");
    }
    if (next1 === "?") return unsafe("processing_instruction_forbidden");

    const isClose = next1 === "/";
    let p = isClose ? i + 2 : i + 1;
    // 标签名
    if (p >= len || !isAsciiLetter(html[p])) {
      // 非 `<字母` / `</字母`：按文本处理（与浏览器一致，如 "a < b"）。
      textChars += 1;
      if (textChars > RENDER_LIMITS.maxTextChars) return unsafe("text_length_exceeds_limit");
      i += 1;
      continue;
    }
    let nameEnd = p;
    while (nameEnd < len && isAsciiAlnum(html[nameEnd])) nameEnd += 1;
    const tag = html.slice(p, nameEnd).toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return unsafe("tag_not_allowed");

    p = nameEnd;
    const attrs = new Map<string, string>();
    let selfClosing = false;
    // 属性解析
    while (p < len) {
      // 跳过空白
      while (p < len && isHtmlSpace(html[p])) p += 1;
      if (p >= len) return unsafe("tag_unterminated");
      if (html[p] === ">") {
        p += 1;
        break;
      }
      if (html[p] === "/") {
        if (html[p + 1] === ">") {
          selfClosing = true;
          p += 2;
          break;
        }
        return unsafe("stray_slash_in_tag");
      }
      // 属性名
      if (!isAsciiLetter(html[p])) return unsafe("attr_name_invalid");
      let aEnd = p;
      while (aEnd < len && isAttrNameChar(html[aEnd])) aEnd += 1;
      const attrName = html.slice(p, aEnd).toLowerCase();
      p = aEnd;
      let value = "";
      if (html[p] === "=") {
        p += 1;
        const q = html[p];
        if (q === '"' || q === "'") {
          p += 1;
          let vEnd = html.indexOf(q, p);
          if (vEnd === -1) return unsafe("attr_value_unterminated");
          value = html.slice(p, vEnd);
          p = vEnd + 1;
        } else {
          let vEnd = p;
          while (vEnd < len && !isHtmlSpace(html[vEnd]) && html[vEnd] !== ">") vEnd += 1;
          value = html.slice(p, vEnd);
          p = vEnd;
        }
        if (value.includes("<")) return unsafe("attr_value_contains_lt");
      }
      if (attrs.has(attrName)) return unsafe("attr_duplicate");
      attrs.set(attrName, value);
      // 属性后必须是空白 / '>' / '/>'（上面 unquoted 值后可能直接 '>'）
      if (p < len && html[p] !== ">" && html[p] !== "/" && !isHtmlSpace(html[p])) {
        return unsafe("attr_not_separated");
      }
    }

    tagCount += 1;
    if (tagCount > RENDER_LIMITS.maxTagCount) return unsafe("tag_count_exceeds_limit");

    if (isClose) {
      if (selfClosing) return unsafe("close_tag_self_closing");
      if (VOID_TAGS.has(tag)) return unsafe("void_tag_closed");
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) return unsafe("stray_close_tag");
      stack.length = idx;
      i = p;
      continue;
    }

    // 属性校验（open tag）
    const attrCheck = checkAttributes(tag, attrs, referenced);
    if (attrCheck) return attrCheck;
    if (tag === "img" && !attrs.has("src")) return unsafe("img_src_missing");
    for (const [name, value] of attrs) {
      if (name === "style") {
        styleBytes += Buffer.byteLength(value, "utf8");
        if (styleBytes > RENDER_LIMITS.maxStyleBytes) return unsafe("style_bytes_exceed_limit");
      }
    }

    if (tag === "style") {
      // 原始文本直到 </style>
      const closeIdx = html.toLowerCase().indexOf("</style", p);
      if (closeIdx === -1) return unsafe("style_unterminated");
      const css = html.slice(p, closeIdx);
      if (css.includes("<")) return unsafe("style_contains_lt");
      styleBytes += Buffer.byteLength(css, "utf8");
      if (styleBytes > RENDER_LIMITS.maxStyleBytes) return unsafe("style_bytes_exceed_limit");
      const cssCheck = validateCssText(css, referenced);
      if (cssCheck) return cssCheck;
      tagCount += 1; // </style>
      if (tagCount > RENDER_LIMITS.maxTagCount) return unsafe("tag_count_exceeds_limit");
      const gt = html.indexOf(">", closeIdx);
      if (gt === -1) return unsafe("style_unterminated");
      // style 自包含：连开标签带内容一直消费到 </style>，不进出标签栈。
      i = gt + 1;
      continue;
    }

    if (VOID_TAGS.has(tag)) {
      if (selfClosing) {
        i = p;
        continue;
      }
      i = p;
      continue;
    }
    if (selfClosing && !VOID_TAGS.has(tag)) return unsafe("non_void_self_closing");

    // 隐式闭合（如连续 <li>/<p>/<td>）
    const closers = AUTOCLOSE_TOP[tag];
    if (closers) {
      while (stack.length > 0 && closers.has(stack[stack.length - 1]!)) stack.pop();
    }
    stack.push(tag);
    if (stack.length > maxDepth) maxDepth = stack.length;
    if (maxDepth > RENDER_LIMITS.maxNestingDepth) return unsafe("nesting_depth_exceeds_limit");
    i = p;
  }

  return {
    ok: true,
    referencedResourceKeys: [...referenced],
    stats: { tagCount, maxDepth, textChars, styleBytes },
  };
}

function checkAttributes(tag: string, attrs: Map<string, string>, referenced: Set<string>): SanitizeFail | undefined {
  for (const [name, value] of attrs) {
    const allowed = GLOBAL_ATTRS.has(name) || (TAG_ATTRS[tag]?.has(name) === true);
    if (!allowed) return unsafe("attr_not_allowed");
    if (name === "lang") {
      if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})?$/.test(value)) return unsafe("lang_value_invalid");
      continue;
    }
    if (tag === "meta" && name === "charset") {
      if (value.toLowerCase() !== "utf-8") return unsafe("meta_charset_invalid");
      continue;
    }
    if (tag === "img" && name === "src") {
      const m = ASSET_REF_PATTERN.exec(value);
      if (!m) return unsafe("img_src_not_asset_ref");
      referenced.add(m[1]!);
      continue;
    }
    if ((tag === "img" && (name === "width" || name === "height")) || ((tag === "td" || tag === "th") && (name === "colspan" || name === "rowspan")) || (tag === "ol" && name === "start")) {
      if (!INT_ATTR_PATTERN.test(value)) return unsafe("numeric_attr_invalid");
      continue;
    }
    if (name === "style") {
      if (value.includes("<")) return unsafe("style_contains_lt");
      const cssCheck = validateCssText(value, referenced);
      if (cssCheck) return cssCheck;
      continue;
    }
    // class/id/alt：任意非 '<' 文本（已保证），长度守卫防滥用
    if (value.length > 4096) return unsafe("attr_value_too_long");
  }
  return undefined;
}

/**
 * CSS 文本校验（<style> 内容与 style 属性共用）。
 * 规则见文件头。返回 undefined = 通过。
 */
export function validateCssText(css: string, referenced: Set<string>): SanitizeFail | undefined {
  if (css.includes("\\")) return unsafe("css_escape_forbidden");
  if (css.includes("/*")) return unsafe("css_comment_forbidden");
  const lower = css.toLowerCase();
  for (const banned of ["expression(", "javascript:", "vbscript:", "behavior:", "-moz-binding", "image-set(", "url(#"]) {
    if (lower.includes(banned)) return unsafe("css_forbidden_construct");
  }
  // at-rule 白名单：@media / @supports
  const atRuleMatches = lower.match(/@[a-zA-Z-]+/g) ?? [];
  for (const at of atRuleMatches) {
    if (at !== "@media" && at !== "@supports") return unsafe("css_at_rule_forbidden");
  }
  // url() 闭集：只允许 url(asset:key)
  let searchFrom = 0;
  for (;;) {
    const idx = lower.indexOf("url(", searchFrom);
    if (idx === -1) break;
    // 找到这个 url( 的右括号（不允许嵌套括号）
    let depth = 1;
    let j = idx + 4;
    while (j < css.length && depth > 0) {
      const c = css[j];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      j += 1;
    }
    if (depth !== 0) return unsafe("css_url_unbalanced");
    const expr = css.slice(idx, j);
    const m = CSS_URL_ASSET_PATTERN.exec(expr);
    if (!m) return unsafe("css_url_not_asset_ref");
    referenced.add(m[1]!);
    searchFrom = j;
  }
  return undefined;
}

function unsafe(reason: string): SanitizeFail {
  return { ok: false, code: "render_html_unsafe", reason };
}

function isAsciiLetter(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

function isAsciiAlnum(c: string): boolean {
  return isAsciiLetter(c) || (c >= "0" && c <= "9");
}

function isAttrNameChar(c: string): boolean {
  return isAsciiAlnum(c) || c === "-" || c === "_";
}

function isHtmlSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}
