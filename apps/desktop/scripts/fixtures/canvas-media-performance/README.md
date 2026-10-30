# 画布媒体性能夹具

复用 `canvas-reference/preview.tsx` 的真实 `CanvasWorkspace`，以封闭合成 IPC 提供 330 张图片、330 段视频或混合卡片；30 张在初始视区附近，其余 300 张在远处。9 条连线保留。原图是测试脚本生成的 4096×2048 RGBA PNG，预览长边为 512/1024/2048。真实文件、数据库、FFmpeg 和 provider 均不调用。

从 `apps/desktop` 运行：

```powershell
node scripts/canvas-media-performance-ui.test.mjs
```

输出 `.tmp/canvas-media-performance/after.json`。覆盖离屏媒体延迟、移屏后加载、保留节点及连线几何、分档升级、透明/半透明像素及显式原图预览。像素校验只证明前端不会改变合成预览透明度；Rust 真实缩放/缓存正确性由后端测试覆盖。

动态 DPR 测试用 CDP 将 DPR 从 1 改为 2 再回到 1，同时将窗口宽度从 1800 改为 1801 再恢复，记录真实浏览器的 resize 和 resolution change 事件；不手工派发这些事件。同尺寸 CDP DPR override 只改变属性而不通知媒体查询，因此此项是 DPR + 1px 窗口 resize 模拟，不能替代真实跨显示器验收。可传 `--tiers-only` 单独验证分档/DPR/透明/原图，输出 `after-tiers.json`，不覆盖完整性能证据。

改动前先冻结源码，然后运行相同测试的基线模式：

```powershell
New-Item -ItemType Directory -Force .tmp/canvas-media-performance-before
Copy-Item src .tmp/canvas-media-performance-before/src -Recurse
node scripts/canvas-media-performance-ui.test.mjs --before
```

冻结目录必须在本轮首次基线时创建；不要覆盖已保存的源。基线模式用 Vite 将组件及其源码依赖解析到冻结目录，外部图标仍读取工作区资源。结果保存至 `.tmp/canvas-media-performance/before.json`，包含 CanvasWorkspace 源码哈希。

`decodedPixelProxy` 按当前已加载 `img` 的唯一 URL 累计自然宽×高，反映资源规模，不是实际进程内存或 GPU 占用。帧时间是在 1800×1200、DPR 1、Chrome headless 和 Vite 开发构建中对平移/缩放收集的 rAF 间隔，受到调度和开发开销影响，不代表原生 WebView2 帧率。资源请求和几何断言为硬门槛；帧时间只记录，不以波动阈值判断测试成功。
