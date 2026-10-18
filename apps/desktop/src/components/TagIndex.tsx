import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Settings2, X } from "lucide-react";

const tagNameOrder = new Intl.Collator("zh-Hans-CN-u-co-pinyin", { numeric: true, sensitivity: "base" });
const smoothStep = (value: number) => value * value * (3 - 2 * value);

export function TagIndex({ tags: sourceTags, active, onSelect, onManage, manageButtonRef, disabled = false, failed = false, onRetry }: {
  tags: { id: string; name: string }[]; active: string | null; onSelect: (id: string | null) => void; onManage: () => void;
  manageButtonRef?: RefObject<HTMLButtonElement>; disabled?: boolean; failed?: boolean; onRetry?: () => void;
}) {
  const tags = [...sourceTags].sort((a, b) => tagNameOrder.compare(a.name, b.name));
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const barRef = useRef<HTMLElement>(null);
  const center = hovered ?? focused;
  useEffect(() => {
    const bar = barRef.current;
    const library = bar?.closest(".local-file-workspace, .library-browser");
    if (!bar || !library) return;
    // Observe the edge without placing a mouse-blocking layer over the assets.
    function move(event: Event) {
      const { clientX, clientY, buttons } = event as PointerEvent;
      // The transparent scroll rail shares the reveal strip. Hover should reveal
      // tags too; only an active scrollbar drag keeps them out of the way.
      if (buttons !== 0 && (event.target as Element).closest(".collection-scroll-rail")) {
        setRevealed(false);
        setHovered(null);
        return;
      }
      const rect = bar!.getBoundingClientRect();
      const open = bar!.contains(event.target as Node) || (clientY >= rect.top && clientY <= rect.bottom
        && clientX >= rect.right - (revealed ? rect.width : 20.8) && clientX <= rect.right);
      setRevealed(open);
      const menu = bar!.querySelector<HTMLElement>(".library-tag-menu");
      const first = menu?.querySelector<HTMLElement>("button[data-distance]");
      const menuRect = menu?.getBoundingClientRect();
      if (open && first && menuRect && clientY >= menuRect.top && clientY <= menuRect.bottom) {
        // Track vertical proximity, including gaps, independently of the moving text.
        const row = first.getBoundingClientRect();
        setHovered((clientY - row.top) / row.height - 0.5);
      } else setHovered(null);
    }
    function leave() { setRevealed(false); setHovered(null); }
    function press(event: Event) {
      if (!bar!.contains(event.target as Node)) leave();
    }
    library.addEventListener("pointermove", move, { passive: true, capture: true });
    library.addEventListener("pointerleave", leave);
    library.addEventListener("pointerdown", press, true);
    return () => {
      library.removeEventListener("pointermove", move, true);
      library.removeEventListener("pointerleave", leave);
      library.removeEventListener("pointerdown", press, true);
    };
  }, [revealed]);
  return (
    <aside ref={barRef} className={`library-tag-bar${revealed ? " is-revealed" : ""}`} aria-label="标签筛选" onPointerDownCapture={() => setRevealed(true)}>
      <button type="button" className="library-tag-reveal" aria-label="显示标签列表" title="显示标签列表" onClick={() => setRevealed(true)} />
      <div className="library-tag-content">
      <nav className="library-tag-menu" aria-label="分类标签" onScroll={() => setHovered(null)}>
        {tags.map((tag, index) => {
          const distance = center === null ? 3 : Math.min(3, Math.abs(index - center));
          const step = Math.min(2, Math.floor(distance));
          const magnification = [0.6, 0.3, 0.12, 0];
          const scale = 1 + magnification[step] + (magnification[step + 1] - magnification[step]) * smoothStep(distance - step);
          const extension = smoothStep(Math.min(1, 3 - distance));
          return <button type="button" key={tag.id} title={active === tag.id ? `${tag.name} · 再次点击取消筛选` : tag.name}
            data-distance={Math.round(distance)} aria-label={tag.name} aria-pressed={active === tag.id}
            style={{ "--tag-extension": extension, "--tag-scale": scale, "--tag-strength": (scale - 1) / 0.6,
              "--tag-duration": center === null ? "200ms" : "300ms" } as CSSProperties}
            onPointerDown={() => setFocused(null)}
            onFocus={event => { if (event.currentTarget.matches(":focus-visible")) setFocused(index); }}
            onBlur={() => setFocused(null)} onClick={() => onSelect(active === tag.id ? null : tag.id)}
            onKeyDown={event => {
              if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation(); setHovered(null);
              const next = event.key === "Home" ? 0 : event.key === "End" ? tags.length - 1
                : Math.max(0, Math.min(tags.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
              const target = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next];
              target?.focus({ preventScroll: true });
              if (target) {
                const menu = target.parentElement!;
                const row = target.getBoundingClientRect(), viewport = menu.getBoundingClientRect();
                if (row.top < viewport.top) menu.scrollTop += row.top - viewport.top;
                else if (row.bottom > viewport.bottom) menu.scrollTop += row.bottom - viewport.bottom;
              }
              setFocused(next);
            }}><span>{tag.name}</span></button>;
        })}
        {failed && <button type="button" className="library-tag-retry" onClick={() => onRetry?.()}>标签加载失败 · 重试</button>}
      </nav>
      <div className="library-tag-actions">
        {active && <button type="button" aria-label="清除标签筛选" title="清除标签筛选" onClick={() => onSelect(null)}><X size={13} /></button>}
        <button ref={manageButtonRef} type="button" aria-label="管理标签" title="管理标签" disabled={disabled} onClick={onManage}><Settings2 size={13} /></button>
      </div>
      </div>
    </aside>
  );
}
