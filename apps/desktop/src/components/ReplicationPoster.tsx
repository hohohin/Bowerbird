import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Film } from "lucide-react";
import { replicationCall } from "./replicationTaskState";

const posters = new Map<string, Promise<string>>();

export function ReplicationPoster({ projectId, referenceId, alt }: { projectId: string; referenceId: string; alt: string }) {
  const key = `${projectId}:${referenceId}`;
  const [loaded, setLoaded] = useState<{ key: string; path: string }>();
  const [failed, setFailed] = useState("");
  useEffect(() => {
    let active = true;
    let request = posters.get(key);
    if (!request) {
      request = replicationCall<string>(projectId, "reference-poster", { id: referenceId });
      posters.set(key, request);
    }
    void request.then(path => { if (active) setLoaded({ key, path }); }).catch(() => {
      posters.delete(key);
      if (active) setFailed(key);
    });
    return () => { active = false; };
  }, [key, projectId, referenceId]);
  if (failed === key) return <><Film size={30} /><span>封面读取失败</span></>;
  if (loaded?.key !== key) return <><Film size={30} /><span>正在读取首帧…</span></>;
  return <img src={convertFileSrc(loaded.path)} alt={alt} onError={() => { posters.delete(key); setFailed(key); }} />;
}
