import { isAudioPath } from "./audioMedia";
import { isEditableTarget } from "./isEditableKeyTarget";
import { isVideoPath } from "./videoGeneration";

export function isClipboardImage(file: File) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|tiff?|psd)$/i.test(file.name);
}

export function clipboardMediaFiles(data: DataTransfer) {
  const result: File[] = [];
  const seen = new Map<string, number[]>();
  function add(file: File) {
    if (!isClipboardImage(file) && !isVideoPath(file.name) && !isAudioPath(file.name)
      && !/^(audio|video)\//.test(file.type)) return;
    const key = JSON.stringify([file.name, file.size, file.lastModified]);
    const path = (file as File & { path?: string }).path;
    const matches = seen.get(key) ?? [];
    const duplicate = matches.find(index => {
      const existingPath = (result[index] as File & { path?: string }).path;
      return !path || !existingPath || path === existingPath;
    });
    if (duplicate !== undefined) {
      if (path && !(result[duplicate] as File & { path?: string }).path) result[duplicate] = file;
      return;
    }
    seen.set(key, [...matches, result.length]);
    result.push(file);
  }
  for (const file of Array.from(data.files ?? [])) add(file);
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) add(file);
  }
  return result;
}

export function clipboardEditing(event: ClipboardEvent) {
  return isEditableTarget(event.target) || isEditableTarget(document.activeElement)
    || !!document.querySelector('[role="dialog"][aria-modal="true"],dialog[open]');
}
