// Place through the user-facing two-click tool, keeping existing cards accessible.
export async function placeWorkflowCard(page, name) {
  const count = await page.locator(".workflow-card").count();
  const point = await page.locator('[data-canvas-stage]').evaluate(stage => {
    const bounds = stage.getBoundingClientRect();
    const scale = new DOMMatrix(getComputedStyle(stage.querySelector('.canvas-plane')).transform).a;
    const cards = [...stage.querySelectorAll('[data-workflow-card],[data-canvas-node]')].map(el => el.getBoundingClientRect());
    const width = 340 * scale, height = 370 * scale;
    for (let y = bounds.top + 80; y < bounds.bottom - height - 12; y += 40) {
      for (let x = bounds.left + 80; x < bounds.right - width - 12; x += 40) {
        if (cards.every(rect => x + width + 12 <= rect.left || x >= rect.right + 12 || y + height + 12 <= rect.top || y >= rect.bottom + 12)) return { x, y };
      }
    }
    throw new Error('No free card position in the test viewport; choose an explicit placement.');
  });
  await page.getByRole('button', { name, exact: true }).click();
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(count => document.querySelectorAll(".workflow-card").length > count, count);
}
