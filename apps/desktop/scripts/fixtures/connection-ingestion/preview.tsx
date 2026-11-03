import React from "react";
import { createRoot } from "react-dom/client";
import { FileDropImport } from "../../../src/components/FileDropImport";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { importDroppedMedia } from "../../../src/lib/mediaImport";
import { useStore } from "../../../src/store";
import { Lightbox } from "../../../src/components/Lightbox";
import { useCompatibleImagePath } from "../../../src/lib/useCompatibleImagePath";
import { useImageZoom } from "../../../src/lib/useImageZoom";

// Closed IPC fixture: no filesystem, clipboard, app startup or provider access.
const w = window as any;
w.calls = []; w.clipboardPaths = []; w.clipboardError = false;
w.importDroppedMedia = importDroppedMedia;
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "clipboard_file_paths") {
      if (w.clipboardError) throw new Error("无法读取剪贴板文件位置，请使用建立连接");
      return w.clipboardPaths;
    }
    if (command === "import_files") return args.sources.map((path: string) => ({ id: path, name: path.split(/[\\/]/).pop(), store_path: path, source: "external" }));
    if (command === "import_image_bytes") return { id: "first-save", name: args.fileName, source: "clipboard" };
    if (command === "create_material_references") return null;
    if (command === "external_files_media") return "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
    throw new Error("Unexpected IPC: " + command);
  },
};
useStore.setState({ projects: [{ id: "p", name: "示例", kind: "blank", provisional: false }] as any, activeProjectId: "p" });
function Fixture() {
  const [preview, setPreview] = React.useState(false);
  const [detail, setDetail] = React.useState(false);
  return <><FileDropImport/><div data-test-target data-file-import-project-id="p" data-file-import-collection-id="folder">集合目标</div><ToastViewport/>
    <button onClick={() => setDetail(true)}>查看 HEIC 详情</button>{detail && <DelayedImage/>}
    <button onClick={() => setPreview(true)}>预览 HEIC</button>{preview && <Lightbox images={["D:/素材/original.heic"]} index={0} onIndexChange={() => {}} onClose={() => setPreview(false)}/>}</>;
}
function DelayedImage() {
  const path = useCompatibleImagePath("D:/素材/detail.heic"), zoom = useImageZoom(path);
  return path && <img data-test-detail ref={zoom.imgRef} src={path} style={zoom.style}/>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
