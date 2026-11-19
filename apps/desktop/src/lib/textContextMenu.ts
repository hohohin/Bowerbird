/** Give text editing and selected reading text the WebView's native edit menu. */
export function installTextContextMenu() {
  const contextMenu = (event: MouseEvent) => {
    const target = event.composedPath().find(item => item instanceof Element) as Element | undefined;
    if (!target) return;
    const field = target.closest("input, textarea");
    const textField = field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement
      && ["text", "search", "email", "url", "tel", "password", "number"].includes(field.type);
    const editable = target instanceof HTMLElement && target.isContentEditable;
    const selection = window.getSelection();
    let selectedText = false;
    if (selection && !selection.isCollapsed && selection.toString()) {
      for (let index = 0; index < selection.rangeCount && !selectedText; index++) {
        const range = selection.getRangeAt(index);
        selectedText = range.intersectsNode(target) && [...range.getClientRects()].some(rect =>
          event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom);
      }
    }
    if (textField || editable || selectedText) {
      // Stop card/React/Plate handlers, but keep the default native copy/cut/paste action.
      event.stopImmediatePropagation();
    }
  };
  window.addEventListener("contextmenu", contextMenu, true);
  return () => window.removeEventListener("contextmenu", contextMenu, true);
}
