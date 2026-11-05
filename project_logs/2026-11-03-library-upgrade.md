# 2026-11-03：素材库拖放、收集与连接反馈修复

本轮按用户列出的五项问题直接修正正式组件，沿用已经确认的 HUD 和既有布局。使用 `ub-mode`，先复现行为、分工实施，再审查公共调用、旧库边界和回归。没有启动真实模型、修改用户库、替换运行程序或发布安装包。

## 复用与行动

1. 阅读 PROJECT 进展／约定、开发计划复用地图、文件工作区、外拖、视觉及错误提示规范。并行检查单文件入口、断联可见性和顶栏／目录控件；主代理维护共享外拖桥并统一验证。
2. 素材库外拖没有反馈的原因是 `externalDrag.ts` 只给 canvas 来源挂 HUD。现在两种来源共用 `mountExternalDragHud`、6px 静态模糊和 240ms 渐显、两帧绘制机会、取消 ACK 及清理逻辑。`FileMediaCard` 传入实际源素材矩形；原生缓存缩略图与原件交付沿用已验证适配器，不重复实现。
3. 先修改真实桥的 library 断言，得到旧逻辑不创建模糊层的失败；接入后通过。独立复核发现内部投递会遮住画板／集合目标，再增加内部目标清晰和跨边界切换断言，确认失败后修复：library 的 dragenter／dragover 隐藏反馈层，离开窗口恢复。仅 canvas 保持拒绝投回本窗口；内部 COPY 载荷与业务不变，所有事件监听在结束时清理。
4. 无 `File.path` 的 HTML 文件原先被前端拒绝，兼容分块接收后端也被硬禁用。复用 `video_import_*` IPC 与 `LibraryPaths` 收集箱，新增小型 `file_intake::collect`；没有连接也能收集，已连接／受管文件仍原位引用。持久化使用同目录临时写入、flush／sync 和不覆盖落盘；失败保留已持久接收的文件以便恢复。详细红绿、格式、上限和边界见 [单文件记录](2026-11-03-library-single-file-intake.md)。
5. 复核单文件保存时发现直接 `index_external` 绕过既有图片颜色、感知哈希和预设资料识别。新增真实 PNG 回归先红，再复用 `ingest_file` 与原文件名的 `preset::recognize_and_prefill`，最终通过。没有新增通用 PNG 嵌入元数据解析能力。
6. 断开原先只删目录关系，素材索引仍指向原文件、缩略图仍留在缓存。SQLite 0051 独立记录断联及明确收集事实；公共全局查询排除仅来自已断开连接的素材，保留其他连接、独立收集、受管文件以及对应项目成员。重连恢复原身份，不删除原文件／缓存／创作资料。迁移、事务和旧收集箱说明见 [断联记录](2026-11-03-library-disconnect-visibility.md)。
7. 顶栏复用 `canvasLibraryOpen` 和既有 global 素材栏入口；画板左上显示“素材库”，展开后旁边显示“建立连接”。移除集合名称固定 48px 预留，复用原有 hover／focus／菜单状态样式，新增 `is-menu-open` 保证菜单操作不中断。实际界面先红后绿，见 [控件记录](2026-11-03-library-controls.md)。
8. 更新 PROJECT 权威约定／最近三条里程碑和历史归档、FOLDER-MODE、EXTERNAL-DRAG、视觉规范。已有本地复用地图 DESKTOP／SERVICES 同步更新；这两份文件原本被 `.gitignore` 忽略且未跟踪，本轮不把整份无关地图强行加入提交。其相关接口语义已同时落入跟踪中的专项文档。

## 验证

Rust 使用实际主 crate `cargo test --locked --offline --lib --no-run` 编译。复制测试 exe 到任务临时目录并嵌入现有 Common Controls v6 清单后执行，避免本机已知无清单启动问题；全部为内存／临时库，不连接用户资料库。

| 范围 | 结果 |
|---|---|
| folder_connections | 50 passed |
| catalog_browser | 7 passed，1 原有 ignored |
| material_catalog | 11 passed |
| library | 48 passed |
| external_files | 13 passed，1 原有 ignored |
| file_intake | 2 passed |
| commands::media_import | 4 passed |
| preset | 7 passed |
| 合计 | **142 passed，2 ignored** |

断联覆盖旧版 0050→0051 升级／重新打开、查询和计数一致、事务失败回滚、旧收集箱、另一连接、项目／画板保留及最后节点移除不复活、重连身份。收集覆盖四类文件字节一致、同名不覆盖、项目目的地不重定向、已受管／连接不复制、完整与不完整分块、取消只清临时文件、颜色及预设生成历史。

正式前端隔离浏览器回归通过：`canvas-drag-backdrop-ui`（17 场景）、`external-drag-ui`、`canvas-drag-out-ui`、`canvas-drag-hud-preview-ui`、`single-file-intake-ui`、`connection-ingestion-ui`、`file-drop-ui`、`library-controls-ui`、`connected-collections-ui`。真实组件与业务桥使用受控 IPC，不将其当作操作系统跨应用验收。复核库内 HUD、画板顶部展开及深浅色窄栏截图。

独立 Vite 生产构建通过，产物在 `apps/desktop/.tmp/library-upgrade-build`。完整 TypeScript 仍有 **37 条**既有编辑器依赖诊断，与修改前 `.tmp/drag-hud/type-final.txt` 逐字一致；不宣称全库类型检查绿色。构建的大块提示与 Rust 原有警告保留。

## 质量工具与边界

- `crapper`、`dryer`、`mutator` 使用已有 `.tmp/ub-tools` Windows 适配器，在五份相关 TypeScript 文件独立副本执行；没有 Rust 覆盖率适配。crapper 无覆盖率输入，CRAP 为 N/A；既有大组件的复杂度仍高，不据此声称低于 10，也不趁本轮重构无关组件。
- dryer 阈值 0.8 未发现候选。mutator 扫描 363 处候选；另对本轮内部目标／离窗条件执行 3 处定向变异。第一轮 2 killed／1 survived，暴露测试没有覆盖目标自行拦截事件；补上目标 stopPropagation 后仍清晰的行为断言，最终 **3 killed／0 survived**，基线 17 场景通过。详细结果保存在 `.tmp/library-upgrade/quality/`，定向结果不等于全量变异执行或覆盖率。
- 所有新源文件、测试和文档按本任务范围提交；保留其他任务的创作预览、截图、临时产物等未提交修改。构建副本仅用于隔离验证，没有创建工作树或改动现有工作树布局。
- 旧版本早已断开的残留缺少可靠来源事实，升级不猜测批量隐藏；重新建立连接后再断开可按新规则处理。前后端需配套重建，当前运行程序／Windows 301 安装包仍为原版本；本轮 Windows／Mac 真实桌面拖入与原生视觉尚待验收。
