import { userErrorMessage } from "../lib/userError";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Maximize, Minus, Plus } from "lucide-react";
import { materialCatalog, type CatalogFilter, type CatalogGraphAsset } from "../lib/materialCatalog";
import { buildMaterialGraph, fitGraph, zoomGraph, GRAPH_MIN_ZOOM, type GraphCamera, type GraphNode, type GraphPoint } from "../lib/materialGraph";
import type { CatalogSectionInfo } from "../lib/catalogVirtualLayout";
import "./MaterialGraph.css";

type Props = { sections: CatalogSectionInfo[]; total: number; active: string | null; filter: CatalogFilter; revision: number; focusRequest: number;
  onNavigate: (id: string | null) => void; onPreview: (asset: CatalogGraphAsset) => void; onDetail: (asset: CatalogGraphAsset) => void };

export function MaterialGraph(props: Props) {
  return <GraphView key={JSON.stringify(props.filter)} {...props}/>;
}

function GraphView({ sections, total, active, filter, revision, focusRequest, onNavigate, onPreview, onDetail }: Props) {
  const surface = useRef<SVGSVGElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const clipId = useId().replace(/:/g, "");
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [camera, setCamera] = useState<GraphCamera>({ x: 400, y: 300, scale: 1 });
  const [positions, setPositions] = useState<Record<string, GraphPoint>>({});
  const [distance, setDistance] = useState(() => {
    try { const value = Number(localStorage.getItem("bowerbird.graph.distance")); return value >= 50 && value <= 200 ? value : 100; } catch { return 100; }
  });
  const [assets, setAssets] = useState<CatalogGraphAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [themeVersion, setThemeVersion] = useState(0);
  const fitted = useRef(false);
  const focusRef = useRef({ active, focusRequest });
  const gesture = useRef<{ pointer: number; x: number; y: number; camera: GraphCamera; node?: GraphNode; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    let alive = true;
    setLoading(true); setLoaded(0); setError("");
    void (async () => {
      const all = new Map<string, CatalogGraphAsset>();
      let after: string | null = null;
      try {
        do {
          const batch = await materialCatalog.graphPage(filter, after);
          if (!alive) return;
          for (const asset of batch.assets) all.set(asset.id, asset);
          setLoaded(all.size);
          if (batch.after !== null && (batch.after === after || !batch.assets.length)) throw new Error("图谱读取未能继续，请重试");
          after = batch.after;
        } while (after !== null);
        setAssets([...all.values()]);
        setSelectedId(previous => previous && all.has(previous) ? previous : null);
        setFailedImages(new Set());
      } catch (reason) { if (alive) setError(String(reason)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [filter, revision, retry]);
  const graph = useMemo(() => buildMaterialGraph(assets, sections), [assets, sections]);
  const rendered = useMemo(() => graph.nodes.map(node => {
    const point = positions[node.id] ?? node;
    return { ...node, x: point.x * distance / 100, y: point.y * distance / 100 };
  }), [graph.nodes, positions, distance]);
  const selected = assets.find(asset => asset.id === selectedId);
  const highlight = focused ?? (selectedId ? `asset:${selectedId}` : active ? `tag:${active}` : null);
  const visible = useMemo(() => rendered.filter(node => {
    const x = node.x * camera.scale + camera.x, y = node.y * camera.scale + camera.y;
    return x > -100 && x < size.width + 100 && y > -100 && y < size.height + 100;
  }), [rendered, camera, size]);
  const visibleAssets = useMemo(() => visible.filter(node => node.asset), [visible]);
  // Every identity and edge stays in the graph. Only visible thumbnails enter
  // the DOM; large zoomed-out graphs use dots instead of decoding every image.
  const detailed = visibleAssets.length <= 400 && camera.scale >= .12;
  const svgNodes = useMemo(() => visible.filter(node => !node.asset || detailed || node.asset.id === selectedId)
    .sort((a, b) => Number(!!b.asset) - Number(!!a.asset)), [visible, detailed, selectedId]);
  const detailedIds = useMemo(() => new Set(svgNodes.filter(node => node.asset).map(node => node.id)), [svgNodes]);
  useLayoutEffect(() => {
    const svg = surface.current!;
    const observer = new ResizeObserver(() => setSize({ width: svg.clientWidth, height: svg.clientHeight }));
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!loading && !error && !fitted.current && size.width > 0) {
      setCamera(fitGraph(rendered, size.width, size.height)); fitted.current = true;
    }
  }, [loading, error, rendered, size]);
  useEffect(() => {
    if (focusRef.current.active === active && focusRef.current.focusRequest === focusRequest) return;
    focusRef.current = { active, focusRequest }; setSelectedId(null);
    const node = rendered.find(node => node.tagId === active);
    if (node) focusNode(node);
  }, [active, focusRequest, rendered, size]);
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeVersion(value => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = canvas.current!, context = element.getContext("2d");
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    element.width = Math.round(size.width * dpr); element.height = Math.round(size.height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(element);
    const accent = style.getPropertyValue("--bb-blue").trim(), muted = style.getPropertyValue("--bb-muted").trim();
    const point = (node: GraphPoint) => ({ x: node.x * camera.scale + camera.x, y: node.y * camera.scale + camera.y });
    const lines = (emphasized: boolean) => {
      context.beginPath();
      for (const edge of graph.edges) {
        const source = rendered[edge.source], target = rendered[edge.target];
        if ((source.id === highlight || target.id === highlight) !== emphasized) continue;
        const a = point(source), b = point(target);
        if (Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > size.width || Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > size.height) continue;
        context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
      }
      context.strokeStyle = emphasized ? accent : muted; context.globalAlpha = emphasized ? .8 : .25;
      context.lineWidth = emphasized ? 1.4 : .7; context.stroke();
    };
    lines(false); if (highlight) lines(true);
    context.fillStyle = muted; context.globalAlpha = .8; context.beginPath();
    for (const node of visibleAssets) {
      if (detailedIds.has(node.id)) continue;
      const p = point(node), radius = Math.max(1.5, Math.min(4, 16 * camera.scale));
      context.moveTo(p.x + radius, p.y); context.arc(p.x, p.y, radius, 0, Math.PI * 2);
    }
    context.fill(); context.globalAlpha = 1;
  }, [graph.edges, rendered, camera, size, highlight, themeVersion, detailedIds, visibleAssets]);
  useEffect(() => {
    const svg = surface.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      setCamera(value => zoomGraph(value, { x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-Math.max(-200, Math.min(200, delta)) * .003)));
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [size.height]);
  function fit() { setCamera(fitGraph(rendered, size.width, size.height)); }
  function focusNode(node: GraphNode) { setCamera({ scale: 1.2, x: size.width / 2 - node.x * 1.2, y: size.height / 2 - node.y * 1.2 }); }
  function zoom(factor: number) { setCamera(value => zoomGraph(value, { x: size.width / 2, y: size.height / 2 }, factor)); }
  function changeDistance(next: number) {
    const ratio = next / distance;
    setDistance(next);
    // Keep the world point under the viewport center fixed while spacing changes.
    setCamera(value => ({ ...value, x: size.width / 2 - (size.width / 2 - value.x) * ratio, y: size.height / 2 - (size.height / 2 - value.y) * ratio }));
    try { localStorage.setItem("bowerbird.graph.distance", String(next)); } catch { /* Session preference remains available. */ }
  }
  function activate(node: GraphNode) {
    if (node.asset) setSelectedId(node.asset.id);
    else { onNavigate(node.tagId!); setSelectedId(null); focusNode(node); }
  }
  function hit(clientX: number, clientY: number) {
    const rect = surface.current!.getBoundingClientRect();
    let nearest: GraphNode | undefined, distance = 10;
    for (const node of visibleAssets) {
      const delta = Math.hypot(node.x * camera.scale + camera.x - clientX + rect.left, node.y * camera.scale + camera.y - clientY + rect.top);
      if (delta < distance) { nearest = node; distance = delta; }
    }
    return nearest;
  }
  return <div className="material-graph" data-total-assets={assets.length} data-total-edges={graph.edges.length} data-distance={distance}>
    <div className="material-graph-heading"><div><strong>分类图谱</strong><span>{assets.length.toLocaleString()} / {total.toLocaleString()} 张素材 · {sections.length} 个分类</span></div>
      <p>所有分类在同一张图中 · 一张图片连接它的全部标签</p></div>
    <canvas ref={canvas} className="material-graph-canvas" aria-hidden="true"/>
    <svg ref={surface} className="material-graph-surface" role="group" aria-label="分类素材关系图，方向键平移，加减号缩放，0 适应画面" tabIndex={0}
      onKeyDown={event => {
        if (event.key === "Tab") { event.stopPropagation(); return; }
        if (event.target !== event.currentTarget) return;
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0", "Escape"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
        if (event.key === "0") fit();
        if (event.key === "+" || event.key === "=") zoom(1.2);
        if (event.key === "-") zoom(1 / 1.2);
        if (event.key === "Escape") { setSelectedId(null); onNavigate(null); }
        const delta: Record<string, GraphPoint> = { ArrowLeft: { x: 50, y: 0 }, ArrowRight: { x: -50, y: 0 }, ArrowUp: { x: 0, y: 50 }, ArrowDown: { x: 0, y: -50 } };
        if (delta[event.key]) setCamera(value => ({ ...value, x: value.x + delta[event.key].x, y: value.y + delta[event.key].y }));
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        const id = (event.target as Element).closest('[data-graph-node]')?.getAttribute('data-graph-node');
        const node = id ? rendered.find(node => node.id === id) : hit(event.clientX, event.clientY);
        gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, camera, node, moved: false };
        suppressClick.current = false;
        const capture = (event.target as Element).closest<SVGElement>('[data-graph-node]') ?? event.currentTarget;
        capture.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = gesture.current;
        if (!start || start.pointer !== event.pointerId) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.hypot(dx, dy) > 4) start.moved = true;
        if (!start.moved) return;
        if (start.node) { const node = start.node; setPositions(previous => ({ ...previous, [node.id]: { x: (node.x + dx / start.camera.scale) * 100 / distance, y: (node.y + dy / start.camera.scale) * 100 / distance } })); }
        else setCamera({ ...start.camera, x: start.camera.x + dx, y: start.camera.y + dy });
      }}
      onPointerUp={event => {
        const start = gesture.current;
        if (!start || start.pointer !== event.pointerId) return;
        suppressClick.current = start.moved; gesture.current = null;
        if (!start.moved && start.node) activate(start.node);
      }}
      onDoubleClick={event => { const node = hit(event.clientX, event.clientY); if (node?.asset && !suppressClick.current) onPreview(node.asset); }}
      onPointerCancel={() => { gesture.current = null; suppressClick.current = true; }} onLostPointerCapture={() => { gesture.current = null; }}>
      <defs><clipPath id={`${clipId}-thumb`}><rect x={-28} y={-28} width={56} height={56} rx={12}/></clipPath></defs>
      <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`} data-graph-camera>
        {svgNodes.map(node => {
          const isSelected = (node.asset && selectedId === node.asset.id) || (node.tagId !== undefined && active === node.tagId);
          const labelScale = Math.max(1, .7 / camera.scale);
          const tagWidth = Math.max(90, Math.min(190, [...node.name].length * 16 + 30));
          return <g key={node.id} data-graph-node={node.id} data-asset-id={node.asset?.id} data-tag-id={node.tagId} role="button" tabIndex={0}
            aria-label={node.asset ? `查看素材：${node.name}` : `定位分类：${node.name}，${node.count} 张素材`}
            className={`material-graph-node${node.asset ? " is-asset" : " is-tag"}${isSelected ? " is-selected" : ""}`}
            transform={`translate(${node.x} ${node.y})`} onMouseEnter={() => setFocused(node.id)} onMouseLeave={() => setFocused(null)} onFocus={() => setFocused(node.id)} onBlur={() => setFocused(null)}
            onClick={event => { if (event.detail === 0) activate(node); }}
            onDoubleClick={event => { event.stopPropagation(); if (node.asset && !suppressClick.current) onPreview(node.asset); }}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); activate(node); }
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSelectedId(null); onNavigate(null); surface.current?.focus(); }
            }}><title>{node.name}{node.count !== undefined ? ` · ${node.count} 张素材` : ""}</title>
            {node.asset ? <><rect className="material-graph-thumb" x={-30} y={-30} width={60} height={60} rx={14}/>
              {node.asset.thumb_path && !failedImages.has(node.id) ? <image href={convertFileSrc(node.asset.thumb_path)} x={-28} y={-28} width={56} height={56} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId}-thumb)`}
                onError={() => setFailedImages(previous => new Set([...previous, node.id]))}/> : <text className="material-graph-placeholder" textAnchor="middle" y={5}>图片</text>}
              {(focused === node.id || isSelected) && <text className="material-graph-label" textAnchor="middle" style={{ fontSize: Math.max(14, 12 / camera.scale), strokeWidth: 3 / camera.scale }} y={30 + 22 / camera.scale}>{[...node.name].slice(0, 12).join("")}{[...node.name].length > 12 ? "…" : ""}</text>}</>
              : <g transform={`scale(${labelScale})`}><rect className="material-graph-tag" x={-tagWidth / 2} y={-22} width={tagWidth} height={44} rx={22}/>
                <text className="material-graph-tag-name" textAnchor="middle" y={5}>{[...node.name].slice(0, 10).join("")}{[...node.name].length > 10 ? "…" : ""}</text>
                <text className="material-graph-count" textAnchor="middle" y={40}>{node.count?.toLocaleString()} 张</text></g>}
          </g>;
        })}
      </g>
    </svg>
    {(loading || error || !assets.length) && <div className="material-graph-status" role={error ? "alert" : "status"}>{error ? <>图谱读取失败 <button title={userErrorMessage(error, "素材图谱暂时无法读取，请重试。")} onClick={() => setRetry(value => value + 1)}>重试</button></> : loading ? `正在读取图谱 ${loaded.toLocaleString()} / ${total.toLocaleString()}…` : "没有匹配的素材"}</div>}
    {selected && <div className="material-graph-selection" aria-label="图谱所选素材"><strong title={selected.name}>{selected.name}</strong>
      <button onClick={() => onPreview(selected)}>预览</button><button onClick={() => onDetail(selected)}>详情</button><button onClick={() => setSelectedId(null)} aria-label="取消图谱选择">取消</button></div>}
    <div className="material-graph-footer">
      <div className="material-graph-zoom" role="group" aria-label="图谱视角"><button aria-label="缩小图谱" onClick={() => zoom(1 / 1.2)} disabled={camera.scale <= GRAPH_MIN_ZOOM}><Minus size={16}/></button>
        <output aria-label="图谱缩放比例">{Math.round(camera.scale * 100)}%</output><button aria-label="放大图谱" onClick={() => zoom(1.2)} disabled={camera.scale >= 3}><Plus size={16}/></button>
        <button aria-label="适应图谱" title="适应图谱（0）" onClick={fit}><Maximize size={16}/></button></div>
      <span className="material-graph-legend">拖动平移 · 滚轮缩放 · 点击标签定位</span>
      <label className="material-graph-distance"><span>连线长度</span><input type="range" min={50} max={200} step={5} value={distance} aria-label="图谱连线长度" aria-valuetext={`${distance}%`}
        onChange={event => changeDistance(Number(event.target.value))}/><output>{distance}%</output></label>
    </div>
  </div>;
}
