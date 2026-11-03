import test from "node:test";
import assert from "node:assert/strict";
import { createCanvasDragHold, CANVAS_DRAG_HOLD_MS } from "../src/lib/canvasDragHold.ts";

test("a stationary press triggers once at 600ms, tolerating small hand movement", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = createCanvasDragHold();
  let calls = 0;
  hold.start(1, { x: 100, y: 50 }, () => calls++);
  t.mock.timers.tick(CANVAS_DRAG_HOLD_MS - 1);
  assert.equal(calls, 0);
  hold.move(1, { x: 103, y: 52 });
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  t.mock.timers.tick(2000);
  assert.equal(calls, 1);
});

test("crossing the canvas threshold cancels the press even if it returns and pauses", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = createCanvasDragHold();
  let calls = 0;
  hold.start(1, { x: 20, y: 20 }, () => calls++);
  t.mock.timers.tick(100);
  hold.move(1, { x: 24, y: 20 });
  hold.move(1, { x: 20, y: 20 });
  t.mock.timers.tick(2000);
  assert.equal(calls, 0);
});

test("release, cancellation and a lost held button cannot fire a stale press", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = createCanvasDragHold();
  let calls = 0;
  for (const interrupt of [() => hold.end(1), () => hold.cancel(), () => hold.move(1, { x: 1, y: 1 }, 0)]) {
    hold.start(1, { x: 1, y: 1 }, () => calls++);
    t.mock.timers.tick(599);
    interrupt();
    t.mock.timers.tick(2000);
  }
  assert.equal(calls, 0);
});

test("a new press replaces the old one and another pointer cannot complete it", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = createCanvasDragHold();
  const fired = [];
  hold.start(1, { x: 0, y: 0 }, () => fired.push("old"));
  t.mock.timers.tick(500);
  hold.start(2, { x: 50, y: 50 }, () => fired.push("new"));
  hold.end(1);
  hold.move(1, { x: 100, y: 100 }, 0);
  t.mock.timers.tick(100);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(500);
  assert.deepEqual(fired, ["new"]);
});

test("timer eligibility is cleared before handing control to the native drag", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = createCanvasDragHold();
  const fired = [];
  hold.start(1, { x: 0, y: 0 }, () => {
    fired.push("first");
    hold.start(2, { x: 0, y: 0 }, () => fired.push("second"));
  });
  t.mock.timers.tick(600);
  assert.deepEqual(fired, ["first"]);
  t.mock.timers.tick(600);
  assert.deepEqual(fired, ["first", "second"]);
});
