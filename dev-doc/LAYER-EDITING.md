# 分层编辑

实现状态与产品决策以 `PROJECT.md` 为准。本文件记录协议、代码入口和离线验收方法。

## 协议来源

2026-09-14 用户粘贴的《Seedream 5.0 pro》官方说明，图层拆分与单透明图层编辑章节。模型固定 `doubao-seedream-5-0-pro-260628`，调用方舟 `images/generations`，由 Bowerbird Cloud 持有 `ARK_API_KEY`。

- 拆分：单张 PNG/JPEG，`layer_decomposition=true`；空 prompt 不发送，指定元素时发送原文；size 为 auto/1K/1.5K/2K。
- `data` 中底图 z_index=0，其余最多 16 层；按 z_index 排序，优先使用 bounding_box.absolute，缺失时使用 normalized÷1000。宽高严格采用 right-left、bottom-top，不按示例图片编码尺寸额外加 1。
- 每层保留 PNG alpha；透明图层 AI 修改只发送选中图层，`background=transparent`、`output_format=png`，auto 转为明确的 2K。结果替换该层像素，保留本地位置、展示尺寸、显隐与透明度。
- 官方拆分输入上限 30 MB、26 万至 3600 万像素、比例 1:16–16:1；当前 Bowerbird 上传仍沿用单图 10 MB 限制，不隐式降采样。桌面把浏览器可解码输入转换成 PNG，服务端检查真实格式/尺寸/透明通道。

## 桌面与本地保存

### 画布缩放与平移

分层面板左侧支持滚轮围绕鼠标位置整体缩放（适应窗口尺寸的 25%–800%）、加减按钮和「适应窗口」复位。按住空格加左键拖动，或按住鼠标中键拖动，可向任意方向平移视图；松键/鼠标释放、指针取消和窗口失焦正确结束手势，文字输入时空格仍正常输入。视图状态只影响显示，不写入图层坐标、工程或撤销历史；缩放后移动和调整图层按实际显示比例换算，选中框/手柄保持屏幕尺寸。

点击画布外围或所有前景元素外框之外的底图空白，取消选择与选中框。图片命中优先从顶层向下采样点击处的 alpha；没有可见元素时，回退到包含该点的最上层外框，因此透明边缘也可选中素材，同时不遮挡下层可见内容。可编辑文字按文字框命中。图层列表仍可显式选择底图和透明层。`useLayerViewport.ts` 负责视图手势；`node scripts/layer-viewport-ui.test.mjs`（apps/desktop）覆盖缩放锚点、复位、两种平移、工程不变、透明区域选择/外围取消、缩放后图层坐标、输入空格和失焦清理。

面板内 Ctrl+Z（macOS 为 Cmd+Z）与「撤销」共用最多 30 步工程历史，覆盖移动、尺寸、文字、样式与模式切换；拖动过程中撤销先恢复本次拖动起点。快捷键不传到外部画板，拆分/修改提示词仍使用输入框原生撤销，输入法组合过程不撤销工程。视图缩放和平移不进入历史。

### 素材角标与画布文字编辑（2026-09-15）

素材库、项目素材栏、画板独立素材图及素材组内可见图片左上角显示 Layers 图标，提示「有分层工程」。画板标记订阅同一工程 ID 集合，保存后同步刷新；与反推角标并排，且不拦截素材选择或拖动。启动时通过 `layer_workspace_asset_ids` 一次查询本地工程指针的资产 ID，不读取图层图片、不逐缩略图调用 IPC；旧工程及带待取回任务的工程均显示。成功保存/取回、合成新素材后立即更新角标；保存失败不提前标记。角标跟随轮播当前素材。

画布和图层列表双击尚无文字副本的前景图层时，弹窗提供「识别文字后编辑」与「创建空白文字对象」两个等宽、同等样式的选项卡，只用中性选中标记区分当前项。下方显示对应说明，底部统一「取消 / 确认」；切换选项卡（支持左右方向键、Home / End）不触发转换或云端请求。识别说明为「保留识别到的文字，尝试匹配颜色与粗细，之后可在画布修改。需要登录 Bowerbird，无法完整复刻原图特效。」不再展示计费与次数说明，后台计费规则保持不变。空白选项统一文案为：

> 把该图层转变为空白文字对象（沿用框体）。转变后会丢失原图样式及文本内容。可使用本机字体进行替换。

取消不改变图层。选择空白对象后显示并聚焦画布文本框，无需登录、不上传图片、不扣积分。选择识别会尝试保留实际文字、颜色、粗细与对齐，不保证复刻原图特效或字体；识别为空时保留图片。已转换文字双击直接在画布编辑。支持光标插入、选择替换、中文输入、空格和换行；一次连续画布输入作为一条撤销记录。Esc / Ctrl+Enter 结束画布输入，输入法组合过程不误退出；点击画布空白结束输入并取消选中。缩放时文本框随图层缩放。右侧内容与字体设置同步保留，可继续设置字体、字号、颜色、粗细、对齐、行距和字距。

`ImageLayer.text` 是可选的本地文字对象，包含内容、字体、字号、颜色、粗体、对齐、行距、字距和内部排版尺寸；空白转换不继承原文字内容，识别转换保留识别结果，两者均不继承原图特效；原 `dataUrl` 保留为恢复/撤销用图片备份。旧 schemaVersion=1 图片工程兼容，空文字对象可保存重开；预览与合成导出共用 Canvas 排版，图层移动、缩放、显隐、不透明度仍生效。换行/自动折行在图层范围内绘制，超出范围裁切。

Windows 字体来自原生 GDI 字体族枚举（系统/用户已安装字体，过滤竖排别名），只保存字体名称，不复制字体文件。缺失字体给出提示；其他平台暂提供基础字体选项。`layer_fonts` 在后台线程执行。

「恢复原图片层」仅切换显示模式：当前文字对象（包括旧版识别结果）移入 `textBackup`，保留内容、字体和全部排版样式。图片模式显示「切换为文字图层」；点击或双击该图层直接恢复文字并进入画布输入，不再确认转换、识别或收费。反复切换保留最新编辑，副本随工程保存，关闭重开仍可切回；图片模式预览/导出只使用原图片，撤销保留切换历史。单层 AI 修改产生新图片时清除旧文字及其副本，避免把旧内容切到新素材上。原生对 `text` / `textBackup` 执行相同约束；文字专项覆盖切换、完整样式保存重开及图片模式导出。

只有显式选择识别才生成 `textPending`（`allowCreate=true`），将账号、幂等键和灰底 JPEG 先保存，再通过既有 `understand-proxy` 提交；保存失败不提交。通过用户鉴权和 `understand_jobs` RLS 优先查原任务，响应丢失、重开或临时错误继续用原键恢复，不另起任务。成功结果先保存再清 pending；已知拒绝或空识别保留图片。旧工程没有 `allowCreate` 的 pending 仅允许查询，未提交则清除，不启动识别。图片与文字副本切换不产生识别请求。

专项验证：`node scripts/layer-text-ui.test.mjs`（apps/desktop）覆盖两种确认、画布/列表双击、取消、离线转换、空文字、画布光标/中文组合键/空格/换行、撤销、缩放输入、字体、保存失败/角标、重开、合成像素、恢复、取消选择、Ctrl+Z、旧 pending 不重发、显式识别中断恢复不重复提交、保存失败不提交及空识别保留图片。`cargo test commands::layer --lib`（src-tauri）覆盖实际字体枚举、文字工程约束（含空文字）与持久化。截图 `apps/desktop/.tmp/layer-text-inline.png`、`layer-text-editor.png`。本轮为 Chrome 合成 IPC 验证，未重打安装包。

入口 `AssetContextMenu` → `store.layerEditor` → 全局独立 `LayerEditor`。原图、生成图、项目素材与详情图共用菜单。打开时冻结素材 ID 与项目 ID；保存不根据当前路由临时改变归属。

面板包含元素拆分提示词、尺寸、服务报价、图层列表、拖动、右下角等比缩放、数值坐标/宽高、名称、显隐、不透明度、上下移层与撤销。底图固定底层；隐藏层不参与合成。右上角提供「舍弃修改 / 暂时退出」，并以小字显示「有未保存的修改」。舍弃只丢弃尚未保存的改动并关闭，保留上次保存工程；暂时退出自动保存当前工程及最近 30 步撤销记录，保存失败保留面板和全部编辑。Esc 和点击遮罩走暂时退出；画布文字输入中的 Esc 仍只结束输入。拖动中退出也保留本次拖动起点，重开后 Ctrl+Z 可立即回滚。云端等待期间允许暂时退出，已落盘的原任务及历史保留，重开后继续取回，不重复创建任务。本地写入和导出执行期间等待操作完成再退出。

`commands/layers.rs` 提供四个 IPC：

- `layer_workspace_load/save`：每素材一条 `analyses(kind=layer_workspace)` 指向 `<library>/layers/<ULID>.json`。文件含完整 PNG/JPEG data URL、编辑参数及可选 history，不依赖过期下载 URL；不可变新文件写入并 sync 后事务交换指针，再删除旧文件。库迁移同时复制 layers。
- `layer_cloud_request`：仅允许分层创建、报价与原任务查询/取消，经既有 AuthClient 发往 generate-proxy。成功包验证同源下载、字节数与 SHA-256。
- `layer_export`：合成 PNG 作为新资产入库，另存独立图层工程副本，原图不会被覆盖或被去重合并。原图和合成图均可右键继续编辑。

撤销历史使用可选 `history: { images, documents }`，兼容无历史的旧工程。快照只存图层属性和图片索引：负数 `-index-1` 引用当前工程图层图片，非负数引用去重的旧图片池；重复移动/改字不会复制整张图片。最近 30 步随手动保存、暂时退出和云结果保存一起落盘，文字识别及 AI 替换也保留之前的图层。原生校验快照结构、图片索引、历史步数及全部图片，沿用 256 MiB 总大小上限。`node scripts/layer-history-ui.test.mjs` 覆盖自动保存、重开撤销文字/转换/坐标/AI 原图、舍弃不写盘、失败保留、Esc/拖动中退出、云端等待退出与原任务恢复；截图 `apps/desktop/.tmp/layer-history.png`。

本地工程仍使用 Bowerbird 格式，并可另存 PSD / AI 工程。图层包上限 256 MiB，单输出图片上限 30 MiB；上限失败明确显示，不能漏层后报告成功。

### 导出 Photoshop / Illustrator 工程（2026-09-15）

面板底部提供「导出 PSD」和「导出 AI（需 Illustrator）」；使用系统另存为对话框，取消不写文件，导出成功不把本地未保存修改标记为已保存。导出包含全部图层（含隐藏层）的名称、顺序、位置、尺寸、透明度和当前显示模式；可编辑文字保持文字对象。图片层仍为位图，不自动矢量化。文字/原图切换的备用对象仍留在 Bowerbird 本地工程，外部工程仅导出当前模式。

- PSD：动态加载 ag-psd 31.0.2 写 RGB / 8 bit 工程，独立像素层加 Type Tool 数据、图层预览和完整合成预览；不依赖 Photoshop。ag-psd children 使用从底到顶顺序；设置 noBackground，避免 Photoshop 把底层改名/锁定为背景。Windows 通过 GDI 字体 name 表解析 PostScript 字体名（例如 Arial → ArialMT），保留字体、字号、颜色、粗体、对齐、行距和字距。显隐与透明度保存为图层属性，不烘焙进像素。累计工作像素限制 6400 万，单层 PSD 尺寸不超过 30000，输出上限 256 MiB；超限明确失败。
- AI：当前支持 Windows 上已安装且能正常启动的 Illustrator。Rust 在独立临时目录落图片与受控 JSX，经隐藏 PowerShell / Illustrator COM 调用创建新文档、逐层放置并嵌入图片、创建区域文字，使用 IllustratorSaveOptions 保存原生 AI（含 PDF 兼容预览）。不将 PDF 改扩展名伪装 AI；图片不依赖外部路径。脚本只关闭新建导出文档，恢复已有活动文档及交互设置。字体不能匹配时给出警告；Adobe 与浏览器排版引擎不同，外部软件打开后应复核换行、字体替代和特殊粗体效果。
- 两者仅在完整文件生成后，以目标目录临时文件原子替换目的文件；失败保留旧文件。AI 串行导出，180 秒未响应返回错误且不改目的文件；超时的独立暂存目录保留，避免仍在 Illustrator 内执行的脚本失去输入。未安装/未登录/启动异常显示明确错误。全过程不调用云端、不扣积分。

代码入口：`lib/layerExport.ts`、`commands/layer_export.rs`、`layer_export_ai.jsx`。`node scripts/layer-project-export-ui.test.mjs` 覆盖系统对话框、取消/失败、PSD 重新解码（尺寸、层序、隐藏、alpha、位置、文字/字体、合成像素）与 AI 参数传递；`cargo test commands::layer --lib` 覆盖目的路径、原子覆盖、无效 PSD 不覆盖旧文件与字体解析。原生集成测试需显式运行 `native_adobe_export_smoke -- --ignored` 并指定 `BOWERBIRD_EXPORT_SMOKE` 到上述 UI 夹具输出目录。

2026-09-15 已在本机 Photoshop 27.9.1 / Illustrator 30.7.0 真实打开隔离合成 PSD / AI，检查层序、名称、隐藏、透明度、可编辑文字和字体，实际替换测试文字后不保存关闭；AI 验证 3 个嵌入图片、1 个文字框、0 外部链接。证据文件 `apps/desktop/.tmp/layer-project-export/`。未修改用户素材或文档，未重打安装包。格式参考：[ag-psd](https://github.com/Agamnentzar/ag-psd)、[Adobe AI 格式说明](https://www.adobe.com/creativecloud/file-types/image/vector/ai-file.html)。

## Cloud 与计费

复用 `generation_jobs`、预授权、租约/心跳、VPS generation worker、generation-temp、下载签名、SHA-256 与 TTL。没有新增 Agent Runner。

两个独立服务：`image_layer_decompose`、`image_layer_edit`。0061 仅登记 **active=false、unit_cost=0、pricing_ready=false**；数据库约束禁止未设置正价格与 pricing_ready 时启用。不添加普通生图下拉用 label，避免分层出现在普通生成 provider 菜单。

报价由 `generate-proxy action=layer_quote` 返回。价格未定/未启用时按钮显示“服务待开放”。未来按一次完整拆分或一次单层修改配置独立价格；如果选择按返回张数计费，应先改预授权/结算契约再启用，不能只改前端文案。

Worker 用共享 `layer-contract.ts` 在 submitted 前再次验证操作与 service 绑定，禁止通过普通图片档位请求拆分。专用结果 MIME 为 application/json，整个包包含所有层的字节和坐标；Edge/数据库限制图层服务与包 MIME 对应。底图缺失、重复层级、坏坐标、缺透明通道或部分返回都拒绝。已提交后结果解析/下载/上传失联进入 outcome_unknown，保留待结算，不自动重跑。已知上游拒绝沿用退款；成功沿用幂等完整任务结算。

提交前桌面持久化 idempotency_key、所属用户、完整请求和编辑目标。继续取回先 get_by_key，已存在则只查询；仅确定 not_found 时使用原幂等键创建。完整结果落本地后才清 pending。停止等待不取消上游任务，关闭后可从原素材重开继续查询；跨账号不能接续原任务。云端 TTL 后未取回的产物不能恢复，账本保留。

部署准备包含 `Dockerfile.generation` 和 `Dockerfile.unified-harness-candidate` 的新增共享协议文件。2026-09-14 已同步迁移 0061、generate-proxy/generation-worker 与 VPS Worker；桌面构建已包含入口。用户授权先以 20/23 积分测试价启用，正式价格另定。

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

最终验收状态见 `PROJECT.md`。合成 IPC 不代表原生 WebView2 或真实模型质量验收，夹具显示的 20/23 积分不是正式产品价；用户后续授权线上暂用同一组测试价。

## 2026-09-14 云端部署

- 0061 已在生产登记；两个服务 active=true、pricing_ready=true、pricing_stage=test。整图拆分 20 分/次，单层 AI 修改 23 分/次，正式价格另定。
- generate-proxy 35 → 36、generation-worker 27 → 28，均保留线上 verify_jwt=false（分别在函数内验证 Auth 用户 / 专用 Worker token）；其余 12 个函数版本和鉴权设置保持。
- VPS Worker：`sha256:c0048df86cf23eab8b0a03cd1464119989273f0bed01c037b30b7d3c34487be4`。基于原 be46bf7c 镜像只覆盖 cloud-generation runtime/layers 与共享 layer-contract/image-metadata；保留 DSH 模型与当日输入参数修复，不改环境密钥。四个消费循环正常、重启 0，非 root/只读，renderer healthy。
- 切换前检查四队列无执行中任务；服务器隔离候选镜像测试 11/11，视频 ffprobe 离线探针通过。
- 回滚镜像：`bowerbird/generation-worker:rollback-layer-20260914`；远端源备份 `/opt/bowerbird/deploy-backups/layer-20260914/source.before.tar`，本地 Edge/数据库函数快照与部署证据 `.tmp/layer-deploy-20260914/`。回滚时先将两个分层服务 active=false，保留迁移和已产生的图层任务/账本，待执行任务完成后再切回旧 Worker；不要删生产任务或直接回退 JSON MIME 约束。

**分层云端真实验收（2026-09-14）：** 两个临时账号各执行一次真实 Seedream 5.0 Pro 调用成功：整图拆分返回 2048×2048 底图和两个透明元素层，单层修改返回透明 PNG；完整包字节数和 SHA-256 匹配。实际扣费分别为 20/23 积分，重复 create 与 get_by_key 均返回原任务，数据库每任务 attempt_count=1。未登录报价及普通服务绕过被拒绝；两个临时 Auth 账号已删除，任务与积分账本保留审计。原生桌面完整链路仍由用户实际试用确认。

真实测试任务：拆分 `6d6c38d8-32f2-4e2b-837d-08dfd331d641`；单层修改 `ade26dbb-7f5b-45d1-a58c-e726b00651e5`。本地证据 `smoke.json`、`jobs-after.json` 与结果图层包均位于 `.tmp/layer-deploy-20260914/`，不含登录令牌。
