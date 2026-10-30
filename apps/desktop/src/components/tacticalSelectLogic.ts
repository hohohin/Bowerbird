import { Children, Fragment, isValidElement, type ReactNode } from "react";

export interface TacticalOption {
  value: string;
  label: string;
  title?: string;
  disabled: boolean;
  hidden: boolean;
  group?: { id: number; label: string; title?: string };
}

function optionText(node: ReactNode): string {
  return Children.toArray(node).map(child => typeof child === "string" || typeof child === "number"
    ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : "").join("");
}

/** Read the existing option tree without mounting hidden native controls. */
export function parseTacticalOptions(children: ReactNode): TacticalOption[] {
  const options: TacticalOption[] = [];
  let groupId = 0;
  function visit(nodes: ReactNode, group?: TacticalOption["group"], groupDisabled = false) {
    Children.forEach(nodes, child => {
      if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; title?: string; disabled?: boolean; hidden?: boolean }>(child)) return;
      if (child.type === Fragment) { visit(child.props.children, group, groupDisabled); return; }
      if (child.type === "optgroup") {
        visit(child.props.children, { id: groupId++, label: child.props.label ?? "", title: child.props.title }, groupDisabled || !!child.props.disabled);
      } else if (child.type === "option") {
        const text = optionText(child.props.children).replace(/\s+/g, " ").trim();
        options.push({ value: child.props.value == null ? text : String(child.props.value), label: child.props.label ?? text,
          title: child.props.title, disabled: groupDisabled || !!child.props.disabled, hidden: !!child.props.hidden, group });
      }
    });
  }
  visit(children);
  return options;
}

export function moveTacticalOption(options: TacticalOption[], current: number, direction: 1 | -1): number {
  const start = current >= 0 && current < options.length ? current : direction === 1 ? -1 : 0;
  for (let step = 1; step <= options.length; step++) {
    const index = (start + direction * step + options.length) % options.length;
    if (!options[index].disabled && !options[index].hidden) return index;
  }
  return -1;
}

export function findTacticalOption(options: TacticalOption[], query: string, from: number): number {
  const normalized = query.normalize("NFKD").toLocaleLowerCase();
  for (let step = 0; step < options.length; step++) {
    const index = (Math.max(0, from) + step) % options.length;
    const option = options[index];
    if (!option.disabled && !option.hidden && option.label.normalize("NFKD").toLocaleLowerCase().startsWith(normalized)) return index;
  }
  return -1;
}

/** All coordinates are viewport pixels, independent of a transformed canvas. */
export function tacticalSelectPosition(rect: { left: number; top: number; bottom: number; width: number }, content: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 12, gap = 6;
  const width = Math.min(Math.max(rect.width, Math.min(content.width, 360), 160), Math.max(0, viewport.width - margin * 2));
  const preferredHeight = Math.min(content.height, 320, Math.max(0, viewport.height - margin * 2));
  const below = Math.max(0, viewport.height - margin - rect.bottom - gap);
  const above = Math.max(0, rect.top - gap - margin);
  const opensAbove = below < preferredHeight && above > below;
  const maxHeight = Math.min(320, opensAbove ? above : below, Math.max(0, viewport.height - margin * 2));
  const height = Math.min(preferredHeight, maxHeight);
  const top = opensAbove ? rect.top - gap - height : rect.bottom + gap;
  return { left: Math.max(margin, Math.min(rect.left, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(top, viewport.height - height - margin)), width, maxHeight };
}
