# 对话渠道 HyperFrames 接入

用户要求在应用的对话渠道调用视频制作，不是配置开发者本机。

1. 核对 VIDEO-SKILL、CHAT-PROVIDERS、PROJECT、架构复用地图、统一 Harness、项目画板、文件与 UI／错误规范。确认原 `local_chat` 明确关闭全局 Skill／shell，只挂卡片工具；原视频能力只用于 Agent 卡片。
2. 按 ub-mode 添加当前轮次的视频工具用例，先在隔离测试 EXE 上得到预期拒绝断言失败。测试 EXE 沿既有实践单独复制并嵌入 Common Controls v6 manifest，不修改正式程序。
3. 给既有对话模型增加受控视频工具，复用固定版本环境、工程复制、白名单执行和入库；未增加模型 Runner、服务端或数据库迁移。工具名称／当前 thread 与 turn 绑定验证复用原卡片入口，调用声明和结果保留在本轮工程，恢复不隐式重放。
4. 复用消息表保存视频进度及素材附件，复用正式播放器；工具契约升级旧本机对话，Cloud 的定义／指令不变。停止及超时等待视频进程清理，文字完成与视频交付分别记录。
5. 验证并审查：60 项 local_chat Rust 回归通过（2 项既有真实 CLI 测试忽略），1 项文件／参数边界通过。固定运行时真实 check、3 帧 snapshot、640×360 合成 MP4 render、已取消状态拒绝执行通过。`local-chat-video-ui.test.mjs` 正式面板内真实视频播放及刷新恢复通过。完整 TypeScript、隔离 Vite 构建通过，仅原大包提示。
6. 环境处理：普通沙箱构建／本机 socket 测试受限，使用获准本机隔离测试。首次 browser ensure 下载等待未完成，停止本次测试进程树，显式使用测试机已安装 Chrome 后渲染通过；不宣称首次浏览器下载已验收。旧完整 `local-chat-ui` 在画板创作框投影 canvas 拦截点击处超时，工作区该创作框由其他任务修改，保留其改动；新增独立正式面板测试验证本轮行为。
7. 当前没有可用 crapper/dryer/mutator 工具，未宣称执行；保留其他工作区修改和临时产物。同步专项文档、复用地图及 PROJECT 当前约定。

证据：`.tmp/chat-video/`（原生测试、渲染与构建日志）；`apps/desktop/.tmp/chat-video-ui-final2.log`、`chat-video-types.log`、`chat-video-build.log`。测试仅使用合成工程和临时库，没有调用真实模型、访问用户素材库或重新运行用户任务。此轮未发布安装包，其他电脑通过后续应用更新获得能力；自然语言成片质量与跨平台原生验收仍待实际验证。
