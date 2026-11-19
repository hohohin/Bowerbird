# 标注覆盖原文件

日期：2026-11-10（北京时间）。范围：桌面源码；不操作用户素材、不更新安装包、不部署云服务。

## 决定与行动

1. 阅读 ub-mode、PROJECT 当前约定、开发计划／复用地图、UI 规范、文件与画板契约、错误规范及 Windows 验证说明。使用 ui-ux-pro-max 的定向保存反馈查询，沿现有按钮与 tooltip；覆盖是明确命名的独立保存动作，不改变另存入口。
2. 核对图片标注、截图绘制、文本原件保存、视频覆盖、文件夹索引与画板加载。复用标注输出、原 `save_annotated_image` 命令、目录修改锁与事件、现有素材库缓存和画板水合；没有引入编辑引擎、表迁移或第二套图像变换。
3. 先写正式组件 Chromium 回归，观察“覆盖原文件”按钮不存在导致失败。接入第四个输出动作，编辑中／无编辑／不支持格式禁用；纯旋转也可保存。原始读取内容计算 SHA-256，服务端复查登记身份、路径、输入版本与元数据尺寸。
4. 新增命令内专用保存模块，复用 image 编码、缩略图、指纹和 tempfile。保持 PNG／JPEG／WebP／BMP 原扩展与编码；拒绝 GIF、APNG、动画 WebP 等无法保持动画的覆盖。输出与备份在原目录准备、同步，持数据库事务原子替换，事务提交失败还原原文件；恢复自身失败则保留备份路径供诊断。进程崩溃／断电恢复不在本轮保证范围。
5. 按同原路径的所有素材身份更新实际尺寸、文件大小、修改时间、唯一缩略图和内容指纹，失效旧颜色／pHash；保留名称、成员关系、人工资料与已有 analyses。每次追加 annotation，保留 transform／shapes，附加 save_mode、输入／输出 SHA-256；记录用于追溯，不是可恢复旧原图的版本备份。
6. 覆盖接入 `folder_connections::mutation`，与扫描及物理移动共用锁，统一发出素材和文件变更事件；标注分析事件保持。画板复用现有快照读取屏障与按素材尺寸计算卡片高度的逻辑，不修改节点身份或手动位置。素材库缓存沿原失效入口。
7. 修复 CanvasImage 的同路径缓存：唯一缩略图路径同时作为内容版本；分级预览请求、已加载结果和原图 URL 都随版本更新。覆盖后的横竖屏尺寸以及同尺寸镜像像素均实测。
8. 复核最终 diff，只提交本次相关片段；共享工作区其他任务的修改保留。未触碰正在使用的开发服务或真实原件。既有远程推送审批边界保持，本轮仅本地提交，不重试远程发布。

## 验证

- `scripts/annotation-overwrite-ui.test.mjs`：通过。真实 ImageAnnotator、CanvasWorkspace 和素材库组件＋合成 IPC，覆盖纯旋转记录、同一 ID、横图→竖图卡片与像素／素材库几何、连续同尺寸镜像缓存、再次编辑的输入版本、保存失败保留编辑器和重试。
- `scripts/annotation-toolbar-ui.test.mjs`：通过，800–1440 单行布局、滚轮描边、元数据与撤销。
- `scripts/annotation-tools-ui.test.mjs`：通过，文字／绘制、旋转／镜像／裁剪、像素与原有保存出口。
- `scripts/annotation-canvas-ui.test.mjs`：通过，原有添加到画板、持久化、保存失败重试不重复入库。
- `cargo test --locked --offline --lib ... --no-run`：最终测试目标编译通过。仅对独立测试 EXE 副本嵌入 Common Controls v6 清单后运行，未改正式应用。`commands::library::annotation::tests` 4/4 通过，包含受管／外部原件、四种编码与 alpha、多身份、只读／版本冲突／元数据拒绝、SQL 写入与 COMMIT 失败还原、重复保存记录及磁盘数据库重开。
- `commands::canvas_image_preview::tests`：9 通过、1 项原有耗时基准忽略，覆盖缓存、alpha、方向和动画保留。
- 完整 TypeScript 最终检查与独立 Vite 构建 `.tmp/annotation-overwrite-build` 通过；构建保留现有大 chunk、混合导入与第三方注释警告。
- 补充 `canvas-media-performance-ui.test.mjs --tiers-only` 未整组通过：512／1024／2048、DPR 与透明像素断言执行完成，随后等待旧“媒体预览”弹窗超时；脚本 `configFile:false` 同时出现现有 `@/` alias 预扫描警告。未修改这一无关脚本，也不将其计入通过数。
- ub-mode 的 crapper／dryer／mutator 在当前工具清单不可用，没有虚报指标或变异覆盖率。

本轮使用临时文件、临时 SQLite 与浏览器合成素材，未验收已安装程序、macOS 原生或真实网络文件系统；前后端需配套重建加载。未发布安装包。
