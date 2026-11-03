# 2026-11-03：画布拖出全息反馈实装

用户明确确认透明投影预览后授权实装。改动限于拖出反馈、缓存拖影和对应测试；未操作用户素材库、替换运行程序或发布安装包。

## 行动记录

1. 阅读 ub-mode、PROJECT、架构入口、画板、UI 规范及外拖契约。检查工作区并保留其他任务的编辑器、创作预览、截图和 Agent 修改。
2. 将用户三轮反馈收敛为透明投影、素材原位置的轻量轮廓、无底板文字与无留白缩略图；移除照搬参考的全屏弧环。独立候选保留于 `scripts/fixtures/canvas-drag-hud/`。
3. 正式桥新增可见 HUD 与减少动态效果断言，旧代码以 `0 !== 1` 失败。抽出共享投影与 HUD，接入原 body 模糊容器；Canvas 只提供素材屏幕范围，保留原取消、身份与移动交接。17 项桥测试转绿。
4. 原生缓存解码测试先用空实现运行，两项按预期失败，再实现受限读取与尺寸／透明像素／边角测试。后台不创建原文件副本或新缩略图，无缓存保留图标。缩略图不成为文件载荷。
5. Windows 新建顶向下 32 位 BGRA DIB，Mac 复制 RGBA 到 AppKit。实际位图测试首次在 Shell 接收后读取旧 HBITMAP 失败，定位到所有权已转交；改为交接前检查像素、交接后检查 IDataObject 的 `DragImageBits`，成功后不重复删除位图。旧图标也共用该交接。
6. 默认 Rust 构建先遇沙箱拒绝访问，提升后等待其他构建锁；没有终止其他任务。测试 EXE 初次报 `0xc0000139`，按仓库惯例仅在本轮临时副本补 Common Controls v6 清单。清理 PATH 不能解决此问题，未改系统环境。
7. 正式 Canvas 早期截图捕获渐显起始帧，延后 500ms 并断言 HUD 与投影存在。夹具补齐真实 App 的工业主题与 dark 属性，修复夹具深色画布／浅色全局文字不一致；正式代码保持主题变量。
8. 前端独立 Vite 构建通过。完整 TS 存在 37 条编辑器依赖类型错误；在本轮源文件恢复 HEAD 的隔离副本再次检查，归一化路径后诊断逐字一致。没有用忽略类型错误或改动编辑器掩盖它们。
9. 执行仓库已安装的官方 crapper／dryer／mutator：三个新／相关 TS 模块快照，新增展示函数 CC 1–2；旧 `startExternalDrag` CC 26，覆盖率与 CRAP 为 N/A，未为数值夹带重构。dryer 阈值 0.8 无重复；mutator 仅扫描候选，没有宣称实际变异执行或覆盖率达标。首次帮助输出遇 GBK 编码，设置本进程 UTF-8 后运行。证据 `.tmp/drag-hud/quality/`。
10. 删除已结束的本轮红灯测试 EXE 副本，保留最终测试 EXE、类型诊断与质量报告；没有清理其他任务的临时目录或工作树。
11. 同步 PROJECT、UI 规范、外拖专项与候选说明，检查范围后单独提交。Mac 代码仅源码适配，本机未进行 Mac 编译／真机；浏览器控制 IPC 和 Shell 位图测试不替代用户真实跨应用投放。

## 验证结果

- Rust `external_drag`：18 passed，包含缓存尺寸、颜色、透明像素、超限／损坏回退、实际 Shell 拖影数据、原件内容不变与会话取消。
- 正式拖动桥：17 场景通过；正式 Canvas 长按／普通移动／组内素材／生成会话／多选与迟到取消回归通过。
- 独立候选深浅主题与拖动预览通过；正式前端 Vite 构建通过。完整 TS：修改前后相同的 37 条诊断，仍未全绿。
- 保留 600ms／4px 原手势；未对系统拖放注入鼠标事件，未向真实对话或云端发送文件。

官方 API 依据：[InitializeFromBitmap（straight alpha）](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-idragsourcehelper-initializefrombitmap)、[CreateDIBSection](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-createdibsection)、[NSDraggingItem](https://developer.apple.com/documentation/appkit/nsdraggingitem/setdraggingframe(_:contents:))。位图消费与数据对象写入另外由本机实际测试核验。
