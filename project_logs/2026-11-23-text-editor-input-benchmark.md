# 文本编辑器长文档输入基准

## 复测条件

在 Windows 上用 Playwright 无头 Chrome 打开真实 `TextWorkspace`，视口为 1440 × 960，CPU 限速为 1×。测试使用 100 段共 10,000 个中文字及标点、8 张本机模拟图片和 6 张表格，等待图片挂载及首次本地草稿保存完成后开始采样。连续输入 5 组，每组 24 次键入，键间间隔 18 ms。组间等待 650 ms 及对应草稿正文更新，覆盖 300 ms 自动保存。浏览器 `requestAnimationFrame` 统计输入和保存期间的帧间隔，Vite 测试探针单独计时主线程 Markdown 序列化。基线用 `49409682aa169ca8035e91b27f628590f0f8698d` 的正文编辑器、工作区草稿 Hook 与写入队列，使用同一夹具和样式。

```powershell
Set-Location apps/desktop
$env:BOWERBIRD_TEXT_BENCHMARK_BASELINE = '49409682aa169ca8035e91b27f628590f0f8698d'
node scripts/text-document-input-benchmark.mjs
Remove-Item Env:BOWERBIRD_TEXT_BENCHMARK_BASELINE
node scripts/text-document-input-benchmark.mjs
```

## 首轮结果

| 指标 | 基线 | Worker 自动保存 |
| --- | ---: | ---: |
| 平均帧率 | 59.2 FPS | 57.2 FPS |
| 帧间隔 p95 | 16.9 ms | 17.1 ms |
| 最大帧间隔 | 50.2 ms | 66.7 ms |
| 超过 25 ms 的帧间隔 | 7 | 24 |
| 主线程 Markdown 序列化用时 | 27.2、25.6、25.3、24.0、19.7 ms | 0 次 |
| Worker 返回的压缩 Markdown | 0 | 5 次 |

本轮与其他开发验证共享机器资源。五次自动保存均在 Worker 完成 Markdown、指纹和压缩，期间未在主线程调用完整序列化。首轮没有测得端到端帧率提升。该夹具测量 Chromium 浏览器路径，Windows WebView2 与 macOS WKWebView 的实机帧率尚未测量。

正文打开时未请求公式、代码绘图或 Excalidraw 渲染模块。正式 Vite 构建通过。检查 `App`、`TextDocumentEditor` 和 `TextWorkspace` 生成文件的静态导入链，未发现 KaTeX、公式渲染器、代码绘图、Mermaid、Graphviz、Excalidraw 渲染器或文档序列化 Worker 的入口文件。Worker 在首次草稿自动保存时启动，绘图和公式渲染器在对应块挂载时加载。
