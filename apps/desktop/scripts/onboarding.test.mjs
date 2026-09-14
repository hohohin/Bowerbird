import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshRoleGuide, parseRoleGuide, advanceRoleGuide, practiceReady, ONBOARDING_ROUTES } from '../src/lib/onboardingRoutes.ts';
const session = (step = 0) => ({ designerRevision: 2, projectId: 'p', runId: 'run', step, stepStartedAt: 100, ready: false,
  baselineText: '', collectionId: null, profileId: null, analysisAssetId: null, annotationAssetId: null, tasks: {} });
test('identity text and designer practice order match the requested workflow', () => {
  assert.deepEqual(ONBOARDING_ROUTES.designer.map(s => s.scene), ['create-project', 'folder', 'source-scope', 'open-explore', 'explore', 'expand-source', 'activate-composer', 'sample-dimensions']);
});
test('discarded demonstration completion never migrates to practice completion', () => {
  assert.deepEqual(parseRoleGuide({ role: 'designer', status: 'completed', steps: { designer: 5 }, completedRoles: ['designer','marketing','director'] }), freshRoleGuide());
});
test('unperformed operations cannot advance even with a next-step request', () => {
  const guide = { ...freshRoleGuide(), role: 'designer', status: 'active', sessions: { designer: session(1) } };
  assert.deepEqual(advanceRoleGuide(guide, ''), guide);
  const next = advanceRoleGuide({ ...guide, sessions: { designer: { ...session(1), ready: true } } }, 'draft', 200);
  assert.equal(next.sessions.designer.step, 2);
  assert.equal(next.sessions.designer.ready, false);
  assert.equal(next.sessions.designer.baselineText, 'draft');
});
test('real outcomes and project identity gate generation, batch and dimension practice', () => {
  const evidence = { onProject: true, text: '', imageCount: 0, videoCount: 0, hasDimensionOnly: false };
  for (const scene of ['edit', 'storyboard', 'video', 'batch', 'dimensions', 'import', 'folder', 'explore', 'annotate', 'analyse', 'profile'])
    assert.equal(practiceReady(scene, session(), evidence), false);
  assert.equal(practiceReady('batch', session(), {...evidence, imageCount: 1}), false);
  assert.equal(practiceReady('batch', session(), {...evidence, imageCount: 2}), true);
  assert.equal(practiceReady('video', session(), {...evidence, imageCount: 1}), false);
  assert.equal(practiceReady('video', session(), {...evidence, videoCount: 1}), true);
  assert.equal(practiceReady('dimensions', session(), {...evidence, hasDimensionOnly: true}), true);
  assert.equal(practiceReady('edit', session(), {...evidence, onProject: false, imageCount: 10}), false);
});
test('script requires new multiline text rather than accepting a pre-existing draft', () => {
  const evidence = { onProject: true, text: '镜头一：产品居中，镜头缓慢推进。\n镜头二：近景展示包装，柔和侧光。', imageCount: 0, videoCount: 0, hasDimensionOnly: false };
  assert.equal(practiceReady('script', session(), evidence), true);
  assert.equal(practiceReady('script', {...session(), baselineText: evidence.text}, evidence), false);
  assert.equal(practiceReady('script', session(), {...evidence, text: '一个镜头'}), false);
});
test('resume preserves each project and pending task while clearing active status', () => {
  const guide = { ...freshRoleGuide(), role: 'designer', status: 'active', sessions: { designer: {...session(5), tasks: { job: 1 }}, marketing: {...session(2), projectId:'m'} } };
  const restored = parseRoleGuide(guide);
  assert.equal(restored.status, 'paused');
  assert.deepEqual(restored.sessions, guide.sessions);
});
test('all routes must finish actual last steps before total completion; skip preserves progress', () => {
  let guide = freshRoleGuide();
  for (const role of ['designer', 'marketing', 'director']) {
    guide = advanceRoleGuide({ ...guide, role, status: 'active', sessions: { ...guide.sessions, [role]: {...session(ONBOARDING_ROUTES[role].length - 1), ready: true} } }, '');
  }
  assert.equal(guide.status, 'completed');
  assert.equal(parseRoleGuide(guide).completedRoles.length, 3);
  const paused = {...freshRoleGuide(), role:'designer', status:'skipped', sessions:{designer:session(3)}};
  assert.deepEqual(parseRoleGuide(paused), paused);
  assert.equal(parseRoleGuide({...guide, sessions:{}}).completedRoles.length, 0);
});

test('designer revision resets obsolete eight-step progress without losing other roles', () => {
  const old = {...session(1)}; delete old.designerRevision;
  const restored = parseRoleGuide({...freshRoleGuide(), sessions:{designer:old, marketing:session(2)}});
  assert.equal(restored.sessions.designer, undefined);
  assert.equal(restored.sessions.marketing.step, 2);
  const home = {...freshRoleGuide(), role:'designer', status:'paused', sessions:{designer:{...session(),projectId:''}}};
  assert.deepEqual(parseRoleGuide(home), home);
});

test('skipping records the skipped step without claiming an operation succeeded', () => {
  let guide={...freshRoleGuide(),role:'designer',status:'active',sessions:{designer:{...session(),projectId:''}}};
  guide=advanceRoleGuide(guide,'',200,true);
  assert.equal(guide.sessions.designer.step,1);
  assert.equal(guide.sessions.designer.ready,false);
  assert.deepEqual(guide.sessions.designer.skippedSteps,[0]);
  assert.deepEqual(parseRoleGuide(guide).sessions,guide.sessions);
  for(let i=1;i<ONBOARDING_ROUTES.designer.length;i++) guide=advanceRoleGuide(guide,'',200+i,true);
  assert.deepEqual(guide.completedRoles,['designer']);
  assert.equal(guide.sessions.designer.ready,false);
  assert.equal(parseRoleGuide(guide).completedRoles.length,1);
});
test('completed six-step designer sessions resume at the new composer lesson', () => {
  const restored=parseRoleGuide({...freshRoleGuide(),role:'designer',status:'completed',completedRoles:['designer'],sessions:{designer:{...session(5),ready:true}}});
  assert.equal(restored.sessions.designer.step,6);
  assert.equal(restored.sessions.designer.ready,false);
  assert.equal(restored.status,'paused');
  assert.deepEqual(restored.completedRoles,[]);
});
