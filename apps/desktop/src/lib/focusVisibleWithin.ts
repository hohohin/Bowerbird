/** Mirror keyboard-visible focus on a control group without invalidating unrelated descendants. */
export function trackFocusVisibleWithin(group: HTMLElement) {
  const sync = () => group.toggleAttribute("data-keyboard-focus", !!group.querySelector(":focus-visible"));
  const blur = () => group.removeAttribute("data-keyboard-focus");
  const events = ["focusin", "keydown", "pointerup"] as const;
  for (const event of events) group.addEventListener(event, sync);
  group.addEventListener("focusout", blur);
  sync();
  return () => {
    for (const event of events) group.removeEventListener(event, sync);
    group.removeEventListener("focusout", blur);
    group.removeAttribute("data-keyboard-focus");
  };
}
