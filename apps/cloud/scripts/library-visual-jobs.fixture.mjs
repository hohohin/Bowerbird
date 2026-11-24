import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export async function verifyLibraryVisualJobs(q, rival, migrationDir) {
  await q("set timezone='UTC'");
  await q("set timezone='UTC'", [], rival);
  for (const file of ["0100_library_visual_catalog.sql", "0101_library_visual_jobs.sql"]) {
    await q(readFileSync(join(migrationDir, file), "utf8"));
  }
  const user = randomUUID();
  const other = randomUUID();
  await q("insert into auth.users(id) values ($1),($2)", [user, other]);
  const key = () => `library-visual:${randomUUID()}`;
  const duration = 7205000;
  const video = (start, end, source = duration) => ({ start_ms: start, end_ms: end, source_duration_ms: source });
  const start = async (parent, segment, window, paid = true, hash = "a".repeat(64), expected = 7, conn, owner = user) =>
    (await q("select begin_library_visual_segment($1,$2,$3,$4,$5,$6,20261123,$7,100,1000000000,100) as v",
      [owner, parent, segment, hash, window, expected, paid], conn))[0].v;
  const control = async (action, segment, actor = null, lease = null, text = null, receipt = null) =>
    (await q("select control_library_visual_segment($1,$2,$3,$4,$5,$6) as v", [action, segment, actor, lease, text, receipt]))[0].v;
  const walletStatus = async id => (await q("select status from credit_holds where id=$1", [id]))[0].status;
  const parentKey = key();
  const firstKey = key();
  await assert.rejects(start(parentKey, firstKey, video(0, 7200000), false), error => error.detail === "library_visual_closed");
  await assert.rejects(start(parentKey, firstKey, video(0, 7200000)), error => error.detail === "price_unavailable");
  await q("update service_costs set active=true,unit_cost=3,parameters='{\"pricing_ready\":true}' where service='library_video_analysis'");
  await assert.rejects(start(parentKey, firstKey, video(0, 1000)), error => error.code === "22023");
  await assert.rejects(start(parentKey, firstKey, video(0, 7200000), true, "a".repeat(64), 6), error => error.detail === "stale_quote");

  const [first, concurrent] = await Promise.all([
    start(parentKey, firstKey, video(0, 7200000)),
    start(parentKey, firstKey, video(0, 7200000), true, "a".repeat(64), 7, rival),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(await walletStatus(first.parent.hold_id), "pending_settlement");
  assert.equal(first.parent.credits, 7);
  assert.deepEqual(await start(parentKey, firstKey, video(0,7200000), false), first);
  await assert.rejects(start(parentKey, firstKey, video(0,7200000), false, "b".repeat(64)), error => error.detail === "manifest_conflict");
  await assert.rejects(start(parentKey, key(), video(7200000, duration), false), error => error.detail === "manifest_conflict");
  await assert.rejects(control("commit", first.segment.id, other), error => error.code === "P0002");

  await control("commit", first.segment.id, user);
  const lease = await control("claim");
  assert.equal(lease.id, first.segment.id);
  await assert.rejects(control("finish", lease.id, null, lease.lease_id, "先提交再完成"), error => error.code === "22023");
  await control("submitted", lease.id, null, lease.lease_id);
  await assert.rejects(control("submitted", lease.id, null, lease.lease_id), error => error.code === "22023");
  const firstDone = await control("finish", lease.id, null, lease.lease_id, "网球场", { usage: { prompt_tokens: 8 } });
  assert.equal(firstDone.parent.finished_status, null);
  assert.equal(await walletStatus(first.parent.hold_id), "pending_settlement");
  const last = await start(parentKey, key(), video(7200000, duration), false);
  await control("commit", last.segment.id, user);
  const tailLease = await control("claim");
  assert.equal(tailLease.id, last.segment.id);
  await control("submitted", tailLease.id, null, tailLease.lease_id);
  const done = await control("finish", tailLease.id, null, tailLease.lease_id, "挥拍", { usage: { prompt_tokens: 3 } });
  assert.equal(done.parent.finished_status, "succeeded");
  assert.equal(await walletStatus(first.parent.hold_id), "confirmed");
  assert.deepEqual(await q("select kind,amount from credit_transactions where hold_id=$1 and kind='confirm'", [first.parent.hold_id]), [{ kind: "confirm", amount: 0 }]);

  for (const [terminal, expected] of [["fail", "rolled_back"], ["unknown", "pending_settlement"]]) {
    const newParentKey = key(), segmentKey = key();
    const single = await start(newParentKey, segmentKey, video(0,1000,1000), true, "a".repeat(64), 1);
    await control("commit", single.segment.id, user);
    const pending = await control("claim");
    await control("submitted", pending.id, null, pending.lease_id);
    await control(terminal, pending.id, null, pending.lease_id);
    assert.equal(await walletStatus(single.parent.hold_id), expected);
    assert.equal(await control("claim"), null);
    assert.equal((await start(newParentKey, segmentKey, video(0,1000,1000), false)).segment.status,
      terminal === "fail" ? "failed" : "outcome_unknown");
    if (terminal === "unknown") {
      await q("update library_visual_jobs set expires_at=now()-interval '1 second' where id=$1", [single.parent.id]);
      await control("expire", pending.id);
      assert.equal(await walletStatus(single.parent.hold_id), "pending_settlement");
      const refund = async () => (await q("select refund_unknown_library_visual($1,$2) as refunded", [single.parent.id, "fixture confirms unrecoverable provider result"]))[0].refunded;
      assert.equal(await refund(), true);
      assert.equal(await refund(), false);
      assert.equal(await walletStatus(single.parent.hold_id), "rolled_back");
    }
  }
  const mismatch = await start(key(), key(), video(0,1000,1000), true, "a".repeat(64), 1);
  await assert.rejects(control("reject-upload", mismatch.segment.id, other), error => error.code === "P0002");
  assert.equal((await control("reject-upload", mismatch.segment.id, user)).segment.status, "failed");
  assert.equal(await walletStatus(mismatch.parent.hold_id), "rolled_back");
  const stalled = await start(key(), key(), video(0,1000,1000), true, "a".repeat(64), 1);
  await control("commit", stalled.segment.id, user);
  const stalledLease = await control("claim");
  await control("submitted", stalledLease.id, null, stalledLease.lease_id);
  await q("update library_visual_segments set lease_expires_at=now()-interval '1 second' where id=$1", [stalledLease.id]);
  assert.equal(await control("claim"), null);
  assert.equal((await control("expire", stalledLease.id)).segment.status, "outcome_unknown");
  assert.equal(await walletStatus(stalled.parent.hold_id), "pending_settlement");

  await q("set role authenticated");
  try {
    await assert.rejects(q("select * from public.library_visual_segments"), error => error.code === "42501");
    await assert.rejects(control("claim"), error => error.code === "42501");
  } finally { await q("reset role"); }
  console.log("library visual: closed/default, single parent reservation, same-key concurrency and recovery, canonical segmentation, owner/lease, finalization, refund, unknown fence");
}
