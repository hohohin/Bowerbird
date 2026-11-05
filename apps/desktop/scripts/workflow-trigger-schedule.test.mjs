import assert from 'node:assert/strict';
import test from 'node:test';
import { nextDailyTrigger, advanceTriggerSchedule, triggerScheduleOccurrence, workflowTriggerMode, activeTriggerSchedule } from '../src/lib/workflowTriggerSchedule.ts';

test('four explicit trigger modes override dormant settings and preserve legacy inference', () => {
  const node = { kind: 'trigger', inputs: {} };
  const once = { id: 'once', at: 1900000000000, status: 'armed' };
  const daily = { ...once, dailyAt: '21:00' };
  assert.equal(workflowTriggerMode(node), 'manual');
  assert.equal(workflowTriggerMode({ ...node, inputs: { completion: [{}] } }), 'completion');
  assert.equal(workflowTriggerMode({ ...node, triggerSchedule: once }), 'once');
  assert.equal(workflowTriggerMode({ ...node, triggerSchedule: daily }), 'daily');
  for (const triggerMode of ['manual', 'completion']) {
    const configured = { ...node, triggerMode, triggerSchedule: daily, inputs: { completion: [{}] } };
    assert.equal(workflowTriggerMode(configured), triggerMode);
    assert.equal(activeTriggerSchedule(configured), undefined);
  }
  assert.equal(activeTriggerSchedule({ ...node, triggerMode: 'daily', triggerSchedule: once }), undefined);
  assert.equal(activeTriggerSchedule({ ...node, triggerMode: 'once', triggerSchedule: daily }), undefined);
  assert.equal(activeTriggerSchedule({ ...node, triggerMode: 'daily', triggerSchedule: daily }), daily);
  assert.equal(activeTriggerSchedule({ ...node, triggerMode: 'once', triggerSchedule: once }), once);
});

test('21:00 repeats on calendar days, including month and year boundaries', () => {
  const before = new Date(2030, 11, 31, 20, 59).getTime();
  const today = new Date(2030, 11, 31, 21).getTime();
  const tomorrow = new Date(2031, 0, 1, 21).getTime();
  assert.equal(nextDailyTrigger('21:00', before), today);
  assert.equal(nextDailyTrigger('21:00', today), tomorrow);
  const schedule = { id: 'daily', at: today, dailyAt: '21:00', status: 'armed' };
  const next = advanceTriggerSchedule(schedule, today);
  assert.deepEqual(next, { ...schedule, at: tomorrow });
  assert.notEqual(triggerScheduleOccurrence(schedule), triggerScheduleOccurrence(next));
  assert.equal(advanceTriggerSchedule(schedule, new Date(2031, 0, 5, 22).getTime()).at, new Date(2031, 0, 6, 21).getTime());
  assert.deepEqual(advanceTriggerSchedule({ id: 'once', at: today, status: 'armed' }, today), { id: 'once', at: today, status: 'fired' });
  for (const time of ['', '24:00', '12:60', '9:00', '21:00:00']) assert.ok(Number.isNaN(nextDailyTrigger(time, today)));
});

test('daily wall-clock time survives DST rather than adding 24 hours', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    for (const [date, hours] of [[new Date(2030, 2, 9, 21), 23], [new Date(2030, 10, 2, 21), 25]]) {
      const next = nextDailyTrigger('21:00', date.getTime());
      assert.equal(new Date(next).getHours(), 21);
      assert.equal(new Date(next).getDate(), date.getDate() + 1);
      assert.equal(next - date.getTime(), hours * 3600000);
    }
    const beforeGap = new Date(2030, 2, 9, 2, 30);
    const gap = nextDailyTrigger('02:30', beforeGap.getTime());
    assert.equal(new Date(gap).getHours(), 3);
    assert.equal(new Date(nextDailyTrigger('02:30', gap)).getHours(), 2);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
