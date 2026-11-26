export function isImeKeyEvent(event: Pick<KeyboardEvent, "isComposing" | "keyCode">) {
  return event.isComposing || event.keyCode === 229;
}

/** Preserve native editing shortcuts, including IME events reported with keyCode 229. */
export function isEditableTarget(target: EventTarget | null) {
  return target instanceof Element && (
    (target instanceof HTMLElement && target.isContentEditable)
    || !!target.closest('input, textarea, select, [role="combobox"], [role="textbox"]')
  );
}

export function isEditableKeyTarget(event: Pick<KeyboardEvent, "target" | "isComposing" | "keyCode">) {
  return isImeKeyEvent(event) || isEditableTarget(event.target);
}
