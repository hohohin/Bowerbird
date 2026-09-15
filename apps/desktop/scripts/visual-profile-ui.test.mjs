import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const requireRenderer = createRequire(new URL("../../html-renderer/package.json", import.meta.url));
const { chromium } = process.env.BOWERBIRD_PLAYWRIGHT_MODULE ? await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE) : requireRenderer("playwright");
const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { host: "127.0.0.1", port: 1443, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(8000);
await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const errors = []; page.on("pageerror", e => errors.push(e.message));
const url = "http://127.0.0.1:1443/scripts/fixtures/visual-profile/preview.html";
const dialog = page.getByRole("dialog");
const button = name => dialog.getByRole("button", { name, exact: true });
const calls = command => page.evaluate(command => window.calls.filter(c => c.command === command).length, command);
const release = () => page.evaluate(() => { window.hold = null; window.pending.splice(0).forEach(resolve => resolve()); });
async function reset(suffix = "") { await page.goto(url + suffix); await page.waitForFunction(() => document.querySelector("fieldset") && !document.querySelector("fieldset").disabled); }
async function result() { await button("开始提炼").click(); await button("保存规范").waitFor(); }
async function screenshot(name) { await page.waitForTimeout(200); await page.screenshot({ path: `.tmp/brand-visual-${name}.png` }); }
try {
  await mkdir(".tmp", { recursive: true });
  await reset(); await screenshot("collection-start-dark");
  await page.evaluate(() => document.documentElement.dataset.theme = "light"); await screenshot("collection-start-light");
  assert.equal(await page.locator(".bv-image-grid img:visible").count(), 8);
  assert.equal(await page.locator("input[type=file]").count(), 0);
  assert.equal(await calls("visual_profile_cloud_extract"), 0);
  assert.equal(await page.getByText("查看集合素材", { exact: true }).count(), 0);
  assert.doesNotMatch(await dialog.innerText(), /有效反推|本地基线|支持率|覆盖率|必须：|规则强度/);
  // One button handles the real serial queue, then the original paid extraction.
  await button("开始提炼").evaluate(node => { node.click(); node.click(); });
  await button("保存规范").waitFor();
  assert.equal(await calls("codex_describe_asset"), 2); assert.equal(await calls("visual_profile_cloud_extract"), 1);
  assert.equal(await page.locator("textarea:visible").count(), 0);
  assert.equal(await page.locator(".bv-style-card:visible").count(), 0);
  await screenshot("result-light");
  await page.evaluate(() => document.documentElement.dataset.theme = "dark"); await screenshot("result-dark");
  await button("保存规范").click(); await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeVisualProfileId), null);
  const savedPicker = page.getByRole("combobox", { name: "品牌视觉规范" });
  assert.equal(await savedPicker.inputValue(), "");
  await savedPicker.selectOption("new-0");
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeVisualProfileId), "new-0");
  assert.equal(await calls("visual_profile_confirm"), 1);
  // Creation only chooses saved guides; adding materials stays in the collection.
  assert.equal(await savedPicker.locator('option[value="brand:new"]').count(), 0);
  assert.equal(await calls("create_folder"), 0);
  await reset(); await page.evaluate(() => { window.assets = []; window.missing = []; window.fixtureStore.getState().closeVisualProfile(); });
  await page.evaluate(() => window.fixtureStore.getState().openVisualProfile({ id: "f", name: "空集合" }));
  await page.getByText("这个集合还没有可提炼的图片，请先回到集合添加素材。").waitFor();
  assert.equal(await button("开始提炼").isDisabled(), true);
  assert.equal(await page.locator("input[type=file]").count(), 0);
  // A collection with one image follows the same extraction pipeline.
  await reset(); await page.evaluate(() => { window.assets = window.assets.slice(0, 1); window.missing = ["a0"]; window.fixtureStore.getState().closeVisualProfile(); });
  await page.evaluate(() => window.fixtureStore.getState().openVisualProfile({ id: "f", name: "单图集合" }));
  await result(); assert.equal(await calls("codex_describe_asset"), 1);
  assert.match(await dialog.innerText(), /初步风格/);
  // Opening a collection with history still starts at confirmation. Saving never replaces the chosen guide.
  await reset("?history"); await button("完成").click();
  await page.evaluate(() => { window.fixtureStore.getState().setActiveVisualProfile("confirmed"); window.fixtureStore.getState().openVisualProfile({ id: "f", name: "自然生活品牌" }); });
  await button("开始提炼").waitFor();
  assert.equal(await calls("visual_profile_cloud_extract"), 0);
  await result(); await button("保存规范").click(); await dialog.waitFor({ state: "detached" });
  assert.equal(await savedPicker.inputValue(), "confirmed");
  assert.equal(await savedPicker.locator('option[value="new-2"]').count(), 1);
  // A failed analysis cannot proceed to charged summary. Retry only analyzes missing images.
  await reset(); await page.evaluate(() => window.fail = "codex_describe_asset");
  await button("开始提炼").click(); await dialog.getByRole("alert").waitFor();
  assert.equal(await calls("visual_profile_cloud_extract"), 0);
  await page.evaluate(() => window.fail = null); await result();
  assert.equal(await calls("visual_profile_cloud_extract"), 1);
  // Stop during an in-flight image keeps the queue safe and prevents the next stage.
  await reset(); await page.evaluate(() => window.hold = "codex_describe_asset");
  await button("开始提炼").click(); await button("停止提炼").click(); await release();
  await page.waitForFunction(() => !window.fixtureStore.getState().describingId);
  assert.equal(await calls("visual_profile_cloud_extract"), 0); assert.equal(await calls("codex_describe_asset"), 1);
  await result(); assert.equal(await calls("codex_describe_asset"), 2);
  // Editing is optional; empty content, failure, leave guard and same-frame duplicate saves remain safe.
  await button("微调描述").click(); const text = page.getByRole("textbox", { name: "风格描述 1", exact: true });
  await text.fill("  "); assert.equal(await button("保存规范").isDisabled(), true);
  await text.fill("柔和自然的品牌构图"); await page.keyboard.press("Escape"); await button("继续修改").click();
  assert.equal(await text.inputValue(), "柔和自然的品牌构图");
  await page.evaluate(() => window.fail = "visual_profile_update_draft"); await button("保存规范").click(); await dialog.getByRole("alert").waitFor();
  assert.equal(await text.inputValue(), "柔和自然的品牌构图"); assert.equal(await calls("visual_profile_confirm"), 0);
  await page.evaluate(() => { window.fail = null; window.hold = "visual_profile_update_draft"; });
  await button("保存规范").evaluate(node => { node.click(); node.click(); });
  assert.equal(await calls("visual_profile_update_draft"), 2); await release(); await dialog.waitFor({ state: "detached" });
  // Existing confirmed profiles open as a readable guide, without mutable fields or re-confirmation.
  await reset("?history"); assert.equal(await button("微调描述").count(), 0); await button("完成").click();
  await dialog.waitFor({ state: "detached" }); assert.equal(await calls("visual_profile_confirm"), 0);
  // Returning from history keeps the collection open and exposes the saved versions.
  await reset("?history");
  await page.locator('.bv-saved-sources img').first().waitFor();
  assert.equal(await page.locator('.bv-saved-sources img').count(), 8);
  await screenshot("saved-sources");
  await button("返回").click(); await button("开始提炼").waitFor();
  assert.equal(await page.locator('details[open] > summary').filter({ hasText: '已有规范' }).count(), 1);
  await page.locator('.bv-history-item').filter({ hasText: 'v1' }).click(); await button("完成").waitFor();
  // Cancel is non-destructive; failure leaves the guide and selection intact; retry cannot double-delete.
  await page.evaluate(() => window.fixtureStore.getState().setActiveVisualProfile("confirmed"));
  await button("删除规范").click(); await button("取消删除").click();
  assert.equal(await calls("visual_profile_delete"), 0);
  await button("删除规范").click(); await page.evaluate(() => window.fail = "visual_profile_delete");
  await button("确认删除").click(); await page.locator('.bv-message.is-error').waitFor();
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeVisualProfileId), "confirmed");
  assert.equal(await page.locator('.bv-saved-sources img').count(), 8);
  await page.evaluate(() => { window.fail = null; window.hold = "visual_profile_delete"; });
  await button("确认删除").evaluate(node => { node.click(); node.click(); });
  await page.waitForFunction(() => window.pending.length > 0);
  assert.equal(await calls("visual_profile_delete"), 2);
  await release(); await button("开始提炼").waitFor();
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeVisualProfileId), null);
  assert.equal(await page.locator('.bv-history-item').filter({ hasText: 'v1' }).count(), 0);
  assert.equal(await savedPicker.locator('option[value="confirmed"]').count(), 0);
  assert.equal(await page.evaluate(() => window.assets.length), 8);
  // Deleting another version from the list keeps the selected guide.
  await reset("?history"); await page.evaluate(() => window.fixtureStore.getState().setActiveVisualProfile("confirmed"));
  await button("返回").click(); await button("删除规范 v2").click(); await screenshot("delete-version");
  await button("确认删除").click(); await button("开始提炼").waitFor();
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeVisualProfileId), "confirmed");
  assert.equal(await page.locator('.bv-history-item').count(), 1);
  // Historical images come from the snapshot, including a placeholder for a removed asset.
  await reset("?history"); await button("返回").click();
  await page.evaluate(() => { window.profiles[0].sourceAssetIds = ["a0", "removed"]; window.profiles[0].sourceCount = 2; });
  await page.locator('.bv-history-item').filter({ hasText: 'v1' }).click();
  await page.getByText("素材 2 已移除", { exact: true }).waitFor();
  assert.equal(await page.locator('.bv-saved-sources img').count(), 1);
  assert.equal(await page.locator('.bv-saved-sources img').getAttribute('alt'), "品牌作品 1");
  await button("返回").click(); await page.evaluate(() => window.fail = "get_assets_by_ids");
  await page.locator('.bv-history-item').filter({ hasText: 'v1' }).click();
  await button("重新读取来源素材").waitFor();
  assert.equal(await button("完成").isEnabled(), true);
  await page.evaluate(() => window.fail = null); await button("重新读取来源素材").click();
  await page.getByText("素材 2 已移除", { exact: true }).waitFor();
  await button("完成").click();
  // A saved guide is available without a project and from another project's creation.
  await page.evaluate(async () => {
    window.fixtureStore.setState({ activeProjectId: null, projects: [] });
    await window.fixtureStore.getState().reloadVisualProfiles();
  });
  const picker = page.getByRole("combobox", { name: "品牌视觉规范" });
  assert.equal(await picker.isEnabled(), true);
  await picker.selectOption("confirmed");
  await page.evaluate(async () => {
    window.fixtureStore.setState({ activeProjectId: "different-project" });
    await window.fixtureStore.getState().reloadVisualProfiles();
  });
  assert.equal(await picker.inputValue(), "confirmed");
  await page.evaluate(async () => { await window.fixtureStore.getState().exitProject(); });
  assert.equal(await picker.inputValue(), "confirmed");
  await page.evaluate(async () => { await window.fixtureStore.getState().beginProvisionalProject(); });
  assert.equal(await picker.inputValue(), "confirmed");
  // The selected historical version opens exactly, even when its source folder is gone.
  await page.evaluate(() => { window.fail = "visual_profile_preview"; });
  await page.getByRole("button", { name: "管理当前品牌规范" }).click();
  await button("完成").waitFor();
  assert.equal(await dialog.getByRole("alert").count(), 0);
  await button("完成").click(); await dialog.waitFor({ state: "detached" });
  await reset(); await page.evaluate(() => window.fixtureStore.setState({ activeProjectId: null, projects: [] }));
  await result(); await button("保存规范").click(); await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.fixtureStore.getState().activeProjectId), null);
  assert.ok(await page.evaluate(() => window.calls.filter(c => /^visual_profile_(preview|list|get|cloud_extract)$/.test(c.command)).every(c => !("projectId" in c.args))));
  // Images added from elsewhere during analysis invalidate the frozen selection before summary.
  await reset(); await page.evaluate(() => window.hold = "codex_describe_asset"); await button("开始提炼").click();
  await page.evaluate(() => window.assets.push({ id: "unapproved-image", name: "未选择图片" })); await release();
  await dialog.getByRole("alert").waitFor(); assert.equal(await calls("visual_profile_cloud_extract"), 0);
  // Account changes cannot cause the following images/summary to be charged to a different user.
  await reset(); await page.evaluate(() => window.hold = "codex_describe_asset"); await button("开始提炼").click();
  await page.evaluate(() => window.fixtureStore.setState({ cloudAuth: { logged_in: true, cloud_available: true, user_id: "other-account" } }));
  await release(); await dialog.getByRole("alert").waitFor();
  assert.equal(await calls("visual_profile_cloud_extract"), 0); assert.equal(await calls("codex_describe_asset"), 1);
  // Mixed directions are a meaningful choice, and the selected branch produces usable saved rules.
  await reset(); await page.evaluate(() => {
    const profile = window.makeProfile();
    profile.rules = [
      { ...profile.rules[1], value: "低饱和暖色", supportingAssetIds: ["a0", "a1"] },
      { ...profile.rules[1], value: "高对比冷色", supportingAssetIds: ["a2", "a3"] },
      { ...profile.rules[1], value: "原图明确标注：主色 HEX：#1a2B3c", polarity: "must", supportingAssetIds: ["a4"] },
    ];
    profile.conflicts = [{ description: "不同色彩", sideA: { assetIds: ["a0"] }, sideB: { assetIds: ["a2"] } }];
    profile.candidateDirections = [{ label: "自然暖色", supportingAssetIds: ["a0", "a1"] }, { label: "冷色对比", supportingAssetIds: ["a2", "a3"] }];
    window.profiles = [profile]; window.fixtureStore.getState().closeVisualProfile();
  });
  await page.evaluate(() => window.fixtureStore.getState().openVisualProfile({ id: "f", name: "多方向品牌", profileId: "draft" }));
  await button("保存规范").waitFor(); assert.equal(await button("保存规范").isDisabled(), true);
  await button("自然暖色").click(); await button("保存规范").click(); await dialog.waitFor({ state: "detached" });
  const kept = await page.evaluate(() => window.calls.find(c => c.command === "visual_profile_update_draft").args.rules);
  assert.equal(kept.length, 2); assert.equal(kept[0].value, "低饱和暖色");
  assert.equal(kept[1].value, "原图明确标注：主色 HEX：#1a2B3c");
  // Conflicting labels require explicit review; the user confirms with a button.
  await reset(); await result(); await button("微调描述").click();
  await page.getByRole("textbox", { name: "风格描述 1", exact: true }).fill("待核对的原图标注：主色 HEX：#112233");
  assert.equal(await button("保存规范").isDisabled(), true);
  await button("已核对，保留").click();
  assert.equal(await button("保存规范").isEnabled(), true);
  await button("保存规范").click(); await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.calls.find(c => c.command === "visual_profile_update_draft").args.rules[0].value), "原图明确标注：主色 HEX：#112233");
  // Stale in-flight image results cannot contaminate a new project's dialog.
  await reset(); await result(); await page.locator(".bv-try > summary").click();
  await page.evaluate(() => window.hold = "visual_profile_generate_validation"); await button("试画一张 · 1 积分").click();
  await page.evaluate(() => window.fixtureStore.setState({ activeProjectId: "other", visualProfileFolder: { id: "other", name: "其他品牌" } }));
  await release(); await page.waitForFunction(() => window.calls.some(c => c.command === "visual_profile_discard_validation"));
  assert.equal(await page.getByAltText("品牌风格试画").count(), 0);
  await reset(); await result(); await page.setViewportSize({ width: 540, height: 860 }); await screenshot("result-narrow");
  assert.equal(await page.locator(".app-modal-body").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.deepEqual(errors, []);
  console.log("PASS: collection start, collapsed details, empty/single-image source, explicit creation selection after save, preserved prior choice, analysis queue, duplicate guard, failure/retry/stop, scope freeze, optional editing, historical guide, stale image cleanup, dark/light/narrow layouts.");
} finally { await browser.close(); await server.close(); }
