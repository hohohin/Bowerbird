# 集合重命名重复与断联修复

## 根因与实现

用户报告集合重命名后出现两个同名集合，一个正常、一个断联。核对命令层后确认扫描与磁盘修改已有共用 GATE 串行化；问题在 `repoint_tree` 将源目录自身的空相对后缀也传给 `Path::join`，生成带末尾分隔符的字符串。扫描按字符串路径查找，另建新 ID，再把旧路径标记为不可用。

- 源目录本身直接使用目标路径，后代才拼接相对路径，改名／移动／重新定位共用。
- 每轮扫描前读取该连接的目录 ID／路径，事务修复旧尾分隔符；同根规范路径已存在时保留旧集合 ID，迁移新重复行下的素材条目、子目录及项目关联，再移除重复行。
- 不按名称去重；磁盘根路径不裁剪，其他连接占用相同规范路径时保守跳过。离线记录也能作词法修复，磁盘可用性继续由正常扫描判定。整个恢复只改索引，不复制、改名或删除原文件。

## 行动与验证

1. 读取 PROJECT、架构入口及文件工作区协议，检查前端重命名调用与后端扫描／路径更新，独立代理并行审查。
2. 增加真实临时目录复现：根目录、子集合和后代共 3 个集合，重命名后扫描变为 4 个，明确失败 `left: 4, right: 3`。
3. 修正共用路径映射，补充历史重复恢复；测试造祖孙两层污染、双方条目／项目关联和子目录归属，确认原 ID 与所有关联保留。
4. 增加离线／同名不同路径不误并、事务故障回滚，既有子树移动、根移入另一连接、重新定位测试追加连续两次扫描检查。
5. `cargo test --locked --offline --lib --no-run` 完整测试目标编译通过；既有 6 条无关 warning 保留。默认沙箱最初被路径访问权限阻断，正常权限构建通过。
6. 原测试 EXE 缺少 Common Controls v6 清单，启动报 `STATUS_ENTRYPOINT_NOT_FOUND`。沿仓库既有处理，仅复制测试 EXE 到 `.tmp/collection-rename/backend-tests.exe`，用 Windows SDK `mt.exe` 嵌入 Common Controls v6 清单后运行，不修改正式 EXE／构建脚本。
7. 临时测试副本执行 `folder_connections core::external_files:: --nocapture`：**70 passed / 0 failed / 2 ignored**；两条忽略项为既有环境依赖。结果在 `.tmp/collection-rename/results.txt`。本次新增复现与恢复测试全部通过，修复差异独立复核。
8. `cargo build --locked --offline --bin bowerbird-desktop` 已编译生成 `target/debug/deps/bowerbird_desktop.exe`，最终替换 `target/debug/bowerbird-desktop.exe` 因当前开发应用占用失败。新文件保留在 `.tmp/collection-rename/bowerbird-desktop.exe`。用户明确答复「已保存，可以重启」后，正常关闭旧进程，保留旧 EXE 至 `.tmp/collection-rename/bowerbird-before.exe`，替换并启动新开发程序。新 EXE SHA-256：`42fc6fc4c35a010717b5b0b042683cb25fcca6ebee977a08d33f72dde23e7551`。
9. 新窗口先因原有 1420 前端服务已停止而显示连接失败；恢复既有 Vite 开发服务后，原生窗口正常加载素材库及真实素材。未再次改名用户集合作验证，修复结果的身份与恢复断言以上述临时库测试为准，实际旧记录沿正常刷新自动修复。
10. 更新 PROJECT 踩坑记录及文件工作区说明，仅本地提交本任务代码、测试与文档，其他工作区改动保留。

测试使用临时目录／内存数据库；用户授权后已正常重启开发版，未直接改写用户数据库、未改动用户原文件。未发布安装包，Mac 原生未实机重验。界面布局与交互未改变。
