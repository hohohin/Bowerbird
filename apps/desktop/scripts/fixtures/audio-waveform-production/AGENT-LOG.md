# 正式 AudioWaveform 实装记录

2026-11-01，所有实现均为新文件；未修改正式入口、现有图片队列、视频播放器或全局类型。根代理负责入口整合及最终审查。本代理未提交或推送。

1. 先读已有 `filePreviewQueue` 与视频悬停生命周期。前者结果固定为图片 URL，后者为静音临时视频；音频需要 typed min/max 与可持续共享音频，因此新增专用小模块，未扩展不相容的旧接口。
2. **RED**：先创建直接导入正式 `AudioWaveform` 的 React.StrictMode fixture 和真实媒体测试；模块尚未存在，Vite import / 控件就绪失败。测试并非独立预览脚本替身。
3. 实装 typed 峰值队列、单个 HTMLAudioElement 生命周期与 Canvas 组件。第一轮 **GREEN** 验证播放真实时钟、同源 seek 无 loadstart、持续/临时模式、版本语义、React 卸载/重挂、可见队列并发/取消/缓存及键盘。
4. **RED**：同一详情 React 位置切换到另一等时长素材，`durationUpdates['reuse-two']` 为 undefined，期望 1。原因是时长去重仅比较数字。改成按 `assetId + duration` 记录后 **GREEN**；同素材 duration 写回/列表刷新仍不会重复回传或停播。
5. **RED**：增加目录变更前释放原文件的真实播放断言时 `stopAudioPreviewInFolder` 尚不存在。新增严格目录段匹配、Windows drive/UNC 归一化与其他路径大小写保留。**GREEN**：子项/文件精确匹配停止；相似前缀、其他盘符、非 Windows 大小写差异不停止。
6. 增加失败重试、隐藏原始诊断和多选模式点击穿透。通过真实 WAV 网络请求延迟验证 continuous pending 移出后仍播放；temporary pending 移出立即取消，切换新音源后旧响应不会复活。`Audio.play()` 全程原生。
7. 最终 `node scripts/audio-waveform-ui.test.mjs` **PASS**，Chrome 155.0.8059.85，创建 Audio 数 1，峰值在途最高 2。测试运行结果和深浅截图位于 `apps/desktop/.tmp/audio-waveform-production/`，已实际查看两张图。当前测试没有断言原生 WebView2 FPS，也不代替后端真实解码验证。
8. 根代理入口审查后补两个 **RED → GREEN**：同一素材展示版本刷新并清空父组件时长，原去重仍抑制 12 秒回传；最终改为每次已接受波形结果仅在 `duration` prop 与真实值不同才回传，删除 `reportedDuration`，替代第 4 步的中间方案。另常规 Windows drive 路径与 `\\?\` canonical 目录匹配失败；只对明确 Windows drive/UNC 命名空间归一化 extended prefix 后，相关文件释放回归通过。再次完整运行该组件 suite **PASS**。只读入口审查另发现音频卡选中缺少既有标记所需预览节点，已交根代理处理，未编辑其文件。
9. 选择模式暂停边界 **RED → GREEN**：真实持续播放后设置 `interactive=false`，暂停按钮原为 disabled，`isEnabled()` 期望 true 实际 false。只放行正在播放或等待播放时的暂停按钮及其鼠标命中；波形仍交给父卡选择。最终 suite **PASS**：点波形只选择、不 seek、不停止持续播放；暂停真实停止且不冒泡；停止后不可在选择模式重新启动。

类型检查由根代理统一运行；sandbox 内的 ProseMirror 解析报错经本机同一 tsc 验证归因于隔离环境，最终完整类型检查与 Vite 构建通过，未修改无关编辑器代码。
