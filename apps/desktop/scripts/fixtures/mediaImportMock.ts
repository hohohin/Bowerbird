/** Closed import IPC for media regression tests. Never touches a native library. */
export function installMediaImportMock(w: any, assets: any[]) {
  const base = w.__TAURI_INTERNALS__.invoke;
  const uploads = new Map<string, any>();
  w.mediaImports = [];
  w.mediaCalls = [];
  w.pendingUploads = () => uploads.size;
  const documents = new Map<string, string>();
  function imported(name: string, projectId: string | null, text = "") {
    if (name.startsWith("bad")) throw new Error("模拟损坏视频");
    const video = /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name);
    const document = /\.(md|markdown|txt|docx|xlsx|csv)$/i.test(name);
    const asset = { id: `media-${w.mediaImports.length}`, name, ext: video || document ? name.split(".").pop().toLowerCase() : "png",
      width: 160, height: 90, duration: video ? 0.4 : 0, source: "imported", library_hidden: false,
      store_path: document ? `/inbox/${name}` : video ? "/test-media.mp4" : assets[0].store_path, thumb_path: document ? null : assets[0].thumb_path ?? assets[0].store_path };
    if (document) documents.set(asset.id, text);
    assets.push(asset); w.mediaImports.push({ asset, projectId });
    w.emitAssetsChanged();
    return asset;
  }
  w.__TAURI_INTERNALS__.invoke = async (command: string, args: any = {}) => {
    if (command.startsWith("video_import_") || ["import_files", "import_image_bytes", "plugin:dialog|open"].includes(command)) {
      w.mediaCalls.push({ command, args: command === "video_import_append" ? { ...args, data: undefined, length: atob(args.data).length } : args });
    }
    if (command === "plugin:dialog|open") return w.pickedFiles ?? null;
    if (command === "read_text_document" && documents.has(args.assetId)) {
      if (w.failTextRead) throw new Error("此文件的编码暂不支持，请先在外部编辑器另存为 UTF-8");
      const asset = assets.find(asset => asset.id === args.assetId);
      const office = w.officeFiles?.[asset.name];
      if (office) return { assetId: asset.id, path: asset.store_path, text: office.text, version: 'v1',
        format: asset.ext === 'docx' && !args.previewOnly ? 'docx' : 'text', docxData: args.previewOnly ? undefined : office.docxData };
      return { assetId: asset.id, path: asset.store_path, text: documents.get(asset.id), version: 'v1', format: asset.ext === 'txt' ? 'text' : 'markdown' };
    }
    if (command === 'read_spreadsheet_document') {
      if (w.failSpreadsheetRead) throw new Error('工作表无法读取，请重新打开');
      const asset = assets.find(asset => asset.id === args.assetId);
      return w.officeFiles[asset.name].spreadsheet;
    }
    if (command === "video_import_begin") { const id = `upload-${w.mediaCalls.length}`; uploads.set(id, { ...args, written: 0, chunks: [] }); return id; }
    if (command === "video_import_append") {
      if (w.failChunk) throw new Error("模拟磁盘写入失败");
      const upload = uploads.get(args.uploadId);
      if (!upload || args.offset !== upload.written || atob(args.data).length > 1024 * 1024) throw new Error("invalid chunk");
      upload.chunks.push(Uint8Array.from(atob(args.data), value => value.charCodeAt(0)));
      upload.written += atob(args.data).length; return;
    }
    if (command === "video_import_finish") {
      if (w.holdMedia) await new Promise(resolve => { w.releaseMedia = resolve; });
      const upload = uploads.get(args.uploadId); uploads.delete(args.uploadId);
      if (!upload || upload.written !== upload.size) throw new Error("incomplete upload");
      return imported(upload.fileName, upload.projectId, await new Blob(upload.chunks).text());
    }
    if (command === "video_import_cancel") { uploads.delete(args.uploadId); return; }
    if (command === "import_files") return args.sources.map((path: string) => imported(path.split(/[\\/]/).pop()!, args.projectId, w.textFiles?.[path] ?? ""));
    if (command === "import_image_bytes" && args.source === "imported") return imported(args.fileName, args.projectId);
    if (command === "external_files_media") return args.path;
    return base(command, args);
  };
}
