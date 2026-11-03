// Registration planes follow the actual source bounds.
export function ExternalDragProjection({ source, viewport }: { source: DOMRect | null; viewport: DOMRect }) {
  if (!source) return null;
  const x = source.left - viewport.left, y = source.top - viewport.top;
  const w = source.width, h = source.height;
  return <svg className="external-drag-projection" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true">
    <defs>
      <linearGradient id="projection-edge" x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="currentColor" stopOpacity=".55"/>
        <stop offset="1" stopColor="currentColor" stopOpacity=".05"/>
      </linearGradient>
      <linearGradient id="projection-surface" x1="0" y1="0" x2="1" y2="1">
        <stop stopColor="currentColor" stopOpacity=".045"/>
        <stop offset="1" stopColor="currentColor" stopOpacity="0"/>
      </linearGradient>
    </defs>
    <g className="external-drag-source" fill="none" strokeWidth=".8">
      <path d={`M${x} ${y}h${w}v${h}h-${w}Z`} stroke="url(#projection-edge)"/>
      <path d={`M${x + 12} ${y - 12}l${w} -16v${h}l-${w} 16Z`} fill="url(#projection-surface)" stroke="url(#projection-edge)"/>
      <path d={`M${x} ${y}l12 -12 M${x+w} ${y}l12 -28 M${x+w} ${y+h}l12 -28 M${x} ${y+h}l12 -12`} stroke="currentColor" opacity=".15"/>
      <path className="external-drag-glint" d={`M${x+12} ${y+8}v-20l44 -2.7 M${x+w-20} ${y+h-26}l32 -2v-24`} opacity=".62"/>
      <path d={`M${x-16} ${y+h+24}h36 M${x-8} ${y+h+20}v8 M${x+w-20} ${y-44}h36 M${x+w+8} ${y-48}v8`} stroke="currentColor" opacity=".25"/>
    </g>
  </svg>;
}
