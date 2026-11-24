import { readFileSync, statSync } from 'node:fs';
import { validateSnapshot, MAX_SNAPSHOT_BYTES } from './core.mjs';

// The exporter atomically replaces this one permitted file. Keep OAuth state in
// the HTTP server and only replace the validated snapshot used by each tool call.
export function createSnapshotReader(file, report = () => {}) {
  let snapshot;
  let observed;
  return function readSnapshot() {
    let signature;
    try {
      const stat = statSync(file, { bigint: true });
      signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      if (signature === observed) return snapshot;
      if (stat.size > BigInt(MAX_SNAPSHOT_BYTES)) throw new Error('Snapshot exceeds size limit');
      const candidate = validateSnapshot(JSON.parse(readFileSync(file, 'utf8')));
      snapshot = candidate;
      observed = signature;
      report({ event: 'snapshot-loaded', createdAt: candidate.createdAt, fileCount: candidate.files.length });
    } catch (error) {
      if (!snapshot) throw error;
      if (signature !== observed) report({ event: 'snapshot-rejected', retainedCreatedAt: snapshot.createdAt });
      observed = signature;
    }
    return snapshot;
  };
}
