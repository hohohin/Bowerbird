interface FrameProps {
  x: number; y: number; width: number; height: number; index: number; total: number;
}

export function WorkflowLoopFrame({ x, y, width, height, index, total }: FrameProps) {
  const corner = "M0 22V9l9-9h45";
  return <div aria-hidden="true" className="workflow-loop-frame" style={{ left: x, top: y, width, height }}>
    <svg width="100%" height="100%" fill="none" stroke="#74a6ce">
      <path d={corner} />
      <path transform={`translate(${width} ${height}) rotate(180)`} d={corner} />
      <path d={`M${width - 29} 0h29v12 M0 ${height - 12}v12h29`} />
      <g key={index} className="loop-frame-lock" stroke="#b9e2ff">
        <path d="M3 16v-5l7-7h17" />
        <path transform={`translate(${width} ${height}) rotate(180)`} d="M3 16v-5l7-7h17" />
        <path d={`M-4 ${height / 2 - 4}l4 4-4 4`} />
        <rect x={width - 3} y={height / 2 - 3} width="6" height="6" fill="#b7e1ff" stroke="#589ac6" />
      </g>
    </svg>
    <span>{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
  </div>;
}
