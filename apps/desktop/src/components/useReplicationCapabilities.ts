import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
export interface ReplicationCapability { operation: "video-analysis" | "text-rewrite"; available: boolean; credits: number | null }
export function useReplicationCapabilities(projectId: string) {
  const [state, setState] = useState<{ services: ReplicationCapability[]; error: string; loading: boolean }>({ services: [], error: "", loading: true });
  const [revision, refresh] = useState(0);
  const identity = useStore(s => `${s.cloudAuth?.user_id}:${s.cloudAuth?.logged_in}`);
  useEffect(() => {
    let disposed = false, inFlight = false;
    let timer: ReturnType<typeof setTimeout>, deadline: ReturnType<typeof setTimeout>;
    async function read() {
      if (disposed || inFlight) return;
      inFlight = true; clearTimeout(timer);
      let delay = 30000;
      try {
        const value = await Promise.race([
          invoke<{ services: ReplicationCapability[] }>("video_replication", { projectId, action: "capabilities", data: {} }),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("读取 Cloud 价格超时")), 15000); }),
        ]);
        if (!["video-analysis", "text-rewrite"].every(operation => value?.services?.some(s => s.operation === operation && typeof s.available === "boolean" && (!s.available || typeof s.credits === "number" && s.credits > 0)))) throw new Error("Cloud 返回的服务状态不完整");
        if (!disposed) setState({ services: value.services, error: "", loading: false });
      } catch (e) { delay = 5000; if (!disposed) setState({ services: [], error: String(e), loading: false }); }
      finally { clearTimeout(deadline); inFlight = false; if (!disposed) timer = setTimeout(read, delay); }
    }
    const focus = () => { if (!document.hidden) void read(); };
    void read(); window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(deadline); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [projectId, identity, revision]);
  return { ...state, refresh: () => refresh(n => n + 1) };
}
