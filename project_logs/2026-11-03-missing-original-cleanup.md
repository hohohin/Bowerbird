# 2026-11-03：失效原件条目的明确清理

## 根因与范围

删除预览原先直接对登记的 `assets.store_path` 调用 `symlink_metadata`／`canonicalize`。原件已移动或删除而派生缩略图仍在时，普通 NotFound 被前端统一转换为“找不到所需文件”，用户无法清理条目。当前 Windows Shell 回收路径已转换 `\\?\`／UNC 前缀；此案例发生在进入系统回收站之前，与开发构建开关无关。

本次仅对明确返回 `Io(ErrorKind::NotFound)` 的已有登记路径提供 `missing=true` 预览。确认后复核路径未变且仍缺失，再记录独立的“移除缺失条目”事实，使所有素材库列表（含项目、固定素材与生成轮播）移除这些条目；不声称进入回收站，不调用物理删除，不改变素材身份、原始资料、缓存或项目／画板引用。权限错误、符号链接、非法媒体与没有登记路径的记录仍返回错误。

复用 `preview_asset_originals`／`trash_asset_original` IPC、`material_catalog::library_membership_sql` 及已有成功原件索引恢复入口。新增 0052 `removed_missing_asset_originals(asset_id,path)`；与回收原件、断开连接分别记录原因。重新成功索引原件才清除此事实，单纯加入主库不会把缺失文件重新显示。

## 行动与验证

1. 先写两个行为测试：缺失原件可预览并清理素材库展示、保留原身份／标签／缓存／项目成员；确认后文件恢复或登记路径变化必须拒绝旧确认。
2. RED：主代理统一构建并运行两个新行为测试，均在旧预览 unwrap 处收到 Io(os code 2, NotFound)，确认复现。
3. 实装 0052 独立事实，预览增加 serde(default) 的 missing 布尔字段；普通回收仍复核路径与指纹，失效清理仅处理仍然 NotFound 的登记路径。相同路径普通／Windows规范写法的多份身份一次清理；原件目录条目删除、分身条目标记失联并失效mtime，以便恢复时绕过原先的unchanged快路重新核验索引。
4. 缺失过滤不适用0051断联的项目豁免：素材列表和项目标签计数排除missing，但project_assets、画板节点、显式ID读取继续保留。成功索引／明确重定位原件时清missing标记，单纯重新加入主库不清标记。
5. 已补6项专项：身份／缓存／项目留存与各素材列表排除、确认过期、重复登记路径和恢复扫描、SQL失败回滚、51→52迁移重复重开、画板节点留存及最后节点移除不复活。GREEN：主代理统一Windows隔离构建通过；`folder_connections` 56 passed、`material_catalog` 11 passed、`catalog_browser` 7 passed / 1 ignored、`core::library` 48 passed、`external_files` 13 passed / 1 ignored、`canvas_frequent_assets` 14 passed、`connected_media` 11 passed，合计 **160 passed / 2 ignored**。两个ignored为现有跳过项，未当作通过。先前两个新增RED均为真实Io NotFound失败，不是编译或环境失败。
6. 修改源码git diff --check通过；未访问／修改用户原件，未提交或推送。

## 本轮后端文件

- `apps/desktop/src-tauri/sql/0052_removed_missing_asset_originals.sql`
- `apps/desktop/src-tauri/src/db/migrations.rs`
- `apps/desktop/src-tauri/src/core/folder_connections.rs`
- `apps/desktop/src-tauri/src/core/folder_connections_tests.rs`
- `apps/desktop/src-tauri/src/core/material_catalog.rs`
- `apps/desktop/src-tauri/src/core/catalog_browser.rs`
- `apps/desktop/src-tauri/src/core/library.rs`
- `apps/desktop/src-tauri/src/core/canvas_frequent_assets.rs`
- `apps/desktop/src-tauri/src/core/external_files.rs`
- `apps/desktop/src-tauri/src/core/connected_media.rs`
- 本日志 `project_logs/2026-11-03-missing-original-cleanup.md`
