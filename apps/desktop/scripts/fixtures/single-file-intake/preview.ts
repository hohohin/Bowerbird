import { importDroppedMedia } from "../../../src/lib/mediaImport";
const w = window as any;
w.calls = []; w.failAppend = false;
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
  w.calls.push({ command, args });
  if (command === "video_import_begin") return "upload";
  if (command === "video_import_append" && w.failAppend) throw new Error("receive failed");
  if (command === "video_import_finish") return { id: "received", store_path: "/BowerbirdLibrary/收集箱/received.png" };
  if (command === "import_files") return [{ id: "linked", store_path: args.sources[0] }];
  if (command === "clipboard_file_paths") return [];
  if (command === "import_image_bytes") return { id: "bitmap" };
  return null;
} };
w.receive = async (name: string, type: string, size: number, path?: string, source = "imported") => {
  const file = new File([new Uint8Array(size)], name, { type });
  if (path) Object.defineProperty(file, "path", { value: path });
  return importDroppedMedia(file, null, source);
};
w.ready = true;
