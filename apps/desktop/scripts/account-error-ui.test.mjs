import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host:'127.0.0.1', port:1562, strictPort:true, hmr:false, watch:null } });
await server.listen();
const browser = await chromium.launch({ channel:'chrome', headless:true });
const page = await browser.newPage({ viewport:{width:1100,height:900} });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const raw = 'cloud: 连接微信登录服务失败: error sending request for url (https://private.supabase.co/functions/v1/wechat-login?state=dt_secret&code=private_code)';
try {
  await page.goto('http://127.0.0.1:1562/scripts/fixtures/onboarding/preview.html');
  await page.waitForFunction(() => window.store && window.lesson);
  await page.evaluate(raw => {
    window.lesson.getState().show('closed');
    window.store.setState({activeProjectId:null,cloudAuth:{logged_in:false,cloud_available:true},cloudError:raw,accountOnboardingForceOpen:true});
  }, raw);
  const alert = page.getByRole('dialog', {name:'Bowerbird 账号',exact:true}).getByRole('alert');
  await alert.filter({hasText:'暂时无法连接登录服务，请稍后重试。'}).waitFor();
  assert.doesNotMatch(await alert.innerText(), /cloud:|https?:|supabase|dt_secret|private_code|error sending/i);
  await mkdir('.tmp/account-error', {recursive:true});
  await page.screenshot({path:'.tmp/account-error/account.png',animations:'disabled'});
  await page.getByRole('button', {name:'关闭',exact:true}).last().click();

  // Jump to the existing completion scene without running unrelated tutorial steps.
  await page.evaluate(async raw => {
    const { ONBOARDING_ROUTES } = await import('/src/lib/onboardingRoutes.ts');
    const lesson = window.lesson.getState();
    lesson.setGuide({...lesson.guide,role:'designer',status:'active',sessions:{designer:{
      projectId:'p',runId:'account-error-test',step:ONBOARDING_ROUTES.designer.findIndex(step=>step.scene==='ready-to-create'),
      stepStartedAt:Date.now(),ready:true,baselineText:'',collectionId:null,profileId:null,analysisAssetId:null,annotationAssetId:null,tasks:{}
    }}});
    window.store.setState({cloudError:null,startCloudWechatLogin:async()=>{throw raw;}});
    lesson.show('lesson');
  }, raw);
  const login = page.getByRole('button', {name:'使用微信扫码登录',exact:true});
  await login.click();
  await page.getByRole('alert').filter({hasText:'暂时无法连接登录服务，请稍后重试。'}).waitFor();
  assert.doesNotMatch(await page.locator('.onboarding-completion').innerText(), /supabase|dt_secret|private_code/);
  await page.evaluate(() => {
    window.store.setState({startCloudWechatLogin:async()=>'https://open.weixin.qq.com/connect/qrconnect?state=fixture'});
    window.failWechatBrowser=true;
  });
  await login.click();
  await page.getByRole('alert').filter({hasText:'暂时无法打开浏览器，请确认已设置默认浏览器后重试。'}).waitFor();
  await page.evaluate(() => {window.failWechatBrowser=false;});
  await login.click();
  await page.getByText('已打开二维码，请用微信扫码确认。', {exact:true}).waitFor();
  assert.equal(await page.locator('.onboarding-completion').getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS account and onboarding login errors hide raw URLs/parameters; browser retry succeeds.');
} finally {
  await browser.close();
  await server.close();
}
