// 瀑布流→侧栏文件夹拖拽的 payload 载体。
// 不用 dataTransfer 自定义 MIME：macOS WKWebView 走 NSPasteboard 会 strip 自定义类型，
// 同页也会丢失 → macOS 上「拖了没反应」。改用模块级变量扛 payload，dataTransfer 只写
// text/plain 当「拖拽已发生」信号（setData 必须有一次，否则部分浏览器不认这次拖拽）。
// getDragAssets() 返回 null 即「非本应用素材拖拽」，drop 目标据此跳过，避免外部文本误触。
let payload: string[] | null = null;

export function setDragAssets(ids: string[] | null) {
  payload = ids;
}

export function getDragAssets(): string[] | null {
  return payload;
}
