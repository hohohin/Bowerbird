import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DreaminaTaskDiagnostics } from "../../../src/components/creation/DreaminaTaskDiagnostics";
import "../../../src/styles.css";
const w = window as any;
w.calls = [];
w.pending = [];
w.__TAURI_INTERNALS__ = { invoke: (command: string, args: unknown) => {
  w.calls.push({ command, args });
  return new Promise((resolve, reject) => w.pending.push({ resolve, reject }));
} };
function App() {
  const [id, setId] = useState<string | null>("task-a");
  return <main className="p-4"><button onClick={() => setId("task-b")}>切换任务</button>
    <button onClick={() => setId(null)}>没有编号</button><DreaminaTaskDiagnostics submitId={id} /></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
