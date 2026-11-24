import { serializeMarkdown } from './documentCodec';
import type { DocumentValue } from './documentTypes';

self.onmessage = ({ data }: MessageEvent<{ id: number; value: DocumentValue }>) => {
  try { self.postMessage({ id: data.id, result: serializeMarkdown(data.value) }); }
  catch { self.postMessage({ id: data.id, failed: true }); }
};
