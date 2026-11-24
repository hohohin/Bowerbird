import fs from 'node:fs';
import { validateSnapshot, MAX_SNAPSHOT_BYTES } from './core.mjs';

const signatureOf = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

// Both transports pin one validated object for the duration of each tool call.
export function createSnapshotReader(file, report = () => {}) {
  let snapshot;
  let observed;
  function retained() {
    if (!snapshot) throw new Error('No valid snapshot available');
    return snapshot;
  }
  function reject(reason, invalidSignature) {
    if (invalidSignature !== undefined) observed = invalidSignature;
    report({ event: 'snapshot-rejected', reason, retainedCreatedAt: snapshot?.createdAt });
    return retained();
  }
  return function readSnapshot() {
    let signature;
    try { signature = signatureOf(fs.statSync(file, { bigint: true })); }
    catch { return reject('read_error'); }
    if (signature === observed) return retained();
    let buffer;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        // A rename between stat and open is valid. Cache the identity we actually read.
        const stat = fs.fstatSync(fd, { bigint: true });
        signature = signatureOf(stat);
        if (stat.size <= BigInt(MAX_SNAPSHOT_BYTES)) buffer = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
    } catch { return reject('read_error'); }
    if (!buffer || buffer.length > MAX_SNAPSHOT_BYTES) return reject('size_limit', signature);
    try {
      snapshot = validateSnapshot(JSON.parse(buffer.toString('utf8')));
    } catch { return reject('invalid_snapshot', signature); }
    observed = signature;
    report({ event: 'snapshot-loaded', createdAt: snapshot.createdAt, fileCount: snapshot.files.length });
    return snapshot;
  };
}
