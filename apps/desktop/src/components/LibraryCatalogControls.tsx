import { useEffect, useState, type ReactNode } from "react";
import { useLibraryModeStore } from "../lib/libraryPane";
import { materialCatalog, type CatalogFilter } from "../lib/materialCatalog";
import { FileColorFilter } from "./FileColorFilter";
import { GeneratedImageFilter } from "./GeneratedImageFilter";
import { LibraryFloatingControls } from "./LibraryFloatingControls";
import { LibraryMediaSwitch } from "./LibraryMediaSwitch";

/** All library views share controls, overflow and bounded color preparation. */
export function LibraryCatalogControls({ filter, onColorChange, onColorsPrepared, children }: {
  filter: CatalogFilter; onColorChange: (color: string | null) => void;
  onColorsPrepared: () => void; children?: ReactNode;
}) {
  const mode = useLibraryModeStore();
  const generated = mode(state => state.generatedFilter);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState({ pending: false, failed: 0 });
  const [retry, setRetry] = useState(0);
  const scope = JSON.stringify({ ...filter, color: null });
  const indexColors = filter.media === "images" && (open || !!filter.color);
  useEffect(() => {
    if (!indexColors) { setProgress({ pending: false, failed: 0 }); return; }
    let current = true;
    setProgress({ pending: true, failed: 0 });
    void (async () => {
      let after: string | null = null, failed = 0;
      try {
        do {
          const batch = await materialCatalog.prepareColors(JSON.parse(scope), after);
          if (!current) return;
          failed += batch.failed; after = batch.after;
          setProgress({ pending: batch.more, failed });
          if (batch.updated) onColorsPrepared();
          if (!batch.more) break;
        } while (current);
      } catch { if (current) setProgress({ pending: false, failed: failed + 1 }); }
    })();
    return () => { current = false; };
  }, [scope, indexColors, retry, onColorsPrepared]);
  return <LibraryFloatingControls>
    <LibraryMediaSwitch/>
    {(filter.media === "all" || filter.media === "images" || filter.media === "videos") && <GeneratedImageFilter floating value={generated} onChange={mode.getState().setGeneratedFilter}/>}
    {filter.media === "images" && <FileColorFilter open={open} onOpenChange={setOpen} color={filter.color} onColorChange={onColorChange}
      palette={{ colors: new Map(), ...progress, retry: () => setRetry(value => value + 1) }}/>}
    {children}
  </LibraryFloatingControls>;
}
