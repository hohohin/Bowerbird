import { Fragment, forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { findTacticalOption, moveTacticalOption, parseTacticalOptions, tacticalSelectPosition } from "./tacticalSelectLogic";

export interface TacticalSelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type" | "value" | "defaultValue" | "onChange"> {
  children?: ReactNode;
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
}

export const TacticalSelect = forwardRef<HTMLButtonElement, TacticalSelectProps>(function TacticalSelect({
  children, value, defaultValue, onValueChange, disabled, className = "", id, name, form,
  onClick, onKeyDown, onPointerDown, onMouseDown, ...buttonProps
}, forwardedRef) {
  const options = useMemo(() => parseTacticalOptions(children), [children]);
  const first = options.find(option => !option.disabled && !option.hidden);
  const [uncontrolledValue, setUncontrolledValue] = useState(() => defaultValue == null ? first?.value ?? "" : String(defaultValue));
  const currentValue = value == null ? uncontrolledValue : String(value);
  const selectedIndex = options.findIndex(option => option.value === currentValue);
  const selected = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<ReturnType<typeof tacticalSelectPosition> | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const search = useRef({ text: "", time: 0 });
  const generatedId = useId();
  const triggerId = id ?? `tactical-select-${generatedId}`;
  const listId = `${triggerId}-listbox`;
  const optionId = (index: number) => `${listId}-option-${index}`;

  function unavailable() { return !!disabled || !trigger.current || trigger.current.matches(":disabled"); }
  function close(restore = false) {
    setOpen(false);
    search.current = { text: "", time: 0 };
    if (restore) trigger.current?.focus({ preventScroll: true });
  }
  function choose(index: number) {
    if (unavailable()) { close(); return; }
    const option = options[index];
    if (!option || option.disabled || option.hidden) return;
    if (value == null) setUncontrolledValue(option.value);
    if (option.value !== currentValue) onValueChange?.(option.value);
    close(true);
  }
  function show(edge?: "first" | "last") {
    if (unavailable() || !options.some(option => !option.hidden)) return;
    const initial = edge === "last" ? moveTacticalOption(options, 0, -1)
      : edge === "first" ? moveTacticalOption(options, -1, 1)
      : selected && !selected.disabled && !selected.hidden ? selectedIndex : moveTacticalOption(options, -1, 1);
    setActive(initial);
    setPosition(null);
    setOpen(true);
  }
  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    // The first Escape belongs to the open popup, not the surrounding editor.
    if (open && event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close(true); return;
    }
    onKeyDown?.(event);
    if (event.defaultPrevented || unavailable() || event.nativeEvent.isComposing) return;
    const key = event.key;
    if (key === "Tab") { if (open) close(); return; }
    if (key === "Escape") return;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      event.preventDefault(); event.stopPropagation();
      search.current = { text: "", time: 0 };
      if (!open) show(key === "Home" ? "first" : key === "End" ? "last" : undefined);
      else setActive(key === "Home" ? moveTacticalOption(options, -1, 1) : key === "End" ? moveTacticalOption(options, 0, -1)
        : moveTacticalOption(options, active, key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (key === "Enter" || (key === " " && (!search.current.text || Date.now() - search.current.time > 700))) {
      event.preventDefault(); event.stopPropagation();
      if (open) choose(active); else show();
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      const now = Date.now();
      const text = now - search.current.time > 700 ? key : search.current.text + key;
      search.current = { text, time: now };
      const repeated = [...text].every(character => character.toLocaleLowerCase() === key.toLocaleLowerCase());
      const query = repeated ? key : text;
      const current = open ? active : selectedIndex;
      const match = findTacticalOption(options, query, query.length === 1 ? current + 1 : current);
      if (match >= 0) {
        if (open) setActive(match);
        else {
          const next = options[match].value;
          if (value == null) setUncontrolledValue(next);
          if (next !== currentValue) onValueChange?.(next);
        }
      }
    }
  }

  useLayoutEffect(() => {
    if (open && unavailable()) close();
  });
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    if (!options[active] || options[active].disabled || options[active].hidden) {
      setActive(selected && !selected.disabled && !selected.hidden ? selectedIndex : moveTacticalOption(options, -1, 1));
    }
    const popup = menu.current;
    const rect = trigger.current.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const width = tacticalSelectPosition(rect, { width: popup.scrollWidth, height: 0 }, viewport).width;
    // Measure wrapped labels at their final width before choosing above/below.
    // Both passes finish before paint and do not depend on position state.
    popup.style.width = `${width}px`;
    popup.style.maxHeight = "none";
    const height = popup.scrollHeight + popup.offsetHeight - popup.clientHeight;
    const next = tacticalSelectPosition(rect, { width, height }, viewport);
    popup.style.maxHeight = `${next.maxHeight}px`;
    setPosition(next);
  }, [open, options]);
  useLayoutEffect(() => {
    if (!open || !position || active < 0 || !menu.current) return;
    const popup = menu.current;
    const item = document.getElementById(optionId(active));
    if (!item) return;
    const itemRect = item.getBoundingClientRect(), menuRect = popup.getBoundingClientRect();
    if (itemRect.top < menuRect.top) popup.scrollTop -= menuRect.top - itemRect.top;
    else if (itemRect.bottom > menuRect.bottom) popup.scrollTop += itemRect.bottom - menuRect.bottom;
  }, [open, active, position]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close();
    }
    function moved(event: Event) {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      close();
    }
    function focusMoved(event: FocusEvent) {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) close();
    }
    const observer = new MutationObserver(() => { if (unavailable()) close(); });
    for (let element: HTMLElement | null = trigger.current; element; element = element.parentElement) {
      if (element === trigger.current || element.tagName === "FIELDSET") observer.observe(element, { attributes: true, attributeFilter: ["disabled"] });
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusMoved);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusMoved);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [open, disabled]);
  useEffect(() => {
    if (value != null) return;
    const owner = trigger.current?.form;
    if (!owner) return;
    const reset = () => setUncontrolledValue(defaultValue == null ? first?.value ?? "" : String(defaultValue));
    owner.addEventListener("reset", reset);
    return () => owner.removeEventListener("reset", reset);
  }, [value, defaultValue, first?.value, form]);

  const menuLabel = buttonProps["aria-label"] ?? (Array.from(trigger.current?.labels ?? []).map(label => label.textContent?.trim()).filter(Boolean).join(" ") || buttonProps.title || "选择选项");
  const renderOption = (index: number) => {
    const option = options[index];
    return <button type="button" id={optionId(index)} key={index} role="option" tabIndex={-1}
      className="tactical-select-option" title={option.title} disabled={option.disabled} aria-selected={index === selectedIndex}
      data-active={index === active || undefined} onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(index)}>
      <span className="tactical-select-option-label">{option.label}</span>
    </button>;
  };
  const visibleGroups: { group: typeof options[number]["group"]; indices: number[] }[] = [];
  options.forEach((option, index) => {
    if (option.hidden) return;
    const last = visibleGroups[visibleGroups.length - 1];
    if (last && last.group === option.group) last.indices.push(index);
    else visibleGroups.push({ group: option.group, indices: [index] });
  });

  return <>
    <button {...buttonProps} id={triggerId} type="button" role="combobox" disabled={disabled} form={form}
      ref={element => { trigger.current = element; if (typeof forwardedRef === "function") forwardedRef(element); else if (forwardedRef) forwardedRef.current = element; }}
      className={`tactical-select-trigger ${className}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? optionId(active) : undefined} onKeyDown={handleKey}
      onPointerDown={event => { onPointerDown?.(event); event.stopPropagation(); }}
      onMouseDown={event => { onMouseDown?.(event); event.stopPropagation(); }}
      onClick={event => { onClick?.(event); if (!event.defaultPrevented) { if (open) close(); else show(); } }}>
      <span className="tactical-select-value">{selected?.label ?? ""}</span><ChevronDown size={12} className="tactical-select-chevron" aria-hidden="true" />
    </button>
    {name && <input type="hidden" name={name} form={form} value={currentValue} disabled={disabled} />}
    {open && createPortal(<div ref={menu} id={listId} className="app-popover tactical-select-menu" role="listbox"
      aria-label={buttonProps["aria-labelledby"] ? undefined : menuLabel} aria-labelledby={buttonProps["aria-labelledby"]}
      style={{ position: "fixed", ...position, visibility: position ? "visible" : "hidden" }}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onPointerUp={event => event.stopPropagation()}
      onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      {visibleGroups.map(({ group, indices }, index) => group
        ? <div role="group" aria-labelledby={`${listId}-group-${group.id}`} className="tactical-select-group" key={index}>
          <div id={`${listId}-group-${group.id}`} className="tactical-select-group-label" title={group.title}>{group.label}</div>{indices.map(renderOption)}
        </div> : <Fragment key={index}>{indices.map(renderOption)}</Fragment>)}
    </div>, document.body)}
  </>;
});
