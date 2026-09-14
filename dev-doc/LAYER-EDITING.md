# 分层编辑

实现状态与产品决策以 `PROJECT.md` 为准。本文件记录协议、代码入口和离线验收方法。

## 协议来源

2026-09-14 用户粘贴的《Seedream 5.0 pro》官方说明，图层拆分与单透明图层编辑章节。模型固定 `doubao-seedream-5-0-pro-260628`，调用方舟 `images/generations`，由 Bowerbird Cloud 持有 `ARK_API_KEY`。

- 拆分：单张 PNG/JPEG，`layer_decomposition=true`；空 prompt 不发送，指定元素时发送原文；size 为 auto/1K/1.5K/2K。
- `data` 中底图 z_index=0，其余最多 16 层；按 z_index 排序，优先使用 bounding_box.absolute，缺失时使用 normalized÷1000。宽高严格采用 right-left、bottom-top，不按示例图片编码尺寸额外加 1。
- 每层保留 PNG alpha；透明图层 AI 修改只发送选中图层，`background=transparent`、`output_format=png`，auto 转为明确的 2K。结果替换该层像素，保留本地位置、展示尺寸、显隐与透明度。
- 官方拆分输入上限 30 MB、26 万至 3600 万像素、比例 1:16–16:1；当前 Bowerbird 上传仍沿用单图 10 MB 限制，不隐式降采样。桌面把浏览器可解码输入转换成 PNG，服务端检查真实格式/尺寸/透明通道。

## 桌面与本地保存

入口 `AssetContextMenu` → `store.layerEditor` → 全局独立 `LayerEditor`。原图、生成图、项目素材与详情图共用菜单。打开时冻结素材 ID 与项目 ID；保存不根据当前路由临时改变归属。

面板包含元素拆分提示词、尺寸、服务报价、图层列表、拖动、右下角等比缩放、数值坐标/宽高、名称、显隐、不透明度、上下移层与撤销。底图固定底层；隐藏层不参与合成。保存失败保留当前编辑状态，未保存关闭需面板内确认。

`commands/layers.rs` 提供四个 IPC：

- `layer_workspace_load/save`：每素材一条 `analyses(kind=layer_workspace)` 指向 `<library>/layers/<ULID>.json`。文件含完整 PNG/JPEG data URL 与编辑参数，不依赖过期下载 URL；不可变新文件写入并 sync 后事务交换指针，再删除旧文件。库迁移同时复制 layers。
- `layer_cloud_request`：仅允许分层创建、报价与原任务查询/取消，经既有 AuthClient 发往 generate-proxy。成功包验证同源下载、字节数与 SHA-256。
- `layer_export`：合成 PNG 作为新资产入库，另存独立图层工程副本，原图不会被覆盖或被去重合并。原图和合成图均可右键继续编辑。

工程为 Bowerbird 本地格式；本次不输出 PSD。图层包上限 256 MiB，单输出图片上限 30 MiB；上限失败明确显示，不能漏层后报告成功。

## Cloud 与计费

复用 `generation_jobs`、预授权、租约/心跳、VPS generation worker、generation-temp、下载签名、SHA-256 与 TTL。没有新增 Agent Runner。

两个独立服务：`image_layer_decompose`、`image_layer_edit`。0061 仅登记 **active=false、unit_cost=0、pricing_ready=false**；数据库约束禁止未设置正价格与 pricing_ready 时启用。不添加普通生图下拉用 label，避免分层出现在普通生成 provider 菜单。

报价由 `generate-proxy action=layer_quote` 返回。价格未定/未启用时按钮显示“服务待开放”。未来按一次完整拆分或一次单层修改配置独立价格；如果选择按返回张数计费，应先改预授权/结算契约再启用，不能只改前端文案。

Worker 用共享 `layer-contract.ts` 在 submitted 前再次验证操作与 service 绑定，禁止通过普通图片档位请求拆分。专用结果 MIME 为 application/json，整个包包含所有层的字节和坐标；Edge/数据库限制图层服务与包 MIME 对应。底图缺失、重复层级、坏坐标、缺透明通道或部分返回都拒绝。已提交后结果解析/下载/上传失联进入 outcome_unknown，保留待结算，不自动重跑。已知上游拒绝沿用退款；成功沿用幂等完整任务结算。

提交前桌面持久化 idempotency_key、所属用户、完整请求和编辑目标。继续取回先 get_by_key，已存在则只查询；仅确定 not_found 时使用原幂等键创建。完整结果落本地后才清 pending。停止等待不取消上游任务，关闭后可从原素材重开继续查询；跨账号不能接续原任务。云端 TTL 后未取回的产物不能恢复，账本保留。

部署准备包含 `Dockerfile.generation` 和 `Dockerfile.unified-harness-candidate` 的新增共享协议文件。后续需同步迁移 0061、generate-proxy/generation-worker、VPS Worker 与桌面构建；真实启用和价格由后续用户决定。

## 离线验证

在各命令标注目录运行，不读取真实素材库、不调用真实模型：

```powershell
# apps/desktop
node node_modules/typescript/bin/tsc --noEmit
node scripts/layer-editor-ui.test.mjs
node node_modules/vite/bin/vite.js build
# apps/desktop/src-tauri
cargo test commands::layers --lib
cargo test core::migrate::tests --lib
# apps/agent-worker
node ../../node_modules/typescript/bin/tsc --noEmit
node --test src/cloud-generation/layers.test.ts src/cloud-generation/runtime.test.ts
# 仓库根；PGlite 参数指向现有隔离依赖
node apps/cloud/scripts/layer-editing-db.test.mjs <pglite-dist-index.js>
deno check apps/cloud/supabase/functions/generate-proxy/index.ts apps/cloud/supabase/functions/generation-worker/index.ts
```

UI fixture 使用真实 React 组件、Canvas PNG 与封闭模拟 IPC，覆盖右键、持久化恢复/不重复提交、拖动/等比缩放/撤销/显隐/顺序/透明度、保存失败、保存重开、冻结项目、合成像素、单层修改及未启价禁用。截图位于本地 `apps/desktop/.tmp/layer-editor-initial.png` 和 `layer-editor.png`。

最终验收状态见 `PROJECT.md`。合成 IPC 不代表原生 WebView2 或真实模型质量验收，夹具显示的 20/23 积分仅供测试，不是产品价格。
