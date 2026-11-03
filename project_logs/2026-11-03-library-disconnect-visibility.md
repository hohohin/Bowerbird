# 2026-11-03：断开连接后的素材库可见性

## 根因与复用决定

`disconnect_directory` 原先只删除连接根／目录和条目。`assets.store_path` 仍指向用户原文件，`thumb_path` 仍指向派生缓存；原件没有被复制，也没有删除。全部／标签查询把仍存在的外部素材身份视为可展示，因此断开后继续显示的是可读取原件的素材索引，不只是孤立缩略图。

复用目录连接的删除事务、`material_catalog`／`CatalogFilter` 的公共筛选、`external_files::link_external_to_library` 的明确收藏入口。独立记录“断联”和“明确独立收集”，不借用画板 `library_hidden` 字段，不删除标签、分析、画板或项目身份，不增加触发器。

项目成员只在对应项目素材库内保留展示；仅画板引用不构成主库继续展示的理由。另一目录仍有原件或分身条目、已明确独立收集以及受管素材继续保留。旧收集箱等文件工作区路径通过 `LibraryPaths::managed_file_root` 核验，不能仅凭 source/external_assets 判断（受管文件也可能通过外部索引建档）。重连恢复原身份；原件或缓存都不物理清理。

旧版本已经断开的残留，无法从历史字段可靠区分独立收集与已断开的目录来源，因此升级不根据路径猜测批量隐藏。历史连接下既曾单独收集、又曾加入连接的同一外部身份，其先后来源旧库没有记录，无法无损回填；新明确收集有持久依据。

## 行动与验证

1. 新增正式数据库行为测试：断开唯一根后退出全局但项目成员仍可用；写入画板可见性不会使其复活；重新连接复用身份；另一连接及明确独立收集不被误隐藏。
2. RED：先新增核心行为测试，由主代理统一构建并运行临时清单测试程序，`disconnect_hides_global_catalog` 在“disconnected source must leave global catalog”断言失败，复现旧行为。
3. 实装迁移 0051：`disconnected_library_assets` 与 `independent_library_assets` 独立记录来源；只回填没有目录条目的历史独立成员。断开删除与断联事实同事务；重连条目注册与清标记同事务。明确收集入口 `link_external_to_library` 同事务记独立来源并清断联，`ingest_file`（含文本）复用此入口。
4. `material_catalog` 的公共可见性过滤由分页、图谱、计数、标签、常用素材以及旧列表／搜索／智能筛选／色板查询共用；项目查询仍要求真实项目成员，单纯打开原件不会恢复主库成员。
5. 新增实际画板节点保留及最后节点移除、全查询路由一致性、失败回滚、旧版 0050 升级／重复重开、没有独立来源标记的旧收集箱原件、独立收集／重连恢复身份测试。GREEN：主代理统一构建 Windows 隔离测试程序，`folder_connections` 50 passed、`catalog_browser` 7 passed / 1 ignored、`material_catalog` 11 passed、`core::library` 48 passed、`external_files` 13 passed / 1 ignored；合计 129 passed / 2 ignored。包括 0050→0051 保留原身份／标签／分析并重复重开、重新连接恢复同身份、旧收集箱原件保护、实际画板最后节点移除不复活等新断联回归。两个 ignored 为现有跳过项，未当作通过。
6. 已核对即时刷新：后端 `disconnect_folder → mutation` 发 `library://assets-changed`；`CategorizedLibrary` 在 120ms 去抖后更新 revision，分页和计数随之重读；`App` 的旧全局列表监听 300ms 刷新；无需用户重启。
7. 未操作用户素材库，未物理删除原件／派生预览，未提交或推送。

最终只读复核：`disconnect_directory` 和 `trash_connected_directory` 的所有调用已传入 `LibraryPaths`；前端 IPC 参数不变。修改文件 `git diff --check` 通过。新表仅按素材身份主键查询，无新增触发器，无原件／缓存删除。
