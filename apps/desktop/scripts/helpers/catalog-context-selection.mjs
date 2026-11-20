import assert from 'node:assert/strict';

/** Exercise the same context-menu selection contract in both catalog views. */
export async function checkContextRangeSelection(page, card, cancel) {
  const selectFromMenu = async index => {
    await card(index).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '选择', exact: true }).click();
  };
  await card(0).click({ button: 'right' });
  assert.equal(await card(0).getAttribute('aria-pressed'), 'false', 'opening the menu must not select its target');
  await page.getByRole('menuitem', { name: '选择', exact: true }).click();
  await card(9).click({ modifiers: ['Shift'] });
  await page.waitForFunction(el => el.getAttribute('aria-pressed') === 'true', await card(9).elementHandle());
  for (let index = 0; index <= 10; index++) {
    assert.equal(await card(index).getAttribute('aria-pressed'), String(index < 10), 'the first Shift after menu selection must select exactly items 1–10');
  }
  await cancel.click();

  await card(0).click({ modifiers: ['Control'] });
  await selectFromMenu(5);
  await card(9).click({ modifiers: ['Shift'] });
  await page.waitForFunction(el => el.getAttribute('aria-pressed') === 'true', await card(9).elementHandle());
  assert.equal(await card(4).getAttribute('aria-pressed'), 'false', 'explicit menu selection must replace an older range anchor');
  assert.equal(await card(6).getAttribute('aria-pressed'), 'true');
  await card(2).click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await card(11).click({ modifiers: ['Shift'] });
  await page.waitForFunction(el => el.getAttribute('aria-pressed') === 'true', await card(11).elementHandle());
  assert.equal(await card(3).getAttribute('aria-pressed'), 'false', 'dismissing a menu must preserve the previous range anchor');
  assert.equal(await card(10).getAttribute('aria-pressed'), 'true');
  await cancel.click();
}

export async function checkContextLookup(page, card, cancel, { idsCommand, lookupCommand, firstId, secondId, coldId }) {
  await card(0).click({ modifiers: ['Control'] });
  await card(1).click({ modifiers: ['Control'] });
  await cancel.waitFor();
  const openContext = index => card(index).evaluate(element => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 96, clientY: 96 }));
    return window.store.getState().contextMenu?.fileSelection?.assets.map(asset => asset.id);
  });
  assert.deepEqual(await openContext(0), [firstId, secondId], 'loaded selection opens synchronously');
  await page.keyboard.press('Escape');
  await cancel.click();

  await page.evaluate(({ idsCommand, lookupCommand, firstId, secondId, coldId }) => {
    const bridge = window.__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    window.restoreMenuLookup = () => { bridge.invoke = invoke; };
    bridge.invoke = async (command, args) => {
      if (command === idsCommand) return [firstId, secondId, coldId];
      const ids = args.ids ?? args.assetIds;
      if (command === lookupCommand && ids.includes(coldId) && ids.length === 1) {
        window.coldMenuIds = [...ids];
        await new Promise(resolve => { window.releaseMenuLookup = () => { window.releaseMenuLookup = null; resolve(); }; });
        const rows = await invoke(command, args);
        window.menuLookupFinished = true;
        return rows;
      }
      return invoke(command, args);
    };
  }, { idsCommand, lookupCommand, firstId, secondId, coldId });
  try {
    await card(0).click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: '全选', exact: true }).click();
    await page.getByText('3 项', { exact: true }).waitFor();
    await card(0).click({ button: 'right' });
    await page.waitForFunction(() => window.releaseMenuLookup);
    assert.deepEqual(await page.evaluate(() => window.coldMenuIds), [coldId], 'only the missing ID is resolved');
    await card(2).click({ button: 'right' });
    await page.getByRole('menu', { name: '素材操作', exact: true }).waitFor();
    const newest = await page.evaluate(() => window.store.getState().contextMenu.assetId);
    await page.evaluate(() => window.releaseMenuLookup());
    await page.waitForFunction(() => window.menuLookupFinished);
    assert.equal(await page.evaluate(() => window.store.getState().contextMenu.assetId), newest, 'late reply preserves newer menu');
    await page.keyboard.press('Escape');
    await cancel.click();
  } finally {
    await page.evaluate(() => window.restoreMenuLookup());
  }
}
