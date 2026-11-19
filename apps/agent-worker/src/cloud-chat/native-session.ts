import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const KEY = /^[a-f0-9]{64}$/;
const JOB = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface NativeChatClaim { session_key: string; previous_job_id: string | null }

/** The control plane chooses the parent from succeeded jobs for the same account/conversation. */
export function stageNativeSession(root: string, jobId: string, {session_key: key, previous_job_id: parent}: NativeChatClaim, ephemeral = false) {
  if (!isAbsolute(root) || resolve(root) === resolve("/") || !KEY.test(key) || !JOB.test(jobId) ||
      (parent !== null && (!JOB.test(parent) || parent === jobId))) throw new Error("dsh_session_identity_invalid");
  const dir = ephemeral ? root : join(root, key), target = join(dir, jobId);
  mkdirSync(dir, {recursive:true, mode:0o700});
  if (existsSync(target)) throw new Error("dsh_session_already_published");
  const previous = parent && join(dir, parent);
  if (previous && !existsSync(previous)) throw new Error("dsh_session_state_missing");
  // A new claim can only run after the preceding job became terminal. The live parent
  // and a new staging area are the only required copies, including after a worker crash.
  for (const entry of ephemeral ? [] : readdirSync(dir, {withFileTypes:true})) {
    if (entry.name !== parent && (JOB.test(entry.name) || /^\.stage-[a-zA-Z0-9]+$/.test(entry.name)))
      rmSync(join(dir, entry.name), { recursive:true, force:true });
  }
  const stage = mkdtempSync(join(dir, ".stage-"));
  try {
    if (previous) cpSync(previous, stage, {recursive:true});
  } catch (error) { rmSync(stage, {recursive:true,force:true}); throw error; }
  return { dir: stage, sessionId: key,
    publish() { renameSync(stage, target); },
    dispose() { rmSync(stage, {recursive:true,force:true}); },
  };
}
