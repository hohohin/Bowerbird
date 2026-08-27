/**
 * HTML/CSS sanitizer 单测 —— H1-T2 / §5.2。
 * 覆盖：合法文档、禁止标签/属性/scheme/at-rule、资源闭集、结构上限、隐式闭合与
 * stray close、注释/CDATA/DOCTYPE 边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml } from "./sanitizer.ts";

function ok(html: string): { referencedResourceKeys: string[]; stats: { tagCount: number } } {
  const result = sanitizeHtml(html);
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  return result as { referencedResourceKeys: string[]; stats: { tagCount: number } };
}

function rejected(html: string, reason: string): void {
  const result = sanitizeHtml(html);
  assert.ok(!result.ok, `expected rejection, got ok`);
  assert.equal((result as { reason: string }).reason, reason);
}

test("accepts a normal zh layout document with style + img + table", () => {
  const html = [
    "<!DOCTYPE html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>海报</title>',
    "<style>body{font-family:'Noto Sans CJK SC',sans-serif;padding:24px}.hero{display:flex;gap:12px}</style>",
    "</head><body>",
    '<h1 class="hero-title">中文标题</h1>',
    '<img src="asset:ref-1" alt="主视觉" width="120" height="80">',
    "<table><tr><td colspan=\"2\">单元格</td></tr></table>",
    '<div style="background-image:url(asset:ref-2)">图文</div>',
    "</body></html>",
  ].join("");
  const result = ok(html);
  assert.deepEqual(result.referencedResourceKeys.sort(), ["ref-1", "ref-2"]);
});

test("forbidden tags", () => {
  rejected("<script>alert(1)</script>", "tag_not_allowed");
  rejected('<iframe src="https://evil.example"></iframe>', "tag_not_allowed");
  rejected('<object data="x"></object>', "tag_not_allowed");
  rejected('<embed src="x">', "tag_not_allowed");
  rejected('<base href="https://evil.example">', "tag_not_allowed");
  rejected('<form action="/x"><input type="text"></form>', "tag_not_allowed");
  rejected('<svg><circle r="1"></circle></svg>', "tag_not_allowed");
  rejected('<a href="https://x">link</a>', "tag_not_allowed");
  rejected("<video></video>", "tag_not_allowed");
  rejected("<portal></portal>", "tag_not_allowed");
  rejected("<applet></applet>", "tag_not_allowed");
  rejected("<frame></frame>", "tag_not_allowed");
  rejected("<link rel=stylesheet href=x>", "tag_not_allowed");
});

test("event handler and unknown attributes rejected", () => {
  rejected('<img src="asset:r" onerror="alert(1)">', "attr_not_allowed");
  rejected('<div loading="lazy">x</div>', "attr_not_allowed");
  rejected('<img src="asset:r" srcset="a 1x">', "attr_not_allowed");
  rejected('<img src="asset:r" decoding="async">', "attr_not_allowed");
  rejected('<div data-x="1">x</div>', "attr_not_allowed");
  rejected('<img src="asset:r" src="asset:r2">', "attr_duplicate");
});

test("img src must be asset: placeholder (no url/file/data/relative)", () => {
  rejected('<img src="https://evil.example/a.png">', "img_src_not_asset_ref");
  rejected('<img src="/etc/passwd">', "img_src_not_asset_ref");
  rejected('<img src="file:///etc/passwd">', "img_src_not_asset_ref");
  rejected('<img src="data:image/png;base64,AAAA">', "img_src_not_asset_ref");
  rejected('<img src="javascript:alert(1)">', "img_src_not_asset_ref");
  rejected('<img src="asset:bad key">', "img_src_not_asset_ref");
  rejected('<img src="asset:' + 'x'.repeat(65) + '">', "img_src_not_asset_ref");
  rejected('<img src="">', "img_src_not_asset_ref");
});

test("css: url() closed to asset: refs; dangerous constructs rejected", () => {
  rejected('<style>@import url("https://evil.example/x.css");</style>', "css_at_rule_forbidden");
  rejected("<style>@font-face{font-family:x}</style>", "css_at_rule_forbidden");
  rejected("<style>@keyframes a{from{opacity:0}}</style>", "css_at_rule_forbidden");
  rejected('<style>body{background:url(https://evil.example/bg.png)}</style>', "css_url_not_asset_ref");
  rejected('<style>body{background:url("/static/bg.png")}</style>', "css_url_not_asset_ref");
  rejected('<style>body{background:url(file:///etc/passwd)}</style>', "css_url_not_asset_ref");
  rejected('<style>body{background:url(data:image/png;base64,AAAA)}</style>', "css_url_not_asset_ref");
  rejected('<style>body{background:url(#paint)}</style>', "css_forbidden_construct");
  rejected("<style>a{width:expression(alert(1))}</style>", "css_forbidden_construct");
  rejected("<style>a{behavior:url(x)}</style>", "css_forbidden_construct");
  rejected("<style>a{background:\\75rl(x)}</style>", "css_escape_forbidden");
  rejected("<style>/* comment */a{color:red}</style>", "css_comment_forbidden");
  rejected('<div style="background:url(https://x/y.png)">z</div>', "css_url_not_asset_ref");
  const good = ok('<style>@media (max-width:600px){body{color:red;background:url(asset:bg-1)}}</style>');
  assert.deepEqual(good.referencedResourceKeys, ["bg-1"]);
});

test("comments / cdata / pi / doctype variants rejected", () => {
  rejected("<!-- note -->", "comment_or_declaration_forbidden");
  rejected("<![CDATA[x]]>", "comment_or_declaration_forbidden");
  rejected("<?php echo 1; ?>", "processing_instruction_forbidden");
  rejected('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">', "doctype_not_html");
});

test("meta only allows charset utf-8", () => {
  rejected('<meta http-equiv="refresh" content="0;url=https://evil.example">', "attr_not_allowed");
  rejected('<meta name="viewport" content="width=device-width">', "attr_not_allowed");
  rejected('<meta charset="gbk">', "meta_charset_invalid");
  ok('<meta charset="UTF-8">');
});

test("implicit close keeps sibling lists and paragraphs within depth limits", () => {
  const items = "<ul>" + "<li>项目</li>".repeat(500) + "</ul>";
  ok(items);
  const paragraphs = "<p>段落</p>".repeat(300);
  ok(paragraphs);
  const tds = "<table><tr>" + "<td>单元格</td>".repeat(100) + "</tr></table>";
  ok(tds);
});

test("stray close tags rejected; non-void self-closing rejected; img requires src", () => {
  rejected("</div>", "stray_close_tag");
  rejected("<div>x</span></div>", "stray_close_tag");
  rejected("<div/>x", "non_void_self_closing");
  rejected("<img/>ok", "img_src_missing");
  ok('<img src="asset:r"/>');
  ok("<br/>");
  ok("<hr>");
});

test("structural limits", () => {
  rejected("<div>".repeat(65) + "深" + "</div>".repeat(65), "nesting_depth_exceeds_limit");
  const many = "<div>x</div>".repeat(20_001);
  rejected(many, "tag_count_exceeds_limit");
  const longText = "字".repeat(1024 * 1024 + 2);
  rejected(`<p>${longText}</p>`, "text_length_exceeds_limit");
  const bigStyle = `<style>a{color:${"r".repeat(512 * 1024)}}</style>`;
  rejected(bigStyle, "style_bytes_exceed_limit");
});

test("lowercase/uppercase tags and attrs are normalized", () => {
  const result = ok('<DIV CLASS="x"><IMG SRC="asset:R1"></DIV>');
  assert.deepEqual(result.referencedResourceKeys, ["R1"]);
});

test("text '<' not starting a tag stays text", () => {
  ok("<p>a &lt; b 与 1<2</p>");
  ok("<p>x < y</p>");
});
