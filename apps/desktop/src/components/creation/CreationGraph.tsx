import { useLayoutEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { GraphSource } from "./serialize";

/**
 * 创作板节点图：参考图 → 所选维度 → 输出节点 的可视化（移植自官网 website/app.js + styles.css）。
 * sources 由 useCreationEditor 从 ProseMirror doc 派生，随编辑实时更新。
 *
 * 输出节点为简化形态：只显示「将发送给 {provider}」+ ratio，不嵌结果图
 * （生成结果归独立的 GenerationPanel，不在此重复展示）。
 *
 * 连线在 requestAnimationFrame 里读 handle 的 getBoundingClientRect 画三次贝塞尔曲线
 * （照官网 drawGraphConnections）；canvas 与 handle 同在滚动容器内、滚动时同步位移，
 * 相对坐标不变 → 无需监听 scroll，只用 ResizeObserver 兜尺寸变化。
 */
export function CreationGraph({
  sources,
}: {
  sources: GraphSource[];
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const dimensionCount = sources.reduce((n, s) => n + s.dimensions.length, 0);

  useLayoutEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      const svg = svgRef.current;
      if (!canvas || !svg) return;
      const outputHandle = canvas.querySelector(".graph-output-handle");
      if (!canvas.clientWidth || !canvas.clientHeight || !outputHandle) return;

      const canvasRect = canvas.getBoundingClientRect();
      const outputRect = outputHandle.getBoundingClientRect();
      const outputX = outputRect.left + outputRect.width / 2 - canvasRect.left;
      const outputY = outputRect.top + outputRect.height / 2 - canvasRect.top;
      svg.setAttribute("viewBox", `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
      svg.replaceChildren();

      canvas.querySelectorAll(".graph-dimension-handle").forEach((handle) => {
        const r = (handle as HTMLElement).getBoundingClientRect();
        const sourceX = r.left + r.width / 2 - canvasRect.left;
        const sourceY = r.top + r.height / 2 - canvasRect.top;
        const bend = Math.max(24, (outputX - sourceX) * 0.48);
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute(
          "d",
          `M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${outputX - bend} ${outputY}, ${outputX} ${outputY}`
        );
        svg.appendChild(path);
      });
    };

    // rAF 确保 DOM 布局完成后读坐标；sources / ratio / provider 变化都重画。
    const raf = window.requestAnimationFrame(draw);
    // canvas 尺寸变化（节点增减导致高度变、窗口宽度变）→ 重画。
    const ro = new ResizeObserver(() => window.requestAnimationFrame(draw));
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [sources]);

  return (
    <div className="creation-graph-panel">
      <div className="graph-heading">
        <small>生成关系图</small>
        <span>
          {sources.length} 图 · {dimensionCount} 维度
        </span>
      </div>
      <div className="creation-graph" ref={canvasRef}>
        <svg className="graph-connections" ref={svgRef} aria-hidden="true" />
        <div className="graph-source-list">
          {sources.length === 0 ? (
            <article className="graph-node graph-source-node is-empty">
              <span className="graph-node-kicker">IMAGE INPUT</span>
              <strong>添加一张参考图</strong>
            </article>
          ) : (
            sources.map((source, index) => {
              const dims = source.dimensions;
              const visibleDims = dims.length ? dims : ["整图参考"];
              const thumb = source.asset.thumb_path || source.asset.store_path;
              return (
                <article
                  className="graph-node graph-source-node"
                  key={source.asset.id}
                  data-asset-id={source.asset.id}
                >
                  <span className="graph-node-kicker">
                    IMAGE INPUT {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="graph-source-main">
                    <div className="graph-source-identity">
                      <img
                        src={thumb ? convertFileSrc(thumb) : undefined}
                        alt=""
                      />
                      <strong>{source.asset.name}</strong>
                    </div>
                    <div className="graph-dimension-nodes">
                      {visibleDims.map((title) => (
                        <div
                          className={`graph-dimension-node${dims.length ? "" : " is-reference"}`}
                          key={title}
                        >
                          <span>{title}</span>
                          <span
                            className="graph-handle graph-dimension-handle"
                            aria-hidden="true"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
        <article className="graph-node graph-output-node">
          <span className="graph-handle graph-output-handle" aria-hidden="true" />
          <span className="graph-node-kicker">IMAGE OUTPUT</span>
          <div className="graph-output-preview">
            <span>✦</span>
          </div>
          <strong>生成新图</strong>
          <small>等待节点输入</small>
        </article>
      </div>
    </div>
  );
}
