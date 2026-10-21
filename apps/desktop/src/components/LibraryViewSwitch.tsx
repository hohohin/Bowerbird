import type { CSSProperties } from "react";

export function LibraryViewSwitch({ value, options, onChange, label, hint, feedback }: {
  value: string;
  options: readonly { value: string; label: string; shortcut?: string }[];
  onChange: (value: string) => void;
  label: string;
  hint?: string;
  feedback?: { key: number; label: string };
}) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  return <div className="library-view-switch library-floating-surface" role="tablist" aria-label={label}
    style={{ "--switch-index": index, "--switch-count": options.length } as CSSProperties}>
    <span className="library-view-switch-thumb" aria-hidden="true" />
    {options.map((option, i) => <button key={option.value} type="button" role="tab"
      data-tab-value={option.value} title={hint}
      aria-label={option.label}
      aria-keyshortcuts={option.shortcut?.toLowerCase()}
      aria-selected={value === option.value} tabIndex={index === i ? 0 : -1}
      onClick={() => onChange(option.value)} onKeyDown={event => {
        if (event.ctrlKey || event.metaKey || event.altKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : (i + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
        onChange(options[next].value);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
      }}>{feedback && option.value === value ? <span key={feedback.key} className="library-tab-feedback" aria-hidden="true">
        <span className="library-tab-source-label">{option.label}</span>
        <span className="library-tab-overlay">
          <span className="library-tab-ghost" />
          <svg className="library-tab-crossing-arrow" viewBox="0 0 100 20" preserveAspectRatio="none" fill="none">
            <path d="M3 10H94M86 3L94 10L86 17" vectorEffect="non-scaling-stroke"/>
          </svg>
          <span className="library-tab-view-label">{feedback.label}</span>
        </span>
      </span> : option.label}
      {option.shortcut && <span className="library-source-key-hint" aria-hidden="true"><kbd>{option.shortcut}</kbd></span>}
    </button>)}
  </div>;
}
