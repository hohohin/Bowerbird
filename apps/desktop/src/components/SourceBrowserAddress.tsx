import { CircleAlert, LockKeyhole } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { normalizeSourceAddress } from "../lib/sourceDiscovery";

export function SourceBrowserAddress({ input, url, history, onNavigate }: {
  input: RefObject<HTMLInputElement>; url: string; history: string[]; onNavigate: (url: string) => void;
}) {
  const listId = useId();
  const focused = useRef(false);
  const [address, setAddress] = useState(url);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const choices = history.filter(item => item.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6);
  const expanded = open && choices.length > 0;
  const optionId = (index: number) => `${listId}-${index}`;
  const selectedId = expanded && choices[active] ? optionId(active) : undefined;
  const secure = /^https:/i.test(url);
  const protocol = secure ? "HTTPS 加密连接" : "HTTP 未加密连接";

  useEffect(() => {
    if (!focused.current) setAddress(url);
  }, [url]);
  useEffect(() => {
    if (selectedId) document.getElementById(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function choose(value: string) {
    const normalized = normalizeSourceAddress(value);
    if (normalized) setAddress(normalized);
    close();
    input.current?.blur();
    onNavigate(value);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    choose((expanded && choices[active]) || address);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (expanded && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (choices.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setOpen(true);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActive(current => current < 0 ? (direction === 1 ? 0 : choices.length - 1)
        : (current + direction + choices.length) % choices.length);
    }
  }

  return <>
    <form className="source-browser-address" onSubmit={submit}>
      <span role="img" aria-label={protocol} title={protocol}>
        {secure ? <LockKeyhole size={12} aria-hidden /> : <CircleAlert size={12} aria-hidden />}
      </span>
      <input ref={input} role="combobox" aria-label="网页地址" aria-autocomplete="list" aria-controls={listId}
        aria-expanded={expanded} aria-activedescendant={selectedId} autoComplete="off" spellCheck={false}
        value={address} onKeyDown={keyDown}
        onChange={event => {
          setAddress(event.target.value);
          setQuery(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={event => {
          focused.current = true;
          event.currentTarget.select();
          setQuery("");
        }}
        onBlur={() => { focused.current = false; close(); }} />
    </form>
    <ul id={listId} role="listbox" aria-label="最近访问" className="source-browser-address-history app-popover" hidden={!expanded}>
      {expanded && choices.map((item, index) =>
        <li id={optionId(index)} key={item} role="option" aria-selected={index === active}
          onPointerDown={event => event.preventDefault()} onClick={() => choose(item)} title={item}>
          <span>{new URL(item).hostname}</span><small>{item}</small>
        </li>)}
    </ul>
  </>;
}
