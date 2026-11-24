# 连接文件夹性能验证

测试使用 Windows（内部版本 26100）、本机 NTFS 临时目录、隔离 SQLite 和 Chromium 合成 IPC。原生计时采用 Rust debug 测试构建。P0 与开始实施前冻结的源码比较。P1 的原生基准在同一测试程序内对照整根与单目录扫描、串行与并行首连。界面基准使用相同合成数据、窗口大小和交互。

## P0 浏览和目录缓存

| 隔离场景 | 优化前 | P0 | 方法 |
|---|---:|---:|---|
| 写事务持锁 75 ms，目录浏览连接锁等待 | 75,472 µs | 10 µs | 共享写连接与独立只读连接，各 5 次，取中位数 |
| 1,001 文件无变更重扫，第一轮 | 116.59 ms | 44.34 ms | 1,000 个合成 MP4 和 1 个 PNG，单目录、磁盘 SQLite，各 7 次，取中位数 |
| 1,001 文件无变更重扫，第二轮 | 115.36 ms | 42.60 ms | 相同程序与夹具重复对照 |
| 普通目录 60 项当页组图阶段，当前／其他目录 80／200 项 | 1.189 ms | 1.151 ms | 预热后各 5 次，取中位数 |
| 当前／其他目录 100／10,000 项 | 2.187 ms | 1.573 ms | 同上 |
| 当前／其他目录 10,000／100 项 | 34.180 ms | 1.007 ms | 同上 |
| 模拟 90 秒后重开，全部／标签／文件夹额外读取 | 3／2／2 次 | 0／0／0 次 | 读取合成 IPC 请求数 |
| A 连续三次变更时，B 的在途分页读取 | 2 次 | 1 次 | 阻塞 B 首次响应，释放后检查重发和内容 |
| A 连续变更时，同根旁支／另一根热目录额外读取 | 1／1 次 | 0／0 次 | 切换与重新访问缓存目录 |

过期时间移除后，目录树与分页使用独立容量，目录变更保留无关页和预览补丁。组图预判复用现有生成归属与手动合并条件，普通目录页跳过 `folder_group_ids` 自连接。文件授权缓存达 16,384 项时淘汰最早登记的 2,048 项。Windows 批量读取视频变更时间同时保留原修改时间被恢复时的变更检测。[Windows 目录记录结构](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info)

## P1 增量对账和交互

| 隔离场景 | P0 对照 | P1 | 方法 |
|---|---:|---:|---|
| 1,153 个已登记文件中修改 1 个 MP4 | 51.12 ms | 4.19 ms | 扫整根 25 个目录与扫受影响的 1 个目录，各 7 次，取中位数 |
| 首次连接，首批索引可读 | 173.934 ms | 26.110 ms | 128 个约 3 MiB 的 BMP，首批 64→16 条，交替执行并预热后各 5 次，取中位数 |
| 首次连接，全部索引完成 | 348.024 ms | 191.863 ms | 相同 BMP，串行准备与最多 4 路准备，写入保持单事务按批提交 |
| 打开目标目录时新增 `IntersectionObserver` | 68 个 | 0 个 | 1,280×840 Chromium，P1 复用滚动容器已有的一个观察器 |
| 同场景预览 IPC | 12 次 | 12 次 | 使用相同页面夹具和预览输入 |
| 对已加载条目 Ctrl 多选时的核验 IPC | 1 次 | 0 次 | 同一可见条目，比较 `resolve_connection_entries` 调用 |
| 切换同一筛选下的目录时虚拟列表节点 | 重新挂载 | 保留 | 比较节点身份并检查目录滚动位置恢复 |

目录对账计时从扫描调用到完成。首连计时终点分别为首批索引可读和扫描返回。另一轮主机存在并发任务的对照依次为 90.42→7.06 ms、216.237→35.294 ms 和 462.573→272.826 ms。端到端等待还包括系统通知、去抖、预览解码和 WebView 绘制。

小文件继续在登记前完成 SHA-256，以便扫描后立即保有可用于恢复与移动的指纹。首批提前发布并行准备的结果，写事务内复核文件版本。在完整列举后才进行缺失对账。队列溢出、原生重扫提示、根重连、手动刷新及低频补查沿整根路径。已加载条目用于勾选，需要补读时用 SQLite，实际文件操作仍核验原件。

## 改动文件

- P0 原生源码（`apps/desktop/src-tauri/src`）包括 `db/mod.rs`、`core/catalog_browser.rs`、`core/folder_connections.rs`、`core/external_files.rs`、`core/library.rs`、`commands/folder_connections.rs`。原生回归位于 `core/folder_connections_read_tests.rs`、`core/folder_connections_tests.rs`，其余新增用例随对应源码维护。
- P0 前端源码（`apps/desktop/src`）包括 `lib/catalogCache.ts`、`lib/useCatalogRevision.ts`、`components/ConnectedCollections.tsx`、`components/VirtualCatalog.tsx`。调整 `apps/desktop/scripts` 下的 `catalog-cache.test.mjs`、`catalog-cache-ui.test.mjs`、`connection-refresh-ui.test.mjs`、`catalog-paging-ui.test.mjs`、`connected-collections-ui.test.mjs` 及 `fixtures/connected-collections/preview.tsx`。
- P1 原生继续修改 `core/folder_connections.rs`、`commands/folder_connections.rs` 和上述两个原生回归文件，Watcher 的路径识别与队列位于 `commands/connection_watch.rs`。
- P1 前端继续修改 P0 的四个源码文件，并修改 `components/FileMediaCard.tsx`、`lib/filePreviewQueue.ts`、`lib/folderConnections.ts`。更新 `connection-refresh-ui.test.mjs`、`connection-reconnect-ui.test.mjs`、`connected-collections-ui.test.mjs` 和 `helpers/catalog-context-selection.mjs`。
- 现行契约和复用入口位于 `dev-doc/FOLDER-MODE.md`、`dev-doc/reuse/DESKTOP.md`，本记录收录于 `project_logs/README.md`。

## 验证命令与覆盖边界

原生检查执行 `cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`。原生测试执行 `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib <过滤词>`。前端执行 `pnpm --filter @bowerbird/desktop exec tsc --noEmit` 和 `pnpm --filter @bowerbird/desktop build`。

| 验证项 | P0 | P1 |
|---|---:|---:|
| `cargo check --locked --lib` | 通过 | 通过 |
| `folder_connections`（含 Watcher） | 104 通过，6 忽略 | 106 通过，8 忽略 |
| `catalog_browser` | 11 通过，2 忽略 | 11 通过，2 忽略 |
| `connected_media` | 22 通过，2 忽略 | 22 通过，2 忽略 |
| `external_files` | 40 通过，4 忽略 | 40 通过，4 忽略 |
| `db::tests` | 5 通过 | 5 通过 |
| 原生通知后同大小、同修改时间的语义核验 | 1 通过 | 1 通过 |
| TypeScript 和桌面前端构建 | 通过 | 通过 |
| 指定的合成 IPC 界面回归 | 6 组通过 | 6 组通过 |
| 缓存与预览队列单元测试 | 9 项缓存通过 | 12 项通过 |

上表各原生验收组用例失败数均为 0。`external_files` 包含 `connected_media` 用例。默认忽略的基准从相同阶段的程序单独运行。P1 的目录回归覆盖首次准备让出前台后续扫新子目录。两阶段的 6 组界面回归为 `catalog-cache-ui`、`connection-refresh-ui`、`connected-collections-ui`、`folder-view-parity-ui`、`catalog-paging-ui`、`catalog-continuity-ui`。额外重连回归检查了局部进度先于整根恢复完成的情形。

Windows 原始 lib 测试程序启动曾返回 `0xc0000139`。P0 用 Cargo 刚生成的测试程序副本补 Common Controls v6 manifest 后运行各过滤组。P1 在 Cargo runner 内复制并给副本补同一 manifest。构建源码和安装资源沿现有配置。日志与原始样本保存在 [本地验证目录](../.tmp/folder-performance-verification/target/)。

测试覆盖临时目录的原生通知与重连、相同大小及同秒修改、恢复原修改时间的视频改写、离线索引保留、原件恢复、组图及解散、H3 和 Agent 归属，以及文件操作的核验路径。Mac 原生 watcher、真实 NAS、外接盘、真实回收站、跨盘文件操作与已安装应用的端到端耗时待各环境验证。系统只报告合并后的祖先路径时，具体子目录依靠低频兜底对账。

## 复审修订

媒体卡在每个滚动容器内共用两个观察器。屏内请求优先，视口外 400px 内提前预取，离开预取范围后取消尚未启动的任务。局部分页淘汰后，目录切回时同步绘制新鲜的会话快照。

`library://connection-progress` 用 `folderId` 表示局部扫描任务的范围，用可选的 `activeFolderId` 表示正在读取的具体目录。整根扫描的开始与完成沿用原有事件。局部状态保留同根其他目录的错误，重连只由整根任务的完成事件结束。首次订阅时若扫描已开始，界面先读取根级状态，再应用下一条目录进度。

复审验证通过 `catalog-cache-ui`、`connection-refresh-ui`、`file-preview-ui`，并补跑 `connection-reconnect-ui` 和 `catalog-continuity-ui`。缓存与预览队列单元测试共 13 项通过，TypeScript 和 `cargo check --locked --lib` 通过。`folder_connections` 原生测试 106 通过、0 失败、8 忽略。[原生复审日志](../.tmp/folder-performance-verification/target/review-native/)

SQLite 只读连接上的 `temp.catalog_provenance` 以 `PRAGMA main.data_version` 校验缓存。扫描的写事务会推进该版本，生成关联较多的素材库在扫描期间可能重建临时表。若后续基准确认这一成本显著，可以评估仅随生成相关表变更递增的持久化版本号。批内 worker 调度和 Watcher 查询连接列入后续评估。
