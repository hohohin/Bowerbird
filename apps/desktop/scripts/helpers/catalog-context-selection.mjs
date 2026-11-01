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
