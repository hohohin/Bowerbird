# 本机对话隔离验收夹具

真实 `CanvasWorkspace` / `CreationBoard` / `LocalChatPanel` 配合合成 Tauri IPC。回复、资产、项目、权限均为浏览器测试数据；没有原生桥接、用户素材库读取、真实 CLI 或模型调用。两个参考图是内联 SVG。

在 `apps/desktop` 启动：

```powershell
node scripts/local-chat-ui-serve.mjs
```

打开 `http://127.0.0.1:17881/scripts/fixtures/local-chat/preview.html`。端口可由 `BOWERBIRD_CHAT_TEST_PORT` 覆盖，独立缓存位于 `.tmp/local-chat/vite`。

顶部可见控件支持项目 A/B 切换、片段/完成、进程中断、运行失败、迟到旧 revision、发送/停止/读取故障、登录与权益切换。默认“手动推进回复”，发送后使用“追加回复片段”或“完成回复”。关闭对话面板不会停止合成后台状态；刷新保留 `sessionStorage` 历史，续聊草稿由正式组件自己的 `localStorage` 保存。

测试步骤：

1. 图片／视频／对话各写一份草稿，交替切换检查保留。
2. 发送首条对话，推进片段后停止，检查已有内容保留且只有一个画板卡片。
3. 续聊后关闭面板，继续推进并完成，重开同一张卡核对完整历史。
4. 历史搜索、发送过期事件、刷新恢复，并切项目核对对话与草稿隔离。勾选“延迟发送回执”，在 A 发起新对话后切 B 输入草稿，再释放 A 回执，B 的草稿与面板应保持。
5. 分别设置发送失败／停止失败／读取失败；失败提示不回显注入的英文、路径与内部字段；发送失败保留草稿，停止失败仍显示运行状态。
6. 模拟本轮失败和进程中断，检查部分回复保留且不会自动重发；关闭登录或权益时新提交被阻止，历史仍能查看。
7. 检查深浅主题和窄窗口；右侧输入框与关闭按钮保持可操作。
8. 导出真实 Rust 卡片编译夹具后，使用「创建逐行循环四卡」「创建按次数循环四卡」。核对四类原生卡片、统一名称、引用与连线、未运行状态；点击回执定位／撤销，修改次数后再次撤销应拒绝，重载保留编辑和回执。

卡片样本由 Rust 编译器输出，避免 UI mock 另写一份卡片编译规则。在 `apps/desktop/src-tauri` 执行：

```powershell
$env:BOWERBIRD_CARD_FIXTURES = (Join-Path (Resolve-Path '../.tmp/local-chat') 'card-fixtures.json')
cargo test --locked --offline --lib local_chat_cards_export_review_fixtures -- --ignored --nocapture
```

样本只包含临时 SQLite 合成数据；网页将样本素材 ID 映射到可见 SVG 并平移到已有卡片旁，保存于当前页 `sessionStorage`，不连接 CLI、不调用真实生成。2026-10-27 已通过 CUA 验证逐行／次数两类四卡、定位、增量撤销、修改后撤销拒绝、刷新恢复和跨项目隔离；截图位于 `.tmp/local-chat/verification/cards-created.png`。

可复用自动回归入口：

```powershell
node --experimental-strip-types --test scripts/creative-draft.test.mjs
node --test scripts/local-chat-store.test.mjs
node scripts/local-chat-ui.test.mjs
```

UI 脚本使用独立临时端口与无用户资料的 Chromium 上下文，截图写 `.tmp/local-chat/`。当前代理会话的浏览器操作由主代理通过 `cua_repl` 完成；该脚本保留给正常仓库回归运行，不能将静态编写等同于已经跑过。
