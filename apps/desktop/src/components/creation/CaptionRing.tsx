import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../store";
import type { CaptionSection, PromptedAsset } from "../../lib/types";

const PEEK_EVENT = "bowerbird://board-asset-peek";

/**
 * 维度环形菜单（radial menu）——全局单例（App 根挂载，store.captionRing 驱动）。
 * 唯一调起方式：任意场景长按左键瀑布流图片（MasonryGrid 派发 PEEK_EVENT）。
 *
 * 扇形（pie sector）菜单 = 以卡片为圆心的 SVG：每个维度一个扇区（角缝分隔），label 水平
 * 居中于扇区质心；hover 扇区 → 径向外侧浮层显示该维度反推正文；点扇区 → 直接插入创作板
 * （板未开则自动开板，keyword 走 store.pendingKeyword 由创作板的 useCreationEditor 消费），
 * 环保持打开可连续添加，已选扇区打 ✓ 变淡。无维度的图呼出空环并提示右键反推。
 * 展开动画 = 扇区自中心旋出 + 按角度错峰绽放；收起 = 整环收拢淡出后再卸载。
 *
 * 遮罩挖两个洞（环圈 + 编辑框）：mask = 外扩视口矩形 + 两洞的 evenodd 路径经 feGaussianBlur
 * 羽化——洞内不压暗不模糊且边缘渐变过渡，洞外 backdrop blur + 半透明压暗。板关着呼环时
 * 编辑框不存在，遮罩只挖环圈一个洞；点扇区开板后下一帧重测补上编辑框洞。
 *
 * 收起手势：Esc / 点遮罩 / 再点目标图片 / 右键 / 窗口缩放 / 鼠标移出环一定距离（编辑框
 * 区域除外）/ 直接输入文字。环心胶囊文字（主行「挑选你需要的维度」+ 小字关闭手势）说明
 * 这些。tour 激活时 suppressScrim（tour 自带聚光灯），且距离/输入收起不生效（避免引导中
 * 环意外消失）——但 tourStep ≥ 11（引导教「移开鼠标/直接输入关环」那步）起恢复这两种收起。
 *
 * 定位沿 AssetContextMenu / BoardChipPreview 范式：portal 到 body + fixed 坐标；
 * z-65/66 占用上下文菜单(60)与 tour/Popover(70) 之间的空档，保证 tour 聚光灯在最上层。
 */

type Geometry = {
  cx: number;
  cy: number;
  innerR: number; // 环内半径（固定 104）
  outerR: number; // 环外半径（扇区外缘，固定 104+38）
  hubR: number; // 内缘细圈半径（贴扇区内缘）
  catcherR: number; // 收起点击区半径（盖住整张图，至少到环内径）
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
function sameRect(a: Geometry["editor"], b: Geometry["editor"]): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// 遮罩 = 「外扩视口矩形 + 环圈圆 + 编辑框圆角矩形」的 evenodd 路径整体高斯模糊：
// 形状外 alpha≈1（显示遮罩 = 压暗模糊），两洞内 0（挖洞），洞缘按 σ 羽化。外框外扩 40px，
// 让它的羽化边落在视口外，屏幕四边不会出现渐隐。mask 同时作用于背景色与 backdrop-filter 输出。
// 环洞取 max(外径, 收起区)：小环压大图时图片露出环外的部分也不能被自己的遮罩压暗。
function buildMaskImage(g: Geometry): string {
  const pad = 40;
  const holeR = Math.max(g.outerR, g.catcherR) + 14;
  const ed = g.editor
    ? roundRectPath(g.editor.x - 12, g.editor.y - 12, g.editor.w + 24, g.editor.h + 24, 8)
    : "";
  const d =
    `M ${-pad} ${-pad} H ${g.vw + pad} V ${g.vh + pad} H ${-pad} Z ` +
    `${circlePath(g.cx, g.cy, holeR)} ${ed}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.vw}" height="${g.vh}">` +
    `<defs><filter id="f" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="9"/></filter></defs>` +
    `<path d="${d}" fill="black" fill-rule="evenodd" filter="url(#f)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** 全局单例入口：监听长按窥视事件开环；会话状态（几何/已选/收起动画）都在 Session 里，
 * 换图重开（key=assetId）即整体重置。 */
export function CaptionRing() {
  const openCaptionRing = useStore((s) => s.openCaptionRing);
  const assetId = useStore((s) => s.captionRing);

  useEffect(() => {
    const onPeek = (e: Event) => openCaptionRing((e as CustomEvent<string>).detail);
    window.addEventListener(PEEK_EVENT, onPeek as EventListener);
    return () => window.removeEventListener(PEEK_EVENT, onPeek as EventListener);
  }, [openCaptionRing]);

  if (!assetId) return null;
  return <CaptionRingSession key={assetId} assetId={assetId} />;
}

function CaptionRingSession({ assetId }: { assetId: string }) {
  const closeCaptionRing = useStore((s) => s.closeCaptionRing);
  const boardOpen = useStore((s) => s.boardOpen);
  const tourActive = useStore((s) => s.tourActive);
  const tourStep = useStore((s) => s.tourStep);
  // 维度数据：瀑布流资产 + 反推集合合并（prompted 后置覆盖补 sections），与 hook 的 assetById
  // 同源逻辑。响应式订阅——板外呼环时 openCaptionRing 补拉、开板瞬间 App.refresh 未返回时，
  // 数据到位即重算补扇区（非响应式 getState 会卡在挂载那一刻的空态）。
  const allAssets = useStore((s) => s.assets);
  const promptedAssets = useStore((s) => s.promptedAssets);
  const promptedAssetsLoaded = useStore((s) => s.promptedAssetsLoaded);
  const sections = useMemo<CaptionSection[]>(() => {
    const m = new Map<string, PromptedAsset>();
    for (const a of allAssets) m.set(a.id, a);
    for (const a of promptedAssets) m.set(a.id, a);
    const asset = m.get(assetId);
    return asset?.sections && asset.sections.length > 0 ? asset.sections : [];
  }, [assetId, allAssets, promptedAssets]);

  const [geom, setGeom] = useState<Geometry | null>(null);
  const [used, setUsed] = useState<Set<string>>(() => new Set());
  const [hovered, setHovered] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  // 展开动画期间扇形会扫过指针下方（错峰绽放），先到的 pointerenter 是假 hover → 信息浮层
  // 会闪出用户没指的扇区。开环 600ms 内忽略。
  const openedAt = useRef(Date.now());

  // 收起走动画：先播 ~180ms 收拢淡出，再真正卸载。期间忽略重复收起与重测。
  const requestClose = useCallback(() => {
    if (closeRef.current) return;
    closeRef.current = true;
    setHovered(null);
    setClosing(true);
    closeTimer.current = window.setTimeout(closeCaptionRing, 180);
  }, [closeCaptionRing]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    []
  );

  // 挂载即测量（layout 阶段，避免首帧闪位）。卡片 DOM 由 MasonryGrid 提供（id=asset-*）。
  // 滚动时也走这里重测（环跟随图片/编辑框移动）：插入 keyword 会 scrollIntoView 滚动面板，
  // 若滚动即收起会让环在加第一个维度时就意外关闭；元素不在了才收起。
  // 编辑框用 data-tour 选择器找（板关着时不存在 → 遮罩只挖环圈一个洞）。
  const remeasure = useCallback(() => {
    if (closeRef.current) return;
    // 锚点：优先瀑布流卡片（长按窥视）；标注注入的临时图不在瀑布流，
    // 回退到编辑框内该资产的 image chip（data-asset-id），环围绕刚插入的 chip 呼出。
    const anchor =
      document.getElementById(`asset-${assetId}`) ??
      document.querySelector(`[data-asset-id="${CSS.escape(assetId)}"]`);
    const card = anchor?.getBoundingClientRect();
    if (!card || !card.width) {
      requestClose();
      return;
    }
    const ed = (document.querySelector('[data-tour="creation-editor"]') as HTMLElement | null)?.getBoundingClientRect() ?? null;
    const edRect = ed ? { x: ed.left, y: ed.top, w: ed.width, h: ed.height } : null;
    const cx = card.left + card.width / 2;
    const cy = card.top + card.height / 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 固定小尺寸环：外径 142（上一版 177 再缩 20%）、环厚 38（扇区增大 40%）、内径 104，
    // 与卡片尺寸完全解耦，扇区允许压在图上（环浮于图片中部）。hub 细圈贴扇区内缘；
    // 收起点击区盖整张图（图片露出环外的部分点击也收起）。贴近视口边时仍按 fit 收缩环厚。
    const cardHalf = Math.max(card.width, card.height) / 2;
    const innerR = 104;
    const hubR = innerR - 7;
    const desired = innerR + 38;
    const fit = Math.min(cx, cy, vw - cx, vh - cy) - 14;
    const outerR = Math.max(Math.min(desired, fit), innerR + 28);
    const catcherR = Math.max(innerR, cardHalf + 12);
    setGeom((prev) => {
      // scroll 监听是捕获模式，任何容器滚动都触发重测；值没变时返回 prev，
      // 避免 mask SVG 重建 / pointermove 监听重挂 / 整组件重渲。
      if (
        prev &&
        prev.cx === cx &&
        prev.cy === cy &&
        prev.innerR === innerR &&
        prev.outerR === outerR &&
        prev.hubR === hubR &&
        prev.catcherR === catcherR &&
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
        hubR,
        catcherR,
        vw,
        vh,
        card: { x: card.left, y: card.top, w: card.width, h: card.height },
        editor: edRect,
      };
    });
  }, [assetId, requestClose]);

  useLayoutEffect(() => {
    remeasure();
  }, [remeasure]);

  // 板在环开着期间被打开（点扇区自动开板）→ 下一帧重测补上编辑框洞
  useEffect(() => {
    if (!boardOpen) return;
    const id = requestAnimationFrame(remeasure);
    return () => cancelAnimationFrame(id);
  }, [boardOpen, remeasure]);

  // 收起：Esc / 直接输入文字（不拦截，按键落进编辑框）/ 窗口缩放（几何整体失效）/ 右键
  // （先收环再出菜单，避免菜单 z-60 压在环层 z-66 下面）。遮罩与洞内点击区的收起见各自
  // onClick；滚动不收起、只重测跟随。tour 期间只有 Esc 生效（防环在引导中意外消失）——
  // tourStep ≥ 11 起输入收起也生效（引导开始教关环手势）。
  useLayoutEffect(() => {
    window.addEventListener("keydown", onKey, true);
    // IME 组合开始 = 用户在输入文字（中文输入法 keydown 的 key 是 "Process"，字符判定兜不住）
    window.addEventListener("compositionstart", onCompositionStart, true);
    window.addEventListener("scroll", remeasure, true);
    window.addEventListener("resize", requestClose);
    window.addEventListener("contextmenu", requestClose, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("compositionstart", onCompositionStart, true);
      window.removeEventListener("scroll", remeasure, true);
      window.removeEventListener("resize", requestClose);
      window.removeEventListener("contextmenu", requestClose, true);
    };
    function onCompositionStart() {
      if (tourActive && tourStep < 11) return;
      requestClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        requestClose();
        return;
      }
      if (tourActive && tourStep < 11) return;
      // 直接输入文字 → 收起环让位。"Process" = IME 处理中的键（中文输入法下可打印字符
      // 判定拿不到）；Backspace/Delete 属编辑输入，一并算；空格不算（扇区键盘激活用）。
      const typing =
        e.key === "Process" ||
        e.key === "Backspace" ||
        e.key === "Delete" ||
        (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey);
      if (typing) requestClose();
    }
  }, [requestClose, remeasure, tourActive, tourStep]);

  // 鼠标移出环一定距离即收起。编辑框区域豁免：用户常移过去挪光标/继续输入。
  // tour 期间不生效（防环在引导中意外消失），tourStep ≥ 11 起恢复（引导教关环手势）。
  useLayoutEffect(() => {
    if (!geom || (tourActive && tourStep < 11)) return;
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
  }, [geom, requestClose, tourActive, tourStep]);

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
        a,
        cos,
        sin,
        d: n === 1 ? donutPath(geom.innerR, geom.outerR) : wedgePath(geom.innerR, geom.outerR, a - half, a + half),
        evenOdd: n === 1,
        lx: r * cos,
        ly: r * sin,
      };
    });
  }, [geom, sections]);

  // 点扇区 = 维度插进当前编辑器（板 / 会话编辑坞，环保持打开可连续添加）。
  // assetId 一并传出：目标编辑器缺该图 chip 时（长按窥视不插 chip）先补插，
  // 保证插入形状是「@图片【维度】」而非孤立【维度】。
  function pick(section: CaptionSection) {
    if (closeRef.current) return;
    setUsed((prev) => new Set(prev).add(section.title));
    useStore.getState().pickCaptionSection(section, assetId);
    // tour step 10：用户点环上维度（如「构图」）→ 引导完成
    const st = useStore.getState();
    if (st.tourActive && st.tourStep === 10) st.setTourStep(11);
  }

  if (!geom) return null;

  // 环心说明：有维度 = 主行「挑选你需要的维度」+ 小字关闭手势；无维度/读取中给出对应提示。
  const hubHint =
    sections.length > 0 ? (
      <>
        <div className="caption-ring-hub-title">挑选你需要的维度</div>
        <div className="caption-ring-hub-sub">——或——</div>
        <div className="caption-ring-hub-sub">移开鼠标 / 直接输入</div>
        <div className="caption-ring-hub-sub">来关闭维度环</div>
      </>
    ) : promptedAssetsLoaded ? (
      <>
        <div className="caption-ring-hub-title">该图无维度数据</div>
        <div className="caption-ring-hub-sub">右键图片可反推生成</div>
      </>
    ) : (
      <div className="caption-ring-hub-title">正在读取维度数据…</div>
    );

  const hover = hovered != null ? sectors[hovered] : null;
  // 信息浮层：径向外侧放置（中心点 = 环外缘外推半宽），整体钳进视口
  const tip = hover
    ? {
        section: hover.section,
        left: Math.min(Math.max(geom.cx + (geom.outerR + 140) * hover.cos, 150), geom.vw - 150),
        top: Math.min(Math.max(geom.cy + (geom.outerR + 16) * hover.sin, 70), geom.vh - 50),
      }
    : null;

  return createPortal(
    <>
      {!tourActive && (
        <div
          className={`caption-ring-scrim${closing ? " is-closing" : ""}`}
          style={{ maskImage: maskImage ?? undefined, WebkitMaskImage: maskImage ?? undefined }}
          onClick={requestClose}
        />
      )}
      <div className={`caption-ring-layer${closing ? " is-closing" : ""}`}>
        {/* 洞内透明点击区：盖住目标图片（整张图 + 环内径取大），再点 = 收起，
            也挡住误触重复拾取；环带上的点击由扇区（更上层）优先接管 */}
        <button
          type="button"
          className="caption-ring-catcher"
          style={{
            left: geom.cx - geom.catcherR,
            top: geom.cy - geom.catcherR,
            width: geom.catcherR * 2,
            height: geom.catcherR * 2,
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
        {/* 环心说明胶囊：主行 + 小字（原顶部悬浮胶囊移入环心），压在图上故用胶囊材质保可读 */}
        <div
          className="caption-ring-hub-hint"
          style={{ left: geom.cx, top: geom.cy }}
        >
          {hubHint}
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
          <circle className="caption-ring-hub" r={geom.hubR} />
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
                onPointerEnter={() => {
                  if (Date.now() - openedAt.current < 600) return;
                  setHovered(i);
                }}
                onPointerLeave={() => setHovered((h) => (h === i ? null : h))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick(section);
                  }
                }}
              >
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
        {/* hover 扇区的反推正文浮层（径向外侧，80ms 延迟淡入防扫过闪烁） */}
        {tip && !closing && (
          <div className="caption-ring-tip" style={{ left: tip.left, top: tip.top }}>
            <div className="caption-ring-tip-title">{tip.section.title}</div>
            {tip.section.body && <div className="caption-ring-tip-body">{tip.section.body}</div>}
          </div>
        )}
      </div>
    </>,
    document.body
  );
}
