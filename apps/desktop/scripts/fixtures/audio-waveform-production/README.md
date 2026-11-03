# 正式音频波形组件行为验证

此页面直接引用 `src/components/AudioWaveform.tsx`、正式共享播放器与峰值请求队列，不复制独立预览实现。文件名与总时长由正式卡片外壳负责，因此这里仅呈现组件本身。

在 `apps/desktop` 执行：

```powershell
node scripts/audio-waveform-ui.test.mjs
```

脚本创建 12 秒低幅合成 WAV 与对应 min/max 数据，在固定本地端口 17889 启动 Vite，使用本机 Chrome 执行真实播放、定位与时钟推进断言。测试仅模拟 Tauri IPC 和本机路径转换；没有替换 `Audio.play()`。原始媒体延迟测试在网络响应边界等待，仍由浏览器真实解码和播放。所有测试音频及截图写入 `apps/desktop/.tmp/audio-waveform-production/`，不使用用户素材。

## 组件契约

- `assetId`、`path`、`name`、`version` 必填；`expectedVersion` 只传原文件真实指纹。显示版本变化重新请求波形，播放身份由后端 `sourceVersion` 决定。
- 可选 `duration` / `onDuration` 供外壳持久化真实时长；`interactive=false` 将鼠标操作交给素材选择外壳。
- 悬浮只显示时间与竖线；波形点击从点击位置临时试听，离开停止。左下按钮从零持续播放，移出、滚动、焦点变化、隐藏与 React 卸载均保留，回来恢复暂停状态。新播放替换旧播放，Escape 或再次点击播放按钮停止。
- `stopAudioPreview(assetId?)` 用于明确删除/停止；`stopAudioPreviewInFolder(path)` 用于改名、移动、移除连接前释放相关原文件。普通虚拟列表卸载不代表删除。
- 全局延迟创建一个隐藏 `audio[data-audio-preview]`。同源重新定位复用当前解码器。可见组件才请求峰值，最多两个在途任务、64 个内存缓存条目；未启动任务可取消，已启动任务完成后可缓存。
- Canvas 按实际帧跨度聚合 min/max，不平均掉瞬态。每个文件仅在显示上归一化，静音保持中线；播放音量不变。前端不执行整文件 `decodeAudioData`。

## 覆盖与边界

覆盖真实播放/定位、连续和临时模式、同源不重载、实际内容版本变化、UI 版本变化、React 卸载重挂、等时长不同素材的时长回传、目录段边界及 Windows 大小写、失败重试与诊断隐藏、选择点击穿透、键盘与 50 次快速切换。覆盖真实 IntersectionObserver 可见性、两路并发、取消尚未启动任务及热缓存重用；媒体响应未到达时的持续播放/移出取消/过期结果也有断言。

浏览器测试主动派发 `blur`，并覆盖 `document.hidden` 事件分支及真实音频时钟；这不是操作系统后台节流验收。峰值后端的磁盘读取、解码、缓存和 Windows WebView2 原生路径验证由独立后端/正式库验证负责。本页截图也不是完整素材库布局验收。

稳定选择器：`[data-audio-preview][data-asset-id]`、`.audio-waveform-wave`、`.audio-waveform-play`、`.audio-waveform-hover`、`.audio-waveform-time`、`.audio-waveform-progress`；就绪与播放状态为 `data-wave-ready` / `data-playing`。
