# 视频导出菜单与音轨提取

用户要求：帧按钮收进“导出帧”；提取视频音轨后选择画板或素材库。现行产品约定见 PROJECT.md。本次只改桌面源码，未部署 Cloud、未打包发布。

## 实施与复用

- 读取 UI／视频／音频／画板／文件归属规范及复用地图，沿 ub-mode 和 ui-ux-pro-max 工作。菜单选择公共 ContextMenu，单选 TacticalSelect 不作为动作菜单。
- 先增加正式播放器行为测试，确认缺少“导出帧”入口，再接入 VideoExportMenu。原截帧、尾帧、参考图与保存回调保留，进度和成功反馈显示在播放器中；浮层不挤占高度，全屏挂入播放器。Lightbox 对菜单 Esc 让路；修正 ContextMenu 首焦点前由触发器按 Esc 的窗口。
- extract_video_audio 使用现有本机 FFmpeg 发现机制、流式音频解码和入库接口，提取第一条音轨为 WAV；串行、300 秒／512 MiB 上限，来源只接受已登记视频。源文件始终只读；提取前后检查版本，无声音明确提示。事务记录来源、操作身份和项目成员，回执丢失后同操作返回原音轨，写入失败清理本次素材。
- createVideoAudioExport 冻结目标项目，画板保存失败保留已提取 Asset 和 operationId；保存到素材库不依赖当前画板。音频卡和展开素材组使用原 AudioWaveform／全局试听器，图片渲染与图片专用拖入路径排除音频。通用画板 Asset 投递接口命名为 saveMediaAssetToCanvas，旧视频采集名称保留兼容别名。

## 验证与边界

- `video-export-ui.test.mjs`：帧菜单、原尺寸截图、弹层几何、Esc／全屏、音轨目标与跨项目重试。
- `video-audio-canvas-ui.test.mjs`：真实 CanvasWorkspace 写入队列失败后重试、单节点、WAV 浏览器播放、保存／重开恢复；IPC 使用隔离夹具，未操作真实用户库。
- `video-player-ui.test.mjs`、`video-player-upgrade-ui.test.mjs`、`video-trim-ui.test.mjs`：首尾帧像素、短片、重复入库保护、关闭取消、播放／全屏／恢复、裁剪另存／覆盖／失败重试通过；选择器改验菜单项与状态反馈。
- Rust `commands::video_audio::tests` 使用真实合成带声音视频及静音视频、临时 SQLite 和资料库，验证 WAV 可解码且存在声音、时长、原件不变、操作幂等、目标冲突拒绝、无音轨零入库、数据库失败回滚和临时目录清理。
- Windows Cargo 测试程序缺少 Common Controls v6 清单而无法启动；复制到 `.tmp/video-audio-tests.exe` 后仅给该测试副本嵌入现有清单，真实测试通过。未修改正式程序或系统配置。
- TypeScript 与独立 Vite 构建通过，保留既有大 chunk／混合导入警告。新增功能需要客户端前后端配套构建；本机 FFmpeg 必须可用。未测安装包和 Mac 原生环境。
- 截图／隔离证据在 `apps/desktop/.tmp/video-export/`、`video-audio-canvas/`，构建在 `.tmp/video-export-build/`。未提供 crapper／dryer／mutator 工具，以真实行为测试、编译及 diff 审查替代，不宣称取得对应分数。
