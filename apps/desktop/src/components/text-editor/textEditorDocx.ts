import { Buffer } from 'buffer';

// Plate's DOCX image converter uses the Node Buffer API in its browser entry.
globalThis.Buffer ??= Buffer;
export { exportToDocx, importDocx } from '@platejs/docx-io';
