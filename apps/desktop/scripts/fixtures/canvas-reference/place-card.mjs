const tools = {
  '分区': 'container', '合成画板': 'container',
  '内容卡片': 'content', '文本卡片': 'content', '气泡便签': 'content',
  '生成卡片': 'workflow', 'Agent 卡片': 'workflow', '指令卡片': 'workflow', '触发卡': 'workflow',
  '循环卡片': 'workflow', '视觉规范卡片': 'workflow', '技能卡片': 'workflow', '工作流助手': 'workflow',
  '视频复刻工具': 'toolbox', '抖音视频采集': 'toolbox', '本地 H3 视频': 'toolbox', '角色声音': 'toolbox', '视频转图文': 'toolbox',
};

const legacyNames = { '分区工具': '分区', '画板工具': '合成画板', '发条触发器': '触发卡' };
const canvasToolName = name => legacyNames[name] ?? name.replace(/^新增\s*/, '');

export async function canvasToolMenuItem(page, name) {
  const tool = canvasToolName(name);
  const group = tools[tool];
  if (!group) throw new Error(`画板工具栏没有此菜单项 ${tool}`);
  const trigger = page.locator(`[data-canvas-tool-group="${group}"]`);
  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    await trigger.focus();
    await page.keyboard.press('ArrowRight');
  }
  return page.locator(`[data-canvas-tool-menu="${group}"]`).getByRole('menuitem', { name: tool, exact: true });
}

export async function selectCanvasTool(page, name) {
  await (await canvasToolMenuItem(page, name)).click();
}

export async function enableCanvasToolbarPro(page) {
  await page.evaluate(() => {
    const store = window.store;
    const { cloudAuth, cloudEntitlement } = store.getState();
    if (cloudAuth?.logged_in && cloudAuth.user_id && cloudEntitlement?.user_id === cloudAuth.user_id
      && ['pro', 'studio'].includes(cloudEntitlement.tier) && ['fresh', 'grace'].includes(cloudEntitlement.offline_state)) return;
    const user = cloudAuth?.user_id || 'canvas-workflow-fixture';
    store.setState({ cloudAuth: { ...cloudAuth, logged_in: true, user_id: user, cloud_available: true },
      cloudEntitlement: { ...cloudEntitlement, user_id: user, tier: 'pro', offline_state: 'fresh',
        policy: { can_use_cloud: true, can_use_byo: true, ...cloudEntitlement?.policy },
        balances: cloudEntitlement?.balances ?? { daily: 50, sub: 0, topup: 0 } } });
  });
}

// Place through the user-facing toolbar and click the canvas, away from existing cards.
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
  const tool = canvasToolName(name);
  if (tools[tool] === 'workflow' && tool !== '生成卡片') await enableCanvasToolbarPro(page);
  await selectCanvasTool(page, tool);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(count => document.querySelectorAll(".workflow-card").length > count, count);
}
