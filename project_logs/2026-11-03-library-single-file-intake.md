# 2026-11-03：无需连接文件夹的单文件收集

## 范围与复用

本次遵循用户明确要求：未连接任何文件夹时，也可将图片、视频、音频、文本单独拖入，原件保存在 `BowerbirdLibrary/收集箱`。拖入已连接目录中的素材，或应用已经管理的文件，继续引用当前原件；建立文件夹连接本身不复制文件。

开工核对 `PROJECT.md`、`FOLDER-MODE.md`、开发计划复用地图、`reuse/SERVICES.md`、`USER-FACING-ERRORS.md` 与 `ub-mode`。候选接口包括 `ingest_file`（原位引用）、`ingest_new_file`（首次保存，不支持文本）、`LibraryPaths.asset_store_path`（现有收集箱）和已有 `video_import_*` 分块 IPC。选择复用收集箱与分块 IPC，新增小型 `file_intake::collect` 处理明确收集，不改变普通引用调用的行为。

## 行动记录

1. 追踪 `FileDropImport → importDroppedMedia`：HTML `File` 通常没有本机 `path` 字段，旧分支在读取内容前报“无法取得原文件位置，请使用建立连接”；旧 `video_import_begin` 同时硬性拒绝接收。是否存在连接并不是实际阻断条件。
2. 先新增 `single-file-intake-ui.test.mjs`，在隔离 Chromium 中调用真实 `importDroppedMedia`，PNG 首例复现上述错误。此为有效前端 RED；未将 Rust 编译或旧测试记录为新增用例 RED。
3. 恢复兼容名称 `video_import_*` 的文件接收，使用 1 MiB 分块，限制单文件 2 GiB、同时最多四个会话，并在新会话开始时清理 15 分钟未活动会话。取消或失败时删除临时接收数据；不删除用户源文件。空文本允许接收。
4. 新增 `file_intake::collect`：已连接／已管理路径使用现有原位入库；其余文件通过 `LibraryPaths.asset_store_path` 进入共享收集箱。临时文件写入、flush、sync 后 `persist_noclobber`，ULID 名称避免覆盖同名文件。保留显示名称，使用 `link_external_to_library` 记录明确独立收集。已配置但不可用的资料目录沿用现有错误，不静默换位置；其他失联连接不阻断本次收集。
5. 拖入已知路径使用 `api.importFiles(..., collect=true)`；没有路径的 `File` 使用分块接收。普通媒体引用／已知文件剪贴板仍保持原位，纯图片剪贴板仍使用首次保存入口。
6. 项目归属仍沿既有项目成员接口写入；收集文件统一保存到共享收集箱，不因项目目的地而重定向。入库后保留原有 asset protocol scope、自动分析和变更通知。
7. `FileDropImport` 提示统一为“添加”，避免默认收集继续显示“连接”。更新原有连接入口与拖入目标回归断言，未改布局。

## 验证

- `node scripts/single-file-intake-ui.test.mjs`：通过。真实前端导入函数覆盖 PNG／MP4／WAV／Markdown、没有 `File.path`、1 MiB 分块偏移、空且无 MIME 的 Markdown、已知路径收集参数、失败取消、纯位图粘贴。
- `node scripts/connection-ingestion-ui.test.mjs`：通过。Windows／macOS 文件剪贴板保留原位、位图首次保存、没有路径的拖入进入收集箱并创建集合引用、已有路径收集参数、HEIC 预览兼容。
- `node scripts/file-drop-ui.test.mjs`：通过。项目／全局／集合目标、项目切换期间冻结归属、批次失败隔离、普通文件混合文本、内部素材拖动保留与新的添加提示。
- 主代理使用新编译的 `.tmp/library-upgrade/backend-green.exe` 执行 Rust 用例：`core::file_intake` 1/1、`commands::media_import` 4/4 通过。覆盖四种媒资字节完整与源文件保留、所有格式同名重复不覆盖、项目目的地不重定向、已有连接与已管理文件不复制、完整／不完整分块、取消只清临时文件及项目成员关系。字节接收的四种格式均通过同一个 `MediaUpload::finish → file_intake::collect`；独立收集成员记录复用 `link_external_to_library` 的事务，与断联隐藏修复兼容。
- 相关文件 `git diff --check` 通过（仅现有 CRLF 提示）。所有测试使用临时目录／内存数据库／模拟 IPC，没有访问或修改真实用户资料库。

## 边界

浏览器回归与 Rust 隔离测试不替代 Windows／macOS 正式安装包的真实桌面拖入验收。本子任务仅本地修改，不提交、不推送、不重启用户程序。共享文档与统一提交由主代理处理。

## 最后审查补充

只读审查发现新文件保存后直接 `index_external` 会绕过原 `ingest_file` 的图片感知哈希、颜色索引及预设资料识别。预设识别实际依据 `preset-XX` 文件名匹配既有 manifest，不是通用 PNG 嵌入数据解析。新增携带既有预设创作资料身份的真实 PNG 回归，并保留文件字节完整断言；由主代理统一执行该回归后，再以最小调用调整复用既有逻辑。通用嵌入数据解析不在此次变更范围。

主代理重新编译后取得实际 RED：`collected_png_keeps_color_metadata_and_preset_generation_history` 在 `collection must preserve normal image indexing` 断言失败。随后将副本保存后的索引调用改为 `ingest_file`，并使用原文件名调用现有预设识别；文本沿原有语义跳过图片预设识别。最终重新读取已更新资产，独立收集标记保持幂等。不存在递归：`ingest_file` 只调用底层索引，不回调 `file_intake::collect`。

主代理对最终源码重新编译并实际执行：`core::file_intake` **2/2**、`commands::media_import` **4/4**、`core::preset` **7/7** 全部 GREEN。新增用例证明副本保留图片索引、预设 `generation_meta`／会话与可重建生成历史，并且源文件与保存副本的字节均未改变。之后未再修改代码。

## 本子任务文件清单

- `apps/desktop/src-tauri/src/core/file_intake.rs`（新增收集入口与两条回归）
- `apps/desktop/src-tauri/src/core/mod.rs`（模块导出单行）
- `apps/desktop/src-tauri/src/commands/library.rs`（明确收集参数与路由）
- `apps/desktop/src-tauri/src/commands/media_import.rs`（复用分块接收与四条回归）
- `apps/desktop/src/lib/api.ts`（可选收集参数）
- `apps/desktop/src/lib/mediaImport.ts`（已知路径／无路径文件入口）
- `apps/desktop/src/components/FileDropImport.tsx`（添加提示文字）
- `apps/desktop/scripts/single-file-intake-ui.test.mjs`（新增真实前端函数回归）
- `apps/desktop/scripts/fixtures/single-file-intake/preview.html`
- `apps/desktop/scripts/fixtures/single-file-intake/preview.ts`
- `apps/desktop/scripts/connection-ingestion-ui.test.mjs`
- `apps/desktop/scripts/fixtures/connection-ingestion/preview.tsx`
- `apps/desktop/scripts/file-drop-ui.test.mjs`
- `project_logs/2026-11-03-library-single-file-intake.md`

`ingest.rs`、`external_files.rs` 与独立收集／断联数据库迁移由断联子任务维护；主代理统一维护权威产品文档、复用地图及质量工具记录，未归入上述子任务修改。
