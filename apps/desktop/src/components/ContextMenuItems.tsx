import { Fragment, type ReactNode } from "react";
import type { MenuItemDescriptor } from "../lib/contextMenuModel";
import { ContextSubmenu } from "./ContextMenu";

export function ContextMenuItems<Action extends string, Icon extends string, Slot extends string = never>({ items, icons, slots, onSelect }: {
  items: readonly MenuItemDescriptor<Action, Icon, Slot>[];
  icons: Record<Icon, ReactNode>;
  slots?: Record<Slot, ReactNode>;
  onSelect: (id: Action) => void;
}) {
  return <>{items.map(item => {
    if (item.kind === "divider") return <div key={item.id} className="app-context-divider" />;
    if (item.kind === "slot") return <Fragment key={item.id}>{slots?.[item.id]}</Fragment>;
    const icon = item.icon && icons[item.icon];
    const disabled = item.disabled || !!item.disabledReason;
    const title = item.disabledReason ?? item.title;
    if (item.kind === "submenu") return <ContextSubmenu key={item.id} label={item.label} icon={icon}
      disabled={disabled} disabledReason={item.disabledReason} title={title} menuLabel={item.menuLabel}>
      <ContextMenuItems items={item.items} icons={icons} slots={slots} onSelect={onSelect} />
    </ContextSubmenu>;
    return <button key={item.id} type="button" role={item.kind === "action" ? "menuitem" : `menuitem${item.kind}`}
      aria-checked={item.kind === "action" ? undefined : item.checked}
      aria-label={item.ariaLabel ?? (item.disabledReason ? item.label : undefined)} aria-description={item.disabledReason} data-tour={item.tour}
      disabled={disabled} title={title} className={`app-context-item px-2 py-1.5${item.danger ? " is-danger" : ""}`}
      onClick={() => onSelect(item.id)}>
      {icon}
      <span>{item.label}{item.disabledReason && <small className="context-menu-reason">{item.disabledReason}</small>}</span>
    </button>;
  })}</>;
}
