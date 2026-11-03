# 快传接收队列真实缩略图

日期：2026-11-03。范围为桌面快传接收行及隔离验证；不改 App、后端协议或原件，不提交。根代理负责完整 App 验证、存档和提交。

## 依据与复用

- 按 `PROJECT.md`、`UI-DESIGN-SPEC.md`、`USER-FACING-ERRORS.md`、开发计划及 ub-mode / ui-ux-pro-max 执行。技能检索 `image lazy loading reserved space --domain ux` 命中按需加载、合适尺寸和容器缩放；保留 40px 图位与真实颜色，使用 `object-fit: contain`，不加额外说明标签。
- 独立审查确认快传入库通过轻量文件登记，新图片、HEIC、视频的 `thumb_path` 常为空。因此批量使用 `api.getAssetsByIds` 取已入库身份，再复用 `externalFiles.preview` 的现有原生缓存、HEIC 兼容转换和视频封面。未另造缩略图生成器、未播放视频、未增加 HTTP 读库接口。
- `get_assets_by_ids {assetIds}` 返回 Asset 数组，按 `id` 映射，不依赖返回顺序；`external_files_preview {path}` 返回本地预览路径，通过 `convertFileSrc` 进入图片展示。音频与文本保留类型图标。

## 行动与结果

1. 先扩展隔离 desktop fixture，加入不同颜色的真实 PNG、反序资产响应和可延迟的 metadata / preview IPC。新增浏览器像素测试。首次端口 0 被项目 Vite 配置解释为 5173，遇现有服务占用；改用任务端口 1603，没有停止其他服务。这次启动错误不计作 TDD 红灯。
2. 在修改生产组件前实际运行新测试，等待“红色照片.heic 缩略图”超时：原接收行确实只有图标。根的实际 App 测试也独立复现无 img。
3. 新增 `src/lib/quickTransferThumbnails.ts`：已完成 assetId 集合变化时只补取新增 ID；元数据返回按身份关联，进度或重排不重复取数据；移除不再属于当前集合的请求缓存。失败只保留图标，不改接收或入库状态，重开允许重试。
4. 接收 Queue 自持现有 `createFilePreviewQueue`，四并发，随面板卸载释放；每行复用 `useMediaVisibility`，不可见行不请求或解码。清理取消未开始工作，已开始任务完成不会更新已卸载行。预览身份包含 assetId、原件路径、thumb_path、mtime 和 size；状态只允许当前身份的图片显示，防止复用行串图。
5. `QuickTransferQueue.tsx` 增加紧凑 40px 真图位，保留文件名、进度、结果和重试交互。`QuickTransferPanel.css` 使用现有 `--bb-surface-2` / `--bb-line`；审查时发现初稿误用未定义的 `--bb-border`，已改正。

## 实际验证

- `node scripts/quick-transfer-thumbnails.test.mjs`：先红后绿。对浏览器真实解码图片绘制到 canvas 并检查 RGBA，红色 HEIC 预览为 `[227,38,54,255]`，蓝色视频封面为 `[37,85,217,255]`。这验证组件消费的生成预览，不冒充浏览器原生 HEIC 解码能力；原生格式转换由根另行验证。
- 覆盖反序元数据映射、批量与增量 ID 查询、9 次进度变化不增加请求、重排、收起重开、恢复后 assetId 到达、旧元数据迟到、旧预览在收起后迟到、复用同一行时新图等待期间隐藏旧图、缺失资产、文本、坏图解码回退、metadata IPC 失败重开恢复，均保持正确接收状态。
- 100 条列表实测最多四个 preview IPC 并行；收起后只让已开始的四个任务结束，不继续排空隐藏队列；远端第 100 条在面板打开时不解码，滚动至该行后取得正确像素。
- `node scripts/quick-transfer-desktop.test.mjs` 绿：保留开启/关闭、默认目录、配对、真实二维码解码、收起、进度与恢复、安全中文错误、无网卡、Tab/Esc、深浅色/窄屏滚动及迟到状态保护。
- `pnpm exec tsc --noEmit` 绿。根独立实际 App 像素测试也已绿；其原生预览与整体构建证据记录于本轮总日志，不重复声称为本代理执行。
- 亲看深浅截图：`apps/desktop/.tmp/quick-transfer-thumbnails/received-dark.png`、`received-light.png`。真实红蓝图和图标在稳定位置、保持原色/完整画面，正文与弹层不透明。截图为隔离合成素材，不涉及用户库。
- 运行器在 finally 关闭本轮浏览器和 Vite，无新增常驻服务。未操作用户库、网络配置或真实上传。

## 质量工具与边界

官方 crapper / dryer / mutator 委托 `integration_audit`，已提供冻结生产路径与自然行为变异候选（当前预览身份保护）；最终数值、实际变异运行和未采集覆盖率边界以其本轮审查日志为准，不把静态枚举计作变异测试通过。

初扫指出 `useQuickTransferThumbnail` CC15；按输入选择与订阅生命周期分工，提取 `resolvePreview` 统一处理媒体类型和版本 key，hook 仅保留可见性、失败与订阅。真实浏览器缩略图测试再次全绿后冻结，交由审查代理复扫。

缩略图失败不影响入库成功。收起重开会重新请求当前元数据及预览路径，后端复用既有媒体缓存；不在顶栏常驻保留或解码所有历史缩略图。未验证真实手机、Mac 或安装包，此次结论限已执行的桌面浏览器及根另记的原生隔离测试。
