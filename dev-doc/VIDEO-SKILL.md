# 本机 Skill 视频制作与 HyperFrames Studio

## 2026-11-05：对话渠道接入（源码未发布）

生成对话框选择「对话 → 本机 Codex」后，可直接要求制作或修改视频。原对话模型通过 `hyperframes_video` 的 prepare/read/write/check/snapshot/render 编写工程并渲染，无需转去 Agent 卡片，没有启动第二个模型任务。固定运行时、Node.js／FFmpeg 要求沿下文原契约，按各用户本机应用目录准备，不使用开发电脑路径或全局 Skill。DeepSeek Cloud 暂不暴露此工具。

- `agent_ds/chat_video.rs` 提供对话适配；与原文件工具桥共用 `video::execute` 的命令白名单、超时和进程树取消。普通对话仍为只读沙箱；宿主工具只操作当前对话独立工程，Skill 只读，不开放任意 shell、MCP 或文件路径。
- 每轮最多交付一份 MP4；prepare 复制同一对话上次成功工程，本轮引用图片按快照进入素材目录。工具调用按 callId 落 claim 与结果，未知中断不重放；停止／超时会通知视频任务并等待进程清理。应用异常退出不自动续跑。续聊沿上次成功交付工程，不承诺找回未交付工程。
- 成片通过既有 MP4 探测和素材去重入库，关联当前项目，作为原生工具消息附件保留并在对话中复用 `VideoPlayer` 播放。没有新增数据库迁移。文字回复结束不能把尚未交付的视频标记为完成；已有成片不受后续文字回复覆盖。
- 工具契约升级到 v4，旧本机对话通过既有有界公开历史迁入新 provider thread，应用对话身份不变；历史图片不会自动重新发送。Cloud 保持原工具与指令。
- 验证：60 项对话 Rust 回归、1 项文件／参数边界测试通过；固定 0.9.10 真实 check、3 帧 snapshot、合成 640×360 MP4 render 与取消状态测试通过；正式对话面板播放和刷新恢复通过；TypeScript 与隔离 Vite 构建通过。完整画板对话 UI 旧测试被当前工作区创作框投影 canvas 遮挡而超时，不计通过；独立正式面板测试不依赖该布局。未调用真实模型验证自然语言制片质量、未发布安装包。详见[行动记录](../project_logs/2026-11-05-chat-hyperframes.md)。

2026-11-04 源码接入。产品范围与优先级以 [PROJECT.md](../PROJECT.md) 为准：先本机 Codex 制作、本机渲染和完整 Studio 独立面板，Cloud 后续接入。

## 使用入口

画板 Agent 卡片选择 `Codex CLI` → `视频制作 · HyperFrames`，输入内容、时长、比例及风格要求。可连接本机图片、视频、音频；视频按原文件交付，不自动转换为尾帧。完成后 MP4 入库并落到画板，Agent 详情可播放成片、打开 Studio 或工程目录。

同一卡片再次运行时，从上次已交付工程复制出新一轮工程，保留前一轮文件和成片。Studio 编辑最新工程，使用独立原生 WebView，不导航、重建或共享探索页的浏览器实例。保存并关闭 Studio 后再运行同卡 Agent，已保存的手动修改随工程复制进入续轮。历史轮次通过目录查看；Studio 入口只编辑最新已交付轮次。

Studio 提供其完整本机页面，包括时间轴、预览、代码及属性编辑。Studio 自己的导出沿上游导出流程；手动导出暂不自动替换画板成片，可继续在 Agent 中要求渲染交付。外部桌面跳转、弹窗和第三方托管服务不属于本次集成；工程页只允许在当前本机服务源内导航。

## 复用与运行契约

- 复用 `agent_ds.rs` / `agent_ds/codex.rs` 的卡片身份、独立会话、原请求恢复、公开进度、取消和现有本机权益门控；增加 `purpose: agent-video`，不新增 Agent Runner，不调用视频生成模型。
- 环境固定为 `hyperframes@0.9.10`，需要 Node.js 22+、已有 Codex CLI 登录以及共用 resolver 可发现的 FFmpeg / FFprobe。首次运行由桌面 npm 安装到应用资料目录 `video-runtime/0.9.10`，跳过安装脚本并校验版本；浏览器缓存同样独立。不会安装到用户全局 skills 或覆盖全局 HyperFrames。
- 每请求目录保存版本配套的 `.agents/skills`、输入素材副本、`project/`、工具请求／响应、结果信封及成片。工程预置本地 GSAP。素材上限 32 项／1 GiB；续轮工程复制上限 5000 个条目、16 层、2 GiB，拒绝符号链接，跳过依赖、渲染缓存和旧 `renders/`。
- Codex 仅在既有 workspace-write 沙箱内编写本次工程，通过 `bowerbird-hyperframes.mjs` 提交文件工具请求；桌面执行固定版本的 `lint/check/timeline/snapshot/render`。不放开 Agent 沙箱以启动 Chrome；不接受任意命令、工程目录、外部服务、Docker、视觉描述 API 或任意输出路径。
- 工具参数按命令白名单验证；截图最多 20 帧，渲染 1–60 fps、1–2 worker，每次工具执行最多 10 分钟。调用先记录 claim，再启动进程；已 claim 的未知结果不重放。任务结束／停止时关闭工具服务，并终止其运行中的进程树。
- 结果兼容原 schema v1，视频使用 `videos: ["result.mp4"]`，只交付一份 MP4（≤512 MiB）。路径、扩展名、尺寸和时长验证后，复用素材入库及字节去重；画板结果节点固定为 `workflow-video:<requestId>`，重载只补交付、不重发模型、不重复落卡。
- `WorkflowStep.localAgentSkill` 随请求冻结；之后更改当前卡片能力或通道不改变已提交请求。`videoProjectPath` 来自原生端确认的工程目录，不采信模型自报路径。只有成功入库且工程保留 `index.html` 才更新该卡片的工程指针；旧结果回放不能回滚较新指针。
- Studio 使用固定 CLI 的 `preview --foreground --no-open`，只监听 loopback。启动后核对服务 PID 和工程目录，再创建独立 `video-studio` WebView；远程页面不取得主窗口的 Tauri IPC 权限。面板关闭和正常应用退出终止服务；与同卡 Agent 互斥，避免同时写工程。
- 本版不支持视频 Skill 循环任务、Cloud 视频 Skill 或便携模板导出；可在画板复制卡片。模板导出显式拒绝，避免现有模板协议丢失 Agent 视频能力。没有新增 SQLite 迁移、Bcoin 服务或计价；普通图文 Agent、视频模型生成及 H3 沿原通路。

## 代码入口

| 用途 | 入口 |
|---|---|
| 环境、工程副本、受控工具和视频校验 | `apps/desktop/src-tauri/src/commands/agent_ds/video.rs` |
| 沙箱内工具客户端 | `apps/desktop/src-tauri/src/commands/agent_ds/video-runner.mjs` |
| Studio 服务、WebView、互斥与退出 | `apps/desktop/src-tauri/src/commands/agent_ds/video_studio.rs` |
| 请求编排、恢复与画板交付 | `apps/desktop/src/lib/canvasWorkflowRuntime.ts` |
| 能力选择、详情和 Studio 面板 | `CanvasWorkflowLayer.tsx`、`WorkflowAgentDetail.tsx`、`VideoStudioPanel.tsx` |

## 验证与边界

- Rust Agent 回归：34 passed / 5 ignored。显式执行的 3 项真实本机测试通过：固定运行时与 skills 准备、合成 MP4 入库去重、真实 Codex workspace-write 沙箱经工具桥完成 check／snapshot／render，并验证 Studio 服务启动及退出。未调用模型。
- `scripts/canvas-workflow-video-skill.test.mjs`：真实工作流控制器配合合成 IPC，验证能力保存、原视频／音频输入、独立工程路径、成片落卡、切换配置后的原请求恢复、续轮、失败／停止及普通图文 Agent 回归。
- `scripts/hyperframes-render-smoke.mjs`：固定版本 CLI 真实渲染 640×360、2 秒、15 fps 场景；FFprobe 元数据、完整 FFmpeg 解码与 30 帧运动校验通过。
- `scripts/video-studio-ui.test.mjs`：真实上游 Studio 页面放入正式面板，验证场景选择、真实时间轴、手动属性编辑写回 `compositions/scene.html`、面板缩放／关闭和启动错误。原生 WebView 的创建／几何／关闭接口用隔离夹具替代；此项不能替代 Windows WebView2 和 macOS WKWebView 的完整实机验收。
- 完整 TypeScript 检查与隔离 Vite 构建通过。证据位于 `.tmp/hyperframes-integration/` 和 `apps/desktop/.tmp/video-skill*`、`apps/desktop/.tmp/video-studio/`，均为合成数据。
- 初次直接在 Codex 沙箱执行 Chromium 渲染遇到 `spawn EPERM`，因此采用桌面固定工具桥；保留沙箱，不使用 unrestricted 模式。真实本机沙箱联调已验证这一修正。
- 尚未执行真实自然语言 Codex 制片质量验收、全类型媒体剪辑、Mac 原生验收或安装包发布；Studio 作为后续轻剪辑基础的判断参考[官方编辑能力](https://github.com/heygen-com/hyperframes/blob/main/docs/weekly-updates.mdx)，不视作所有传统非线性剪辑能力均已验收。
