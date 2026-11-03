# 探索采集悬浮缩略图去留白

## 范围与行动

- 用户要求采集时悬浮缩略图四周无空白，容器符合当前视觉规范。沿用 ub-mode 与 ui-ux-pro-max，读取项目、探索、分类、UI 规范及复用地图；保留其他任务修改。
- 复用网页与主工作区同一个 `explorerDragVisual.js`，保持 pick/move/update/land/settle 接口及采集链路。当前固定 96×112 容器、5px padding、contain 造成外框与比例空带；原分类预览还将补白至 512×512 的 Jev 模型输入当展示图，需两处同时处理。
- 界面按实际图片比例缩至既有 96×112 上限，透明背景、无 padding／圆角托盘，完整保留内容与 alpha；贴边方点、中性色与工程蓝沿现有媒体规范。动态尺寸同步到指针边缘、标签与落点中心，不增加标签文案。
- 分类侧将展示预览与模型用图分开，模型原先 512 白底规则保持，展示使用无补白 PNG；不裁剪真实白色画面，不改变原件、分类请求或计费。

## 验证与交付

- 先冻结旧脚本并实跑红测：4 个深浅／源主矩阵、2 个落地场景因 5px padding 失败，旧横图卡片 96×112、内部图片框 86×102，存在白边与绿色比例空带；312px 主面板的旧说明越界约 6.75px。独立 parity 不把前置失败算另一个回归。
- 正式 `scripts/explorer-drag-visual-ui.test.mjs` **10/10 通过**：横／竖／方／透明图完整显示，源网页与主面板尺寸一致，深浅主题、旧请求拒绝、同请求换图、边缘、落地居中、settle／clear 与减少动态效果均通过。主线程与独立测试代理目视浅色源端、深色主端和窄窗／落地截图；横图 96×48、竖图 42×112、方图 96×96，卡片与图片同尺寸。
- 后端先得到 512×512 与预期 512×256 不符、JPEG 与预期 PNG 不符的红测。最终 explorer 分类与模型预处理专项 **9/9 通过**，验证横竖尺寸、无新增边、alpha、真实白色内容、无效输入及原模型补白；一次有界解码／方向校正后分别生成显示 PNG 与模型 JPEG。过程记录 `.tmp/explorer-drag-visual/native-log.md`、绿测输出 `preview-green.log`，未调用分类模型或付费服务。
- `cargo build --offline --example explorer_smoke --target-dir target-local-classification` 成功；既有 `scripts/verify-native-explorer.mjs` 增加两端比例与透明底断言，最终 **exit 0**。原生 source 走实际文档初始化与真实起拖，main 隔离夹具加载同一正式 factory 后调用公开 API，均为 96×48、零 padding／圆角、透明底，落点中心为 100,200；清理、Cookie 取图、视频、部分响应拒绝、正文选择、遮罩、页面保持与远程 IPC 回归通过。main factory 验证不冒充 React hook 的原生全链路。
- 原生证据 `.tmp/explorer-native-1793726032878/visual-result.json`；测试强断言二进制包含当前 JS 字节，最终 SHA256 `7d11d085b207d0f7dec9c36fdfee02083211f605bdc448bbdb39bc5b3e4dc9fb`。自身浏览器、Vite 与原生测试进程均清理。
- 既有 `explorer-classification-dock-ui.test.mjs` 未进入产品行为：旧 `fixtures/explorer/preview.tsx` 缺少 `quick_transfer_status` mock，返回 null 导致当前快传控件读取 revision 失败、首屏空白。只诊断并记录，未改无关产品或把该项计为通过。
- ub-mode 实际 crapper／dryer／mutator：完整脚本运行取得 V8 覆盖，原字节／原行号 helper 投影供工具归属，本次 move 实测 CRAP 8.0、onload 7.4，其他新增 helper 更低。onerror 原始 V8 未执行，不采用单行赋值导致的虚假 100% 指标，按 0 覆盖保守计算 CRAP 6。完整脚本行覆盖 97.54%、分支 93.87%；不声称旧总 factory／全部闭包都达到门槛。dryer 0.8 无重复；75 位点中定向执行比例、扇区宽度与父边界 3 个变异，3/3 杀死。Rust preview_image 的 dryer 通过，crapper 无覆盖探针进程崩溃，没有伪报 Rust 指标。详情 `.tmp/explorer-drag-visual/quality.md`。
- 更新项目约定、视觉规范、探索与分类说明。按 ub-mode 仅提交本次代码、测试及文档并推送既有 dev；PROJECT 采用单独暂存本次条目，保留并行创作预览／失效素材工作。没有新建工作树，保留红绿与截图证据；没有重启用户应用、发布安装包、操作真实账号／素材库或宣称 Mac 原生验收。
