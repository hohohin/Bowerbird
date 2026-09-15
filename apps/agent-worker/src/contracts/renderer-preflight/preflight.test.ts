import { equal, deepEqual } from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { sanitizeHtml } from "./sanitizer.ts";

// Mirrors ship in the standalone Worker image; renderer remains authoritative.
test("compose preflight uses exactly the renderer sanitizer and limits", () => {
  const root = existsSync("src/contracts/renderer-preflight") ? "../" : "apps/";
  for (const file of ["sanitizer.ts", "limits.ts"]) {
    const local = readFileSync(`${root}agent-worker/src/contracts/renderer-preflight/${file}`, "utf8");
    const renderer = readFileSync(`${root}html-renderer/src/${file}`, "utf8");
    const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/Buffer.byteLength\((\w+), "utf8"\)/g, "new TextEncoder().encode($1).byteLength");
    equal(normalize(local), normalize(renderer));
  }
});

test("failed portrait markup is correctable before committing HTML", () => {
  const html = '<html><head><style>.stage img{max-height:100vh;width:auto;object-fit:contain}</style></head><body><div class="stage"><img src="asset:reference-1" width="900" height="auto" alt="portrait"></div></body></html>';
  deepEqual(sanitizeHtml(html), { ok: false, code: "render_html_unsafe", reason: "numeric_attr_invalid" });
  equal(sanitizeHtml(html.replace('height="auto"', 'style="height:auto"')).ok, true);
});
