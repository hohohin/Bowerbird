import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { TagCount } from "../lib/types";
import { useStore } from "../store";
import { LocalClassificationDialog } from "./LocalClassificationDialog";
import { TagIndex } from "./TagIndex";

export function LibraryTagBar({ projectId = null }: { projectId?: string | null }) {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [management, setManagement] = useState(false);
  const manageButton = useRef<HTMLButtonElement>(null);
  const autoTags = useStore(s => s.autoTags);
  const filter = useStore(s => s.smartFilter);
  const active = filter?.startsWith("tag:") ? filter.slice(4) : null;
  useEffect(() => {
    let alive = true;
    setFailed(false); setTags([]);
    api.listTags("all", projectId).then(result => { if (alive) setTags(result); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [projectId, autoTags, revision]);
  function select(name: string | null) {
    const state = useStore.getState();
    state.setSearchQuery("");
    state.setSmartFilter(name ? `tag:${name}` : null);
    state.clearSelect();
  }
  return <>
    <TagIndex key={projectId ?? "library"} tags={tags} active={tags.find(tag => tag.name === active)?.id ?? active}
      onSelect={id => select(tags.find(tag => tag.id === id)?.name ?? null)} onManage={() => setManagement(true)}
      manageButtonRef={manageButton} failed={failed} onRetry={() => setRevision(value => value + 1)} />
    {management && <LocalClassificationDialog onClose={() => {
      setManagement(false); setRevision(value => value + 1); manageButton.current?.focus();
    }} />}
  </>;
}
