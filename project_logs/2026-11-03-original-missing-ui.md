# 2026-11-03 缺失原件的删除确认

## 范围与复用

复用 `CanvasAssetDeleteDialog`、`assetOriginals.preview/trash`、`ModalShell`、现有逐项执行和失败重试。`AssetOriginal` 增加可选 `missing`，旧响应未提供该字段时保持正常原件回收行为。后端原件核验及失效条目清理由主任务实现，本记录只覆盖前端。

- 全部原件缺失时，标题与确认按钮为「清理失效条目」，说明原件已不在登记位置，只从素材库移除，保留资料。
- 现存／缺失混合时使用「确认删除」，分别说明回收和移除语义，缺失项显示状态。沿用现有确认框和列表布局。
- 复用同一删除命令传回冻结的 missing／路径／指纹目标，不在前端猜测历史别名或寻找替代原文件。取消不发送操作。
- 成功回收与清理分别计数，跨失败重试累计结果；失败后只保留未完成项。错误继续通过 `userErrorMessage`，未知清理错误使用明确中文兜底。
- 缺失原件仍可显示现有缩略图；没有缩略图时使用已有文件图标，不请求缺失路径。缺失视频不触发原件封面修复。

## RED → GREEN

在既有 `original-deletion` 隔离预览中增加合成 `missing` 响应，新建 `scripts/original-missing-ui.test.mjs`，调用真实菜单、确认框与前端接口。

有效 RED 先复现：纯缺失仍显示「删除原文件」、成功通知仍宣称原件已回收、混合目标仍显示旧标题、部分失败后剩余缺失项仍使用回收文案。新增无缓存用例又复现缺失项仍创建请求原路径的图片。修正后 5 个场景全部通过，页面错误和远程请求均为空。

首轮沙箱启动出现 Vite realpath EPERM 与浏览器 loopback 限制，不计为产品 RED；之后在允许的本机隔离 Chromium 运行得到上述断言失败和 GREEN。

验证（目录 `apps/desktop`）：

- `node scripts/original-missing-ui.test.mjs`：5 场景通过，包含取消、冻结载荷、混合操作、失败重试累计计数以及无缓存缺失项不请求原件。
- `node scripts/original-deletion-ui.test.mjs`：通过，正常原件回收、读取失败、同路径去重、忙碌保护和既有重试保持兼容。
- `node scripts/collection-delete-actions-ui.test.mjs`：未通过，最后调用预览 `window.changed()` 后等待失联标记超时；页面报 `Cannot read properties of null (reading 'revision')`。同一测试以 Vite 内存插件加载 `HEAD` 旧版确认框，仍在同一行失败并报同样三次页面错误。隔离基线脚本位于 `.tmp/original-missing/baseline-collection-delete-actions.mjs`，未改正式组件或该 fixture 来绕过问题。
- 相关改动 `git diff --check` 通过；完整 TypeScript／Vite／质量检查由主任务统一执行。

真实组件深浅色与混合状态截图位于 `apps/desktop/.tmp/original-missing/`：`missing-dark.png`、`missing-light.png`、`mixed-dark.png`，已检查。主题转换截图等待颜色过渡结束，未修改产品主题样式。

所有操作为合成 IPC 与本机独立浏览器，没有自动确认真实库操作、回收文件、清理用户条目或重启程序。未提交或推送。
