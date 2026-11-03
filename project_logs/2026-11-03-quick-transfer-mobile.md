# 快传手机网页行动记录（2026-11-03）

范围：用户已确认独立预览，按 ub-mode 与 ui-ux-pro-max 接入正式手机网页；不修改桌面组件，不提交。主决策仍在 PROJECT.md。

1. 读取当前协议、runtime、官方 LocalSend 网页、已确认 preview、UI-DESIGN-SPEC、USER-FACING-ERRORS、开发计划及技能。保留工业制图深浅色与布局；技能检索确认真实进度、可读错误及 aria-live。网页不请求外网，不展示上游错误原文。
2. 明确事实边界：XHR 上传进度只表示发送字节；收到 HTTP 200 才是 Ready 持久收件，文案“已传到电脑”，不称入库成功。批内顺序上传，已成功文件不自动重发；没有断点续传。
3. 父任务授权 scoped GET / 校验同一 PIN，用现有路由探测关闭/旧二维码。后台页面不承诺定时及时，恢复可见时立即探测。仅网络故障不冒称过期。先建立隔离 Rust + Chrome 行为红测，再接 HTML 与 include_str。
4. 红测已实际运行：旧上游网页没有正式“发送”控件，Chrome 在 `#send` 超时；旧 GET / 无 PIN 返回 200，真实 HTTP 测试期望 401 而失败。随后实现自包含 `upload.html`，runtime 仅将 upload_page 改为 include_str；不设客户端格式清单，服务端仍为权威。文件名通过 textContent 放入静态模板。
5. Scoped GET / 增加 PIN 校验，错误状态返回同一静态页面（没有凭据或资料），使旧二维码能展示中文失效提示；同源探测读取 HTTP 状态，不将端口存活误认为当前链接有效。保留原默认网页；修改只作用于显式 receive scope。
6. 第一轮真实 Chrome 9 组绿：中文文件与批内顺序、延迟回执前“确认中”、显式重选重复、拒绝/部分成功后只重试未确认、XSS 字面显示、带 PIN 取消与下一批、闲置/上传中断网及恢复核对提示、旧链接、小屏深浅、实际停止 listener。10 个 transport 回归通过。离线恢复测试同时使用 CDP 限速与 BrowserContext offline，恢复后显式触发前台事件以避免两种模拟网络控制的事件顺序差异。
7. 实际查看 320px 深浅截图，布局保持确认稿结构、无横向滚动；关键按钮 44px 以上。新增“服务端已经回复 200、浏览器丢失该回执”的故障注入，验证不假报成功、不自动重传，并在 Rust 校验只收一次。
8. 最终独立 harness 实测 **11/11 通过**：10 个传输单测及 1 个真实 Chrome 场景入口（内含 10 组行为）；JSON 报告 `apps/desktop/.tmp/quick-transfer-mobile/report.json`，page error 0、外网请求 0。截图同目录 `mobile-320-light.png`、`mobile-320-dark.png`、`mobile-390-received.png`、`mobile-390-unconfirmed.png`。过程没有访问真实素材库，临时文件在 harness 退出清理，Chrome/监听关闭。
9. 独立审查 agent 实跑官方 crapper/dryer/mutator scan：手机最大 CC 8（sendLabel），sendFiles 7，其余 ≤6，全组阈值 0.8 无重复；没有测覆盖率，CRAP/Coverage 为 N/A，不宣称 CRAP <10 或手机全量 mutation 通过。父任务重新编译主 crate，本专项 **26/26 通过**（storage 11、transport 10、runtime 5）。
10. 重新核验上游 61 个原文件 SHA-256 与 LICENSE 原字节，vendor 真正改动仍仅 Cargo.toml、server/mod.rs、collect_to_json.rs、save.rs 四处。BOWERBIRD.patch 对比当前真实差异完全一致，SHA-256 `1939fb85ed350f1b0594de1d075f4b6c966137c6b8b56e7bd98035dfc92807c5`，写入 UPSTREAM.json；局部 .gitattributes 固定 patch 为 LF，避免 Windows checkout 使其字节哈希漂移。没有 target/Cargo.lock/examples/tests 混入 vendor。手机 HTML 冻结 SHA-256 `b741221ec9e00760bc5479687e3980593aa4f6d4554eb80323b0c32ad1a11ee5`。

验收边界：Chrome 390/320 窄视口并非真实手机；尚未核验 iOS/Android 文件选择器、后台挂起、真实 Wi-Fi/防火墙、Mac 原生或安装包。HTTP 未加密，没有断点续传；响应丢失状态须先核对电脑，重新发送会重新上传整文件。此手机网页仅确认 Ready 收件，后续索引由电脑独立显示。
