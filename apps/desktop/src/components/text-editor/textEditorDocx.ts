import { Buffer } from 'buffer';

// Plate's DOCX image converter uses the Node Buffer API in its browser entry.
globalThis.Buffer ??= Buffer;
export { importDocx, exportToDocx } from '@platejs/docx-io';
