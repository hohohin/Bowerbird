/**
 * v1 冻结限额（初始目标）—— HTML-RENDER-PLAN.md §4.2 / H0-T4。
 *
 * 数值为计划给出的初始目标；H0 VPS spike 后如有调整，只改本文件并同步计划文档。
 * renderer 内部所有校验共用这一个来源，不做二次散落定义。
 */
export const RENDER_LIMITS = {
  /** HTML 文本（UTF-8 字节）上限。 */
  maxHtmlBytes: 2 * 1024 * 1024,
  /** 模型可引用的资源（图片）数量上限。 */
  maxResourceCount: 64,
  /** 单个资源字节上限。 */
  maxResourceBytes: 10 * 1024 * 1024,
  /** 全部资源总字节上限。 */
  maxResourcesTotalBytes: 20 * 1024 * 1024,
  /** 视口 CSS 像素闭集范围。 */
  minViewportWidthCssPx: 320,
  maxViewportWidthCssPx: 2400,
  minViewportHeightCssPx: 240,
  maxViewportHeightCssPx: 4000,
  /** 单次渲染设备像素总量上限（64 MP）。 */
  maxDevicePixels: 64 * 1024 * 1024,
  /** 切片数量上限。 */
  maxSliceCount: 32,
  /** 切片高度 CSS 像素闭集范围。 */
  minSliceHeightCssPx: 200,
  maxSliceHeightCssPx: 4000,
  /** 切片重叠 CSS 像素闭集范围（默认 0）。 */
  minOverlapCssPx: 0,
  maxOverlapCssPx: 200,
  /** 单次渲染总时限。 */
  renderTimeoutMs: 30_000,
  /** 布局稳定窗口内允许的最大尺寸抖动次数。 */
  layoutSettleSamples: 3,
  layoutSettleIntervalMs: 60,
  /** 内部 HTTP 请求体（JSON，含 base64 资源）上限。 */
  maxRequestBytes: 40 * 1024 * 1024,
  /** 全部输出 PNG 总字节上限。 */
  maxOutputsTotalBytes: 192 * 1024 * 1024,
  /** HTML 结构上限。 */
  maxTagCount: 20_000,
  maxNestingDepth: 64,
  maxTextChars: 1024 * 1024,
  maxStyleBytes: 512 * 1024,
  /** 并发槽（H0：首台 2C4G VPS 并发 1）。 */
  concurrency: 1,
  /** 并发槽之外的排队上限；超过直接 render_capacity_busy。 */
  maxQueueDepth: 1,
} as const;
