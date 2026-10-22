import { useEffect, useState } from "react";
import { LibraryViewSwitch } from "./LibraryViewSwitch";
import { catalogViews, catalogViewName, useLocalFileMode } from "../lib/localFileMode";

const duration = 1000;

/** Shared navigation in the homepage and project drawer. */
export function LibrarySourceTabs({ value, onChange, project = false }: { value: string; onChange: (value: string) => void; project?: boolean }) {
  const media = useLocalFileMode(s => s.media);
  const view = useLocalFileMode(s => (s.media === "images" ? s.views : s.videoViews).global);
  const transition = useLocalFileMode(s => s.viewTransition);
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (!transition) return;
    const timer = setTimeout(() => setExpired(transition.startedAt), Math.max(0, duration - (Date.now() - transition.startedAt)));
    return () => clearTimeout(timer);
  }, [transition]);
  const feedback = transition?.source === value && transition.startedAt !== expired && Date.now() - transition.startedAt < duration
    ? { key: transition.startedAt, label: catalogViewName(transition.kind, media) } : undefined;
  const hint = media === "images" ? "Tab 切换全部／标签／集合" : "Tab 切换平铺／集合";
  if (!project) return <LibraryViewSwitch value={view} label="素材视图切换条" hint={hint}
    onChange={value => {
      const kind = catalogViews(media).find(kind => kind === value);
      if (kind) useLocalFileMode.getState().setCatalogView(kind);
    }} options={catalogViews(media).map(kind => ({ value: kind, label: catalogViewName(kind, media) }))} />;
  return <LibraryViewSwitch value={value} onChange={onChange} label="素材视图切换条" hint={`Q 全局素材 · E 项目素材 · ${hint}`}
    feedback={feedback}
    options={[{ value: "global", label: "全局素材", shortcut: "Q" },
      { value: "project", label: "项目素材", shortcut: "E" }]} />;
}
