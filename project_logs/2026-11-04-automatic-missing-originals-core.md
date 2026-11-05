# 2026-11-04 自动失效条目检查：核心实现

## 范围与复用

用户明确要求自动检测并清理失效素材。本子任务负责核心检查与事务复用；主任务负责既有连接刷新队列的后台调度、文档与整体验证。读取 PROJECT、FOLDER-MODE、开发计划与复用地图、ub-mode。复用 0052 缺失原件事实、素材可见性查询、`preview_asset_originals`、已验证原件索引和现有缺失清理事务；不新增迁移、命令或文件回收路径。

## 实现

- `core/missing_originals.rs` 每批最多检查 128 条，返回游标续扫、待确认及实际移除/恢复计数。普通现存文件只读取文件状态；每批最多尝试一个需要指纹验证的恢复。
- 同一素材身份、登记路径、指纹和卷序列号至少两次缺失观测、间隔 30 秒，才提交缺失清理。期间原件重新出现、路径/身份变化或无法确定状态会重置观测。
- Windows 仅接受在线固定本地盘：拒绝 UNC、映射盘、设备路径、相对路径、父目录跳转，以及沿途任一符号链接、junction/reparse。父目录整段缺失时，仅在卷在线、最近存在祖先可枚举的情况下接受缺失；权限与未知错误跳过。操作前再次确认卷和缺失，事务内再次核验路径、指纹与 NotFound。
- Mac 和其他平台缺少历史卷身份，无法可靠识别自定义 NAS 挂载卸载后的残留普通目录，本轮自动检查保守跳过；已有手动清理保持可用。
- 恢复仅针对带 0052 标记且原件确实重新出现的条目，先验证原登记指纹再调用索引。不同内容替换不会自动恢复。相同路径已有可见身份时不反复哈希旧重复身份；恢复计数采用实际标记变化。
- `folder_connections.rs` 从手动确认中小范围提取 `cleanup_missing_original`：只改数据库可见性与集合条目，不含 recycle 回调。原文件、缓存、资料、身份及项目/画板数据保留。

## TDD 与检查

- 先写无动作核心及 2 项真实临时文件/SQLite 行为测试，经主任务完整 crate 编译、嵌入 Common Controls 清单的独立 EXE 实际 RED：持续缺失时 removed=0，期望 1。证据 `.tmp/automatic-missing/backend-red.txt`。
- 最小实现后相同 2 项实际 GREEN。证据 `.tmp/automatic-missing/backend-green.txt`。
- 补齐共 13 项边界测试：分批与 NULL 历史字段、短暂恢复重计时、固定盘整段目录缺失、非法/未知路径、真实临时 junction、SQL 失败回滚与重试、提交时恢复拒绝、不同内容拒绝恢复、重复路径身份、项目视图成员以及隔离目录真实 ACL 权限拒绝。主任务统一构建后最终 **13/13 通过**，包括真实 ACL 与 junction。
- 新模块 rustfmt 已完成；默认沙箱路径规范化返回 os5，经审批使用相同单文件格式化命令成功。未格式化整个旧模块、未运行并行 Cargo、未写用户真实素材库。
- 主任务对最终核心/调度进行质量扫描：核心恢复函数 CC=10，其余新增/整理函数不超过 9；未接入 Rust 动态覆盖率，CRAP 记为 N/A，不能报告通过 CRAP<10。dryer 阈值 0.8 无重复；核心检测 57 个变异点仅是静态枚举，不能称已执行。调度独立副本的 7 个实际变异已被行为断言捕获，证据和范围见主日志。
- 首轮完整边界执行 12 通过、1 失败，真实 ACL 测试通过。唯一失败来自测试用 `PathBuf::push("..")` 先把 Windows verbatim 路径规范化成真实现存原件，未向正式守卫输入预期非法路径。仅将该测试改为字面路径拼接，保留 `..`；生产规则未改，重新构建后 13 项全部通过。证据 `.tmp/automatic-missing/core-final.txt`。
- 同生产源码相关回归：folder_connections 56、material_catalog 11、catalog_browser 7、library 48、external_files 13、canvas_frequent_assets 14、connected_media 11、commands 调度 6，合计 166 通过、2 项既有忽略；连同本模块最终 **179 通过、2 忽略**。未扩大到无关全库测试。新开发 EXE 构建、总文档和交付由主任务处理，本子任务未提交。

## 本子任务文件

- `apps/desktop/src-tauri/src/core/missing_originals.rs`
- `apps/desktop/src-tauri/src/core/folder_connections.rs`（仅缺失清理事务小提取）
- `apps/desktop/src-tauri/src/core/mod.rs`（新增模块声明）
- 本行动日志
