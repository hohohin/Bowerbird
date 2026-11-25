import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useFileColors } from "../../../src/lib/useFileColors";
import type { LocalFileEntry } from "../../../src/lib/externalFiles";
const w = window as any;
w.calls = [];
w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: { path: string }) => {
  if (command !== "file_colors") throw new Error(command);
  w.calls.push(args.path);
  if (w.failure === args.path) throw new Error("synthetic read failure");
  if (w.hold === args.path) return new Promise(resolve => { w.release = () => resolve(["blue"]); });
  return ["red"];
} };
function App() {
  const [state, setState] = useState<{ entries: LocalFileEntry[]; revision: number }>({ entries: [], revision: 0 });
  const palette = useFileColors(state.entries, true, state.revision);
  w.setSnapshot = setState;
  return <output>{JSON.stringify({ pending: palette.pending, failed: palette.failed, colors: Object.fromEntries(palette.colors) })}</output>;
}
createRoot(document.getElementById("root")!).render(<App/>);
