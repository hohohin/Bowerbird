/** Painted indicator properties; ignores inherited text styles on empty frames. */
export function indicatorSignature(scope) {
  return scope.evaluate(root => {
    const frame = root.querySelector('.creation-mode-indicator-frame, .canvas-creation-mode-frame, .ring-2[aria-hidden="true"]');
    const label = root.querySelector('.creation-mode-indicator-label, .creation-mode-notch');
    if (!frame || !label) return null;
    const pick = (element, keys, pseudo) => { const style = getComputedStyle(element, pseudo); return Object.fromEntries(keys.map(key => [key, style[key]])); };
    const decoration = ['content','top','right','bottom','left','backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat'];
    return {
      frame: pick(frame, ['boxShadow','backgroundColor','backgroundImage','borderTopWidth']),
      before: pick(frame, decoration, '::before'), after: pick(frame, decoration, '::after'),
      label: pick(label, ['color','backgroundColor','padding','fontSize','fontWeight','letterSpacing','lineHeight','borderRadius','boxShadow']),
      labelBefore: pick(label, ['content','width','height','backgroundColor','boxShadow'], '::before'),
    };
  });
}
