import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');

const server = await createServer({ server: { host: '127.0.0.1', port: 18574, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/canvas-reference/preview.html?detail-route');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  const result = await page.evaluate(async () => {
    const { useOnboarding, beginOnboardingOperation } = await import('/src/lib/onboardingStore.ts');
    const { ONBOARDING_KEY } = await import('/src/lib/onboarding.ts');
    const store = useOnboarding.getState();
    store.setGuide({ version: 2, role: 'designer', status: 'active', completedRoles: [], sessions: { designer: {
      projectId: '', runId: 'existing-run', step: 0, stepStartedAt: 1, ready: false, baselineText: '',
      collectionId: null, profileId: null, analysisAssetId: null, annotationAssetId: null, tasks: {},
    } } });
    const snapshot = () => ({ guide: localStorage.getItem('bowerbird.onboarding.roles.v2'),
      progress: localStorage.getItem(ONBOARDING_KEY), panel: useOnboarding.getState().panel });
    const before = snapshot();
    store.open(); store.show('welcome');
    beginOnboardingOperation('create-project', null)({ projectId: 'must-not-create-progress' });
    return { before, after: snapshot() };
  });
  assert.deepEqual(result.after, result.before, 'hidden entry and completed operations preserve existing guide and learning progress');
  assert.equal(await page.locator('.onboarding-lesson, .onboarding-resume, .learning-hint').count(), 0);
  await page.evaluate(() => window.store.setState({ cloudAuth: { logged_in: true, cloud_available: true, user_id: 'fixture-user' }, accountOnboardingForceOpen: true }));
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '系统设置', exact: true }).click();
  assert.equal(await settings.getByText('入门引导', { exact: true }).count(), 0);
  assert.equal(await settings.getByRole('button', { name: '打开入门引导', exact: true }).count(), 0);
  console.log('PASS hidden onboarding: actual App, settings entry, active reminders and existing progress preservation');
} finally { await browser.close(); await server.close(); }
