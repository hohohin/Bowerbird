import { deepEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";

import { IdlePollBackoff } from "./idle-poll-backoff.ts";

test("idle polling backs off to one minute and resets after work", () => {
  const backoff = new IdlePollBackoff(2_000);
  deepEqual(
    Array.from({ length: 8 }, () => backoff.nextDelayMs()),
    [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000],
  );
  backoff.reset();
  equal(backoff.nextDelayMs(), 2_000);
});

test("idle polling rejects invalid bounds", () => {
  throws(() => new IdlePollBackoff(0), /idle_poll_base_delay_invalid/);
  throws(() => new IdlePollBackoff(2_000, 1_000), /idle_poll_max_delay_invalid/);
});
