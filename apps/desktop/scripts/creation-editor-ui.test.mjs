import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// macOS WKWebView 方向键 keypress 会携带旧 Mac 功能键私用区 charCode（右方向键
// U+F703），WebKit 在光标无法右移时把它当文本插入 contentEditable 显示为方框乱码。
// Chromium 无法原生复现，用合成 keypress 验证拦截插件：私用区字符被 preventDefault、
// 普通输入不受影响、handleTextInput 兜底过滤同类字符。
const server = await createServer({ server: { host: "127.0.0.1", port: 1597, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1597/scripts/fixtures/creation-editor/preview.html");
  const editor = page.locator(".ProseMirror");
  await editor.waitFor();
  await editor.click();
  await page.keyboard.press("End");

  // 普通输入（真实 keydown/keypress 链路）不受插件影响。
  await page.keyboard.type("abc");
  assert.equal(await editor.innerText(), "你好abc");

  // 模拟 WKWebView 方向键 keypress（私用区 charCode）：默认插字行为必须被拦截。
  for (const charCode of [0xf701, 0xf702, 0xf703, 0xf729]) {
    assert.equal(
      await editor.evaluate((el, code) => {
        const ev = new KeyboardEvent("keypress", { charCode: code, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      }, charCode),
      true,
      `keypress charCode U+${charCode.toString(16)} must be default-prevented`,
    );
  }
  assert.equal(await editor.innerText(), "你好abc", "arrow-function keypresses must not insert anything");

  // 普通字符 keypress 不被拦截（交给编辑器正常输入）。
  assert.equal(
    await editor.evaluate(() => {
      const ev = new KeyboardEvent("keypress", { charCode: 97, bubbles: true, cancelable: true });
      document.querySelector(".ProseMirror").dispatchEvent(ev);
      return ev.defaultPrevented;
    }),
    false,
  );

  // handleTextInput 兜底：含私用区字符的文本被清洗后落库，纯私用区输入整段吞掉。
  const filtered = await page.evaluate(async () => {
    const { buildPlugins } = await import("/src/components/creation/plugins.ts");
    const plugins = buildPlugins({
      viewRef: { current: window.view },
      assetByIdRef: { current: new Map() },
      chipSectionsRef: { current: [] },
      chipAssetIdRef: { current: null },
    });
    const props = plugins.find((p) => p.props?.handleTextInput)?.props;
    const view = window.view;
    const end = view.state.doc.content.size - 1;
    const mixed = props.handleTextInput(view, end, end, "x\uF703y");
    const onlyPua = props.handleTextInput(view, end + 2, end + 2, "\uF702\uF703");
    const clean = props.handleTextInput(view, end, end, "zz");
    return { mixed, onlyPua, clean, text: view.state.doc.textContent };
  });
  assert.equal(filtered.mixed, true);
  assert.equal(filtered.onlyPua, true);
  assert.equal(filtered.clean, false);
  assert.equal(filtered.text, "你好abcxy", "PUA chars stripped; clean-text return-false leaves insertion to the caller");

  assert.deepEqual(errors, []);
  console.log("PASS: WKWebView arrow-function keypress chars swallowed, normal typing unaffected");
} finally {
  await browser.close();
  await server.close();
}
