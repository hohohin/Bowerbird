import type { CSSProperties, ReactNode } from "react";

export function LibraryViewSwitch({ value, options, onChange, label, hint }: {
  value: string;
  options: readonly { value: string; label: string; icon?: ReactNode; shortcut?: string; disabled?: boolean; title?: string; expanded?: boolean; controls?: string }[];
  onChange: (value: string) => void;
  label: string;
  hint?: string;
}) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  return <div className="library-view-switch library-floating-surface" role="tablist" aria-label={label}
    style={{ "--switch-index": index, "--switch-count": options.length } as CSSProperties}>
    <span className="library-view-switch-thumb" aria-hidden="true" />
    {options.map((option, i) => <button key={option.value} type="button" role="tab"
      data-tab-value={option.value} title={option.title ?? (option.disabled ? "请先打开项目" : hint)} disabled={option.disabled}
      aria-expanded={option.expanded} aria-controls={option.controls}
      aria-label={option.label}
      aria-keyshortcuts={option.shortcut?.toLowerCase()}
      aria-selected={value === option.value} tabIndex={index === i ? 0 : -1}
      onClick={() => onChange(option.value)} onKeyDown={event => {
        if (event.ctrlKey || event.metaKey || event.altKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const available = options.map((option, index) => ({ ...option, index })).filter(option => !option.disabled);
        const current = available.findIndex(option => option.index === i);
        const next = available[event.key === "Home" ? 0 : event.key === "End" ? available.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length].index;
        const tabs = event.currentTarget.parentElement;
        const host = tabs?.closest('.library-catalog-transition')?.parentElement;
        onChange(options[next].value);
        // Switching catalogs can replace the tab strip with its new view.
        requestAnimationFrame(() => {
          const current = host ? [...host.querySelectorAll<HTMLElement>('[role="tablist"]')].find(element => element.getAttribute('aria-label') === label && !element.closest('[data-outgoing]')) : tabs;
          current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
        });
      }}>{option.icon}<span className="library-view-label">{option.label}</span>
      {option.shortcut && <span className="library-source-key-hint" aria-hidden="true"><kbd>{option.shortcut}</kbd></span>}
    </button>)}
  </div>;
}
