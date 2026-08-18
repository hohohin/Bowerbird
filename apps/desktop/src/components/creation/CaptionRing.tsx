import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { CaptionSection } from "../../lib/types";

/**
 * 维度环形菜单（radial menu）：点瀑布流图片拾取 / 长按图片窥视后，在该卡片四周呼出其反推维度环。
 * 扇形（pie sector）菜单 = 以卡片为圆心的 SVG：每个维度一个扇区（角缝分隔），label 水平
 * 居中于扇区质心；点扇区 → insertKeyword 插入编辑框（环保持打开，已选扇区打 ✓ 变淡）。
 * 展开动画 = 扇区自中心旋出 + 按角度错峰绽放；收起 = 整环收拢淡出后再卸载。
 *
 * 遮罩挖两个洞（环圈 + 编辑框）：mask = 外扩视口矩形 + 两洞的 evenodd 路径经 feGaussianBlur
 * 羽化——洞内（目标图片、编辑框）不压暗不模糊且边缘渐变过渡，洞外 backdrop blur + 半透明压暗。
 * 编辑框可点可输入（挪光标定位插入点）；目标图片被透明圆形点击区盖住，再点 = 收起。
 *
 * 收起手势：Esc / 点遮罩 / 再点目标图片 / 右键 / 窗口缩放 / 鼠标移出环一定距离（编辑框区域
 * 除外）/ 直接输入文字。环顶部上方的小字胶囊说明这些手势。无维度的图（长按窥视）呼出空环，
 * 小字提示可右键反推。tour 激活时 suppressScrim（tour 自带聚光灯），且距离/输入收起不生效
 * （避免引导中环意外消失）。
 *
 * 定位沿 AssetContextMenu / BoardChipPreview 范式：portal 到 body + fixed 坐标；
 * z-65/66 占用上下文菜单(60)与 tour/Popover(70) 之间的空档，保证 tour 聚光灯在最上层。
 */

type Geometry = {
  cx: number;
  cy: number;
  innerR: number; // 环内半径（卡片外一圈）
  outerR: number; // 环外半径（扇区外缘）
  vw: number;
  vh: number;
  card: { x: number; y: number; w: number; h: number };
  editor: { x: number; y: number; w: number; h: number } | null;
};

const pt = (r: number, a: number) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;

// 扇区：内弧 → 外弧 → 外弧段 → 内弧段闭合。y 轴向下，角度增大即顺时针，外弧 sweep=1。
function wedgePath(r0: number, r1: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return (
    `M ${pt(r0, a0)} L ${pt(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${pt(r1, a1)}` +
    ` L ${pt(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)} Z`
  );
}

// 单维度退化成整圈甜甜圈（双圆 evenodd）。
function donutPath(r0: number, r1: number): string {
  return (
    `M ${r1} 0 A ${r1} ${r1} 0 1 1 ${-r1} 0 A ${r1} ${r1} 0 1 1 ${r1} 0 Z ` +
    `M ${r0} 0 A ${r0} ${r0} 0 1 0 ${-r0} 0 A ${r0} ${r0} 0 1 0 ${r0} 0 Z`
  );
}

function circlePath(cx: number, cy: number, r: number): string {
  return `M ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} Z`;
}

function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} ` +
    `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
    `V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`
  );
}

// remeasure 的无变化守卫用：编辑框矩形逐字段相等（null 与 null 也相等）。
function sameRect(
  a: Geometry["editor"],
  b: Geometry["editor"]
): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// 遮罩 = 「外扩视口矩形 + 环圈圆 + 编辑框圆角矩形」的 evenodd 路径整体高斯模糊：
// 形状外 alpha≈1（显示遮罩 = 压暗模糊），两洞内 0（挖洞），洞缘按 σ 羽化。外框外扩 40px，
// 让它的羽化边落在视口外，屏幕四边不会出现渐隐。mask 同时作用于背景色与 backdrop-filter 输出。
function buildMaskImage(g: Geometry): string {
  const pad = 40;
  const ed = g.editor
    ? roundRectPath(g.editor.x - 12, g.editor.y - 12, g.editor.w + 24, g.editor.h + 24, 8)
    : "";
  const d =
    `M ${-pad} ${-pad} H ${g.vw + pad} V ${g.vh + pad} H ${-pad} Z ` +
    `${circlePath(g.cx, g.cy, g.outerR + 14)} ${ed}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.vw}" height="${g.vh}">` +
    `<defs><filter id="f" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="9"/></filter></defs>` +
    `<path d="${d}" fill="black" fill-rule="evenodd" filter="url(#f)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function CaptionRing(props: {
  assetId: string;
  sections: CaptionSection[];
  editorHostRef: RefObject<HTMLDivElement | null>;
  suppressScrim?: boolean;
  onClose: () => void;
  onPick: (section: CaptionSection) => void;
}) {
  const { assetId, sections, editorHostRef, suppressScrim, onClose, onPick } = props;
  const [geom, setGeom] = useState<Geometry | null>(null);
  const [used, setUsed] = useState<Set<string>>(() => new Set());
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);

  // 收起走动画：先播 ~180ms 收拢淡出，再真正卸载。期间忽略重复收起与重测。
  const requestClose = useCallback(() => {
    if (closeRef.current) return;
    closeRef.current = true;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 180);
  }, [onClose]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    []
  );

  // 挂载即测量（layout 阶段，避免首帧闪位）。卡片 DOM 由 MasonryGrid 提供（id=asset-*）。
  // 滚动时也走这里重测（环跟随图片/编辑框移动）：插入 keyword 会 scrollIntoView 滚动面板，
  // 若滚动即收起会让环在加第一个维度时就意外关闭；元素不在了才收起。
  const remeasure = useCallback(() => {
    if (closeRef.current) return;
    // 锚点：优先瀑布流卡片（点图拾取 / 长按窥视）；标注注入的临时图不在瀑布流，
    // 回退到编辑框内该资产的 image chip（data-asset-id），环围绕刚插入的 chip 呼出。
    const anchor =
      document.getElementById(`asset-${assetId}`) ??
      document.querySelector(`[data-asset-id="${CSS.escape(assetId)}"]`);
    const card = anchor?.getBoundingClientRect();
    if (!card || !card.width) {
      requestClose();
      return;
    }
    const ed = editorHostRef.current?.getBoundingClientRect() ?? null;
    const edRect = ed ? { x: ed.left, y: ed.top, w: ed.width, h: ed.height } : null;
    const cx = card.left + card.width / 2;
    const cy = card.top + card.height / 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const innerR = Math.max(card.width, card.height) / 2 + 16;
    const desired = innerR + 68;
    // 尽量让整环落进视口（圆心到四边留 14px）；实在放不下（图太大/太贴边）保底环厚 48，允许溢出裁切。
    const fit = Math.min(cx, cy, vw - cx, vh - cy) - 14;
    const outerR = Math.max(Math.min(desired, fit), innerR + 48);
    setGeom((prev) => {
      // scroll 监听是捕获模式，任何容器滚动都触发重测；值没变时返回 prev，
      // 避免 mask SVG 重建 / pointermove 监听重挂 / 整组件重渲。
      if (
        prev &&
        prev.cx === cx &&
        prev.cy === cy &&
        prev.innerR === innerR &&
        prev.outerR === outerR &&
        prev.vw === vw &&
        prev.vh === vh &&
        prev.card.x === card.left &&
        prev.card.y === card.top &&
        prev.card.w === card.width &&
        prev.card.h === card.height &&
        sameRect(prev.editor, edRect)
      ) {
        return prev;
      }
      return {
        cx,
        cy,
        innerR,
        outerR,
        vw,
        vh,
        card: { x: card.left, y: card.top, w: card.width, h: card.height },
        editor: edRect,
      };
    });
  }, [assetId, editorHostRef, requestClose]);

  useLayoutEffect(() => {
    remeasure();
  }, [remeasure]);

  // 收起：Esc / 直接输入文字（不拦截，按键落进编辑框）/ 窗口缩放（几何整体失效）/ 右键
  // （先收环再出菜单，避免菜单 z-60 压在环层 z-66 下面）。遮罩与洞内点击区的收起见各自
  // onClick；滚动不收起、只重测跟随。tour 期间只有 Esc 生效（防环在引导中意外消失）。
  useLayoutEffect(() => {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", remeasure, true);
    window.addEventListener("resize", requestClose);
    window.addEventListener("contextmenu", requestClose, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", remeasure, true);
      window.removeEventListener("resize", requestClose);
      window.removeEventListener("contextmenu", requestClose, true);
    };
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        requestClose();
        return;
      }
      if (suppressScrim) return;
      // 可打印字符 = 用户在直接输入（编辑框在拾取后已聚焦）→ 收起环让位
      if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) requestClose();
    }
  }, [requestClose, remeasure, suppressScrim]);

  // 鼠标移出环一定距离即收起。编辑框区域豁免：用户常移过去挪光标/继续输入。
  useLayoutEffect(() => {
    if (!geom || suppressScrim) return;
    const threshold = geom.outerR + 120;
    const onMove = (e: PointerEvent) => {
      if (closeRef.current) return;
      const dx = e.clientX - geom.cx;
      const dy = e.clientY - geom.cy;
      if (dx * dx + dy * dy <= threshold * threshold) return;
      const ed = geom.editor;
      if (
        ed &&
        e.clientX >= ed.x - 12 &&
        e.clientX <= ed.x + ed.w + 12 &&
        e.clientY >= ed.y - 12 &&
        e.clientY <= ed.y + ed.h + 12
      ) {
        return;
      }
      requestClose();
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [geom, requestClose, suppressScrim]);

  const maskImage = useMemo(() => (geom ? buildMaskImage(geom) : null), [geom]);

  // 扇区按正上方起均布，质心放 label；相邻扇区留角缝（约 3°，随扇区数收缩）。
  // 卡片贴近视口边缘时环必然溢出，朝外扇区的 label 沿半径向内收缩到可见（角度不变仍在本扇区内，
  // 最深收到 innerR 的一半 = 压在图片上，好过被裁出屏幕）。
  const sectors = useMemo(() => {
    if (!geom) return [];
    const n = sections.length;
    const step = (2 * Math.PI) / n;
    const gap = Math.min((4 * Math.PI) / 180, step * 0.14);
    const half = (step - gap) / 2;
    const midR = (geom.innerR + geom.outerR) / 2;
    return sections.map((section, i) => {
      const a = -Math.PI / 2 + i * step;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      let r = midR;
      const px = 10 + section.title.length * 6; // label 半宽（约 12px/字 + 余量）
      const py = 16; // label 半高
      if (cos > 1e-6) r = Math.min(r, (geom.vw - px - geom.cx) / cos);
      if (cos < -1e-6) r = Math.min(r, (geom.cx - px) / -cos);
      if (sin > 1e-6) r = Math.min(r, (geom.vh - py - geom.cy) / sin);
      if (sin < -1e-6) r = Math.min(r, (geom.cy - py) / -sin);
      r = Math.max(Math.min(r, midR), Math.min(midR, geom.innerR * 0.5));
      return {
        section,
        d: n === 1 ? donutPath(geom.innerR, geom.outerR) : wedgePath(geom.innerR, geom.outerR, a - half, a + half),
        evenOdd: n === 1,
        lx: r * cos,
        ly: r * sin,
      };
    });
  }, [geom, sections]);

  function pick(section: CaptionSection) {
    if (closeRef.current) return;
    setUsed((prev) => new Set(prev).add(section.title));
    onPick(section);
  }

  if (!geom) return null;

  const hintText =
    sections.length > 0
      ? "点扇区加入编辑框 · 移开鼠标或直接输入文字可关闭"
      : "该图无维度数据 · 右键图片可反推生成";

  return createPortal(
    <>
      {!suppressScrim && (
        <div
          className={`caption-ring-scrim${closing ? " is-closing" : ""}`}
          style={{ maskImage: maskImage ?? undefined, WebkitMaskImage: maskImage ?? undefined }}
          onClick={requestClose}
        />
      )}
      <div className={`caption-ring-layer${closing ? " is-closing" : ""}`}>
        {/* 洞内透明点击区：盖住目标图片（半径 = 环内径），再点 = 收起，也挡住误触重复拾取 */}
        <button
          type="button"
          className="caption-ring-catcher"
          style={{
            left: geom.cx - geom.innerR,
            top: geom.cy - geom.innerR,
            width: geom.innerR * 2,
            height: geom.innerR * 2,
          }}
          onClick={requestClose}
          title="收起维度环"
          aria-label="收起维度环"
        />
        {/* 卡片聚焦描边（呼吸光晕感） */}
        <div
          className="caption-ring-halo"
          style={{
            left: geom.card.x - 5,
            top: geom.card.y - 5,
            width: geom.card.w + 10,
            height: geom.card.h + 10,
          }}
        />
        {/* 手势说明小字：悬于整个环顶部上方（同瀑布流悬浮胶囊的材质）；环贴近视口顶/左右边时钳在屏幕内 */}
        <div
          className="caption-ring-hint"
          style={{
            left: Math.min(Math.max(geom.cx, 140), geom.vw - 140),
            top: Math.max(geom.cy - geom.outerR - 18, 16),
          }}
        >
          {hintText}
        </div>
        <svg
          className={`caption-ring-svg${closing ? " is-closing" : ""}`}
          style={{
            left: geom.cx - geom.outerR,
            top: geom.cy - geom.outerR,
            width: geom.outerR * 2,
            height: geom.outerR * 2,
          }}
          viewBox={`-${geom.outerR} -${geom.outerR} ${geom.outerR * 2} ${geom.outerR * 2}`}
          data-tour="creation-keywords"
          role="group"
          aria-label="可选维度环"
        >
          <circle className="caption-ring-hub" r={geom.innerR - 7} />
          {sectors.map(({ section, d, evenOdd, lx, ly }, i) => {
            const isUsed = used.has(section.title);
            return (
              <g
                key={section.title}
                data-dim={section.title}
                className={`caption-ring-sector${isUsed ? " is-used" : ""}`}
                style={{ animationDelay: `${i * 20}ms` }}
                tabIndex={0}
                role="button"
                aria-label={`添加维度 ${section.title}`}
                onClick={() => pick(section)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick(section);
                  }
                }}
              >
                <title>{section.body || section.title}</title>
                <path className="caption-ring-sector-fill" d={d} fillRule={evenOdd ? "evenodd" : "nonzero"} />
                <text
                  className="caption-ring-sector-label"
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {isUsed && <tspan className="caption-ring-sector-check">✓ </tspan>}
                  {section.title}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </>,
    document.body
  );
}
