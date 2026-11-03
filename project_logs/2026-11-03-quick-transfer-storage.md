# 2026-11-03 快传原件保存与连接登记

- 范围：仅全局真实收件目录、隔离临时库验证；不操作用户库、不提交或推送。
- 已先阅读 PROJECT 当前约定、文件夹连接专项、架构及 ub-mode。按原件保留契约选择隐藏暂存 → 完整校验 → 不覆盖原子发布 → 既有连接索引，避免旧 ingest_new_file 的 HEIC 转 PNG 路径。
- 先新增行为测试及尚未实现的领域接口，覆盖路径穿越／类型、半文件、同名不覆盖、重复完成、数据库失败后恢复、单写者与取消，待观察红灯后实施。
- 红灯：7 项行为测试均在 `open` 未实现处失败（0 passed / 7 failed），包含新增 HEIC 原字节保留与最终路径冲突。首次沙箱构建被权限阻断；正常权限编译通过，但测试 EXE 遇仓库既有 Common Controls v6 清单缺失，复制至 `.tmp/quick-transfer-storage/storage-tests-red.exe` 并仅给测试副本嵌入清单后执行。未改正式 EXE／build.rs。
- 当前 Rust 1.90 实测，Cargo 声明 1.85；不使用 1.89 才稳定的 File::try_lock。已有应用 single-instance 插件，存储再按 canonical 收件目录使用进程内单写者注册与 Drop 释放；公开操作为 `&mut self`，网络引擎仍不直接接触数据库。
- `prepare` 冻结客户端无权指定的暂存／最终位置，网络以 create_new 打开暂存路径；`mark_received` 校验完整类型、长度与指纹并持久化 Ready 后才允许网络回执成功。`complete` 原子无覆盖发布原件，调用既有连接索引，登记失败保留 Saved，重启仅恢复 Ready／Saved，Receiving 半文件不会误入库。
- 主路径不转换原件；HEIC 仅用临时 PNG 验证是否可解码，最终保存字节保持一致。仅允许常用图片／视频／音频及 UTF-8 文本，SVG／PSD／可执行文件／分身文件不属于首版快传格式。格式清单以领域层常量为唯一入口；手机文件名不作为路径接受。
- 行为测试补至 10 项：真实连接扫描忽略半文件、Ready 在最终路径冲突后重启恢复、恶意 manifest 不得指向目录外、文本编码／大小、持久回执后重启及重复确认。仅原文件重传导致不同 upload ID 的跨传输去重未新增，单 upload ID 保持路径和 Asset 身份。
- 根集成负责使用现有文件夹变更 GATE 串行登记，避免与监听器／目录移动同时操作；同步媒体校验与文件复制必须在阻塞工作线程运行。
- 绿灯：根统一构建后的 `.tmp/quick-transfer-runtime/tests-green.exe` 执行 **18 passed / 0 failed**，其中本领域层 **10/10**、真实 HTTP→保存→素材库端到端 **1/1**、传输层 **7/7**。保留原件、重启恢复、无覆盖、边界拒绝与单写者的专项均通过。Mac／真实手机／正式安装包尚未验收。
- 质量工具：官方 crapper／dryer／mutator 在 `.tmp/quick-transfer-quality/snapshot` 的隔离副本实际运行。沙箱 parser DNS 失败后，正常权限准备官方 Rust grammar，三工具退出 0。首次 CC 暴露媒体分支、manifest 加载与完成混合职责，沿既有 10 项绿灯测试拆为类型校验、加载、发布、登记；最终 storage 所有函数 CC ≤ 9、dryer ≥0.8 无重复。未测覆盖率，CRAP=N/A；mutator 仅扫描未执行，不能称击杀。报告及源哈希在 `.tmp/quick-transfer-quality/REPORT.md`；职责拆分后的统一行为复跑结果见下条。
- 最终统一验证：根使用 `.tmp/quick-transfer-runtime/tests-final.exe` 执行 **23 passed / 0 failed**（storage **11/11**、transport **9/9**、runtime **3/3**），包含伪装 MP3／MP4／HEIC、PNG 假扮 JPG、真实 HTTP→入库和迟到取消不降级已保存状态。未操作真实用户库或手机。
- 最终源码质量复扫：storage／runtime／transport 全部扫描函数 CC ≤ 9，包含修正后的 runtime `failed`（CC 7）；dryer ≥0.8 无重复；mutator 对三个生产文件枚举 **174** 站点（90／23／61），未执行变异。源哈希已与工作区四个对应文件逐一核对一致。遵守根要求不额外编译；现成 tests-final.exe 不能验证变异源码，故没有把它作为 mutation 执行或击杀证据。
