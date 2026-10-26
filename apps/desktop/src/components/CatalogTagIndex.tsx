import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { Pin } from "lucide-react";
import { catalogInitial, catalogLetters } from "../lib/materialCatalogOrder";
import { OverlayScrollArea } from "./CollectionScrollArea";

export function CatalogTagIndex({ tags, active, dropTarget, alphabetic, pinned, onTogglePin, onNavigate, onLetter }: {
  dropTarget?: string | null;
  tags: { id: string; name: string }[]; active: string | null; alphabetic: boolean;
  pinned: string[]; onTogglePin: (id: string) => void;
  onNavigate: (id: string) => void; onLetter: (letter: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const heldLetter = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [scrubbing, setScrubbing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement } | null>(null);
  function closeMenu() { setMenu(null); }
  const letters = new Set(tags.map(tag => catalogInitial(tag.name)));
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    const view = list.current;
    const item = [...(view?.querySelectorAll<HTMLElement>('[data-section-id]') ?? [])].find(el => el.dataset.sectionId === active);
    if (!view || !item) return;
    const bounds = view.getBoundingClientRect(), rect = item.getBoundingClientRect();
    if (rect.top < bounds.top) view.scrollTop += rect.top - bounds.top;
    else if (rect.bottom > bounds.bottom) view.scrollTop += rect.bottom - bounds.bottom;
  }, [active, tags]);
  function end() { pointer.current = null; heldLetter.current = null; clearTimeout(timer.current); setScrubbing(null); }
  return <div className="catalog-contact-index">
    <nav className="catalog-alphabet" aria-label="标签首字母索引"
      onPointerDown={event => {
        if (event.button !== 0) return;
        const letter = (event.target as HTMLElement).closest<HTMLElement>('[data-letter]')?.dataset.letter;
        if (!letter || !letters.has(letter)) return;
        event.preventDefault(); pointer.current = event.pointerId; heldLetter.current = letter;
        event.currentTarget.setPointerCapture(event.pointerId); onLetter(letter);
        clearTimeout(timer.current); timer.current = setTimeout(() => setScrubbing(heldLetter.current), 220);
      }}
      onPointerMove={event => {
        if (pointer.current !== event.pointerId) return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-letter]')];
        const letter = items.find(item => { const rect = item.getBoundingClientRect(); return event.clientY >= rect.top && event.clientY < rect.bottom; })?.dataset.letter;
        if (!letter || !letters.has(letter) || heldLetter.current === letter) return;
        heldLetter.current = letter; setScrubbing(letter); onLetter(letter);
      }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {catalogLetters.map(letter => <button key={letter} data-letter={letter} aria-label={`定位 ${letter} 开头的标签`}
        aria-disabled={!letters.has(letter)} title={letters.has(letter) ? `${letter} · 按住并滑动快速定位` : `${letter} · 暂无标签`}
        onClick={() => { if (letters.has(letter)) onLetter(letter); }}>{letter}</button>)}
    </nav>
    <OverlayScrollArea scrollRef={list} className="catalog-tag-scroll" viewportClassName="catalog-tag-list" label="标签列表滚动条">
    <div onKeyDown={event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      event.preventDefault(); event.stopPropagation(); items[next]?.focus();
    }}>
      {tags.map((tag, index) => {
        const initial = catalogInitial(tag.name);
        const isPinned = pinned.includes(tag.id);
        return <div key={tag.id}>
          {isPinned && index === 0 && <div className="catalog-letter-heading">置顶</div>}
          {!isPinned && alphabetic && (index === 0 || pinned.includes(tags[index - 1].id) || catalogInitial(tags[index - 1].name) !== initial) && <div className="catalog-letter-heading" aria-hidden="true">{initial}</div>}
          <button className={`catalog-row${dropTarget === tag.id ? " is-drop-target" : ""}`} data-tag-id={tag.id} data-section-id={tag.id} aria-current={active === tag.id ? "location" : undefined}
            title={isPinned ? `${tag.name} · 已置顶` : tag.name} onClick={() => onNavigate(tag.id)}
            onContextMenu={event => {
              event.preventDefault(); event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ id: tag.id, x: event.clientX || rect.left,
                y: event.clientY || rect.bottom, trigger: event.currentTarget });
            }}><span>{tag.name}</span>{isPinned && <Pin size={11} aria-hidden="true"/>}</button>
        </div>;
      })}
    </div>
    </OverlayScrollArea>
    {scrubbing && <div className="catalog-letter-bubble" aria-hidden="true">{scrubbing}</div>}
    {menu && <ContextMenu x={menu.x} y={menu.y} label="标签操作" trigger={menu.trigger} onClose={closeMenu}>
      <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => { onTogglePin(menu.id); closeMenu(); }}>{pinned.includes(menu.id) ? "取消置顶" : "置顶标签"}</button>
    </ContextMenu>}
  </div>;
}
