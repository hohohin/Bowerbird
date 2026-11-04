# 探索采集直接归入落点标签

## 行动与原因

1. 按 ub-mode 核对 PROJECT、开发计划／复用地图、探索、分类和文件夹契约。现有标签目录和分组已经提供 `data-tag-id`／`data-tag-section`；手动拖动素材使用全局／项目 `localClassification.example`，因此复用该入口，不新建标签体系。
2. 新增正式 ExploreWorkspace 与采集历史的隔离浏览器回归。修改前在指定标签落点得到预期红灯：仍调用了 `claim_source_browser_analysis`（1 而非 0）。实现松手冻结标签、项目和去重后素材身份，显式标签跳过分类认领、完成及轮盘，失败重试只补交付。
3. 核对后台自动入队触发器，确认仅在前端补标签存在竞态。为单次采集增加可选 `skipClassification`，普通调用保持原参数；原生插入素材和移除自动队列项在同一 SQLite 事务内完成，去重命中已有素材也移除待处理项。保留原字节格式识别、保存、去重、来源、项目归属和全局分类开关。
4. 松手时即释放该拖动的预分析，原生采集再次确认释放并跳过预分析字节认领／绑定。开始拖动时目标未知，松手前已发送的请求无法追溯撤回；没有宣称此前不会发生预分析。自动命名和既有标签不作额外改动。
5. 默认落点回归发现旧测试仍使用已替换的 `set_collection_members` 和旧错误提示。只更新该测试为当前 `create_material_references` 与采集历史交付失败状态，验证集合冻结／切换项目／失败清理，未修改其产品逻辑。
6. 原生测试首次启动报 Windows `0xc0000139`，核对既有记录后确认需 Common Controls v6 清单；仅给 `.tmp/explorer-tag-drop/native-tests.exe` 隔离副本补清单，不改系统或运行应用。pnpm 沙箱扫描依赖报 EPERM 后直接使用已安装本地 TypeScript 编译器，不安装依赖。
7. 执行 crapper、dryer 和官方 mutator；两个初次存活的变异暴露未分类分组断言不足，补齐“不手动打标签／不提前取消预分析”，并增加视频标签落点回归。变异仅通过 Vite 加载隔离源码副本，不改生产文件。
8. 核对开发版已由现有 watcher 自动构建并启动：2026-11-04 11:47:46，PID 73388；EXE 写入时间 11:47:43，包含新 `skipClassification` IPC 参数，SHA256 `7091bd2c94994846e6136bb6717a711fe5f62ef0c110b2f0432ad75b90f48f14`。未再次手动重启或发布安装包。
9. 更新 PROJECT、探索／分类契约和复用地图；仅提交本轮代码、测试及文档增量。没有创建 worktree，保留其他任务的未提交修改和测试产物，不删除共享目录。

## 验证

- `explorer-tag-drop-ui.test.mjs`：全局标签目录、项目分组、异步期间标签改变、交付失败重试、未分类回退、视频标签；不认领分类、传原生跳过标志、及时释放预分析、不展示轮盘；通过。
- `explorer-import-targets-ui.test.mjs`、`explorer-classification-dock-ui.test.mjs`、`explorer-capture-canvas-retry-ui.test.mjs`：通过。
- Rust `commands::source_browser_capture::tests::`：6 通过；包含新素材／去重素材跳过队列、人工 origin、全局开关不变，以及原图片／视频采集回归。
- Rust `core::ingest::tests::`：20 通过、1 条既有 FFmpeg 夹具测试忽略；`core::local_classification::`：100 通过、6 条既有真实模型测试忽略。合计 126 通过、7 忽略。
- 本地 TypeScript `--noEmit` 与 Vite production build 通过；Vite 仍有既有大 chunk／混合导入提示。`git diff --check` 通过。
- Mutator：标签识别、取消、分类跳过、人工标签交付相关 12 个变异全部被行为测试杀死，结果在 `.tmp/explorer-tag-drop/mutations.json`。
- Crapper：新增薄包装 CC 1，事务入库函数 CC 6；现有大组件／采集／字节入库仍超过 CC 10，没有覆盖率映射，因此 CRAP 显示 N/A，不宣称整文件达到门槛。Dryer 0.8 扫描只报告既有 library.rs 重复查询，未发现本轮新增重复；不为本次标签行为改写无关查询。报告在 `.tmp/explorer-tag-drop/`。

浏览器使用正式组件、模拟 IPC 与官方目录落点属性；Rust 测试使用隔离数据库和本地媒体，不调用付费服务或操作真实素材库。本轮没有重新执行真实 Pinterest／小红书账号到 OS 拖放的全链路验收。
