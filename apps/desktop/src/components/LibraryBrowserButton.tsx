import { useLibraryModeStore } from "../lib/libraryPane";
import { FolderOpen } from "lucide-react";

/** File browsing is an independent tool, outside the source/view keyboard cycles. */
export function LibraryBrowserButton() {
  const useLocalFileMode = useLibraryModeStore();
  const mode = useLocalFileMode(s => s.mode);
  const active = mode === "files" || mode === "global";
  return <button className="library-filter-trigger" aria-label="文件浏览器" aria-pressed={active}
    title={active ? "关闭文件浏览器，返回分类视图" : "打开文件浏览器"}
    onClick={() => {
      const state = useLocalFileMode.getState();
      if (active) state.closeBrowser(); else state.openBrowser();
    }}><FolderOpen size={14}/></button>;
}
