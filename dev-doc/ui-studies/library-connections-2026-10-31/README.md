# 文件夹连接交互预览 · 2026-10-31

本页记录独立预览的入口与验证。产品范围及当前阶段以 `PROJECT.md`「素材库连接与真实集合」「分身与磁盘操作」「目录刷新与双端定位」为准。连续分组版本已获用户确认，并已接入正式组件与后端源码；本目录保留独立模拟预览。正式实现见 `dev-doc/FOLDER-MODE.md`。

## 运行

在仓库根目录运行：

```powershell
node apps/desktop/scripts/library-connections-preview.mjs
```

打开 [本机预览](http://127.0.0.1:17871/scripts/fixtures/library-connections/preview.html)。默认深色，可用右上角切换浅色；底部 Windows／macOS 仅切换示例路径展示，「重置预览」恢复内存示例。

源文件位于 `apps/desktop/scripts/fixtures/library-connections/`。预览复用现有工业主题、`LibrarySelectionMark` 和瀑布流几何；示例图片直接使用仓库已有 UI 研究素材，不依赖外部图片地址。无 Tauri 桥接、生产 store、数据库或真实文件写入；刷新网页会重置所有模拟操作。

## 审阅路线

1. 默认定位「品牌素材」的 5 项直接素材。向下滚动依次接上「产品」「细节」「视频」「灵感」，再继续到其他连接根目录；目录顺序不受左侧折叠影响。左上悬浮块显示当前集合，侧栏随滚动高亮；点击侧栏直接定位对应分组，最后一组也能到达视口顶部。空集合保留紧凑空态，不再提供「全部展开」。
2. 「建立连接」选择示例「旅行采风」，新增一个连接根目录和下级文件夹。侧栏标题处「新建集合」可填写示例保存位置；每个集合项右侧常驻 ＋，直接在该目录下「新建集合」。更多菜单只保留改名、移动、移到回收站等操作，根目录另有断开连接；按钮和弹窗不再使用「父集合／子集合」。
3. 素材右键「添加到集合」，或拖到目录，创建 `.bowerbird` 分身。去「项目参考／春季提案」检查分身图标、详情和单独选择。删除／改名／移动分身不改变原件；删除原件或所在目录使外部分身显示失联。
4. 「移动硬盘／往期影像」提供离线状态；切换 macOS 后重新定位，检查路径变化和素材身份保持。
5. 检查图片／视频筛选、全部／标签素材去重、选择标记、键盘目录导航、菜单与弹窗，以及深浅主题。继续保持正式应用搜索暂时隐藏的约定。

视频使用静态封面示例。刷新、初次连接进度、回收站及跨端路径是行为示意，不代表真实索引、视频播放、系统回收站、跨盘校验或 Mac 原生验收已完成。

## 验证入口

在 `apps/desktop` 目录运行：

```powershell
node --test scripts/library-connections-model.test.mjs
node scripts/library-connections-ui.test.mjs
node node_modules/typescript/bin/tsc --noEmit --jsx react-jsx --target es2021 --module esnext --moduleResolution bundler --lib dom,dom.iterable,es2023 --skipLibCheck --allowSyntheticDefaultImports scripts/fixtures/library-connections/preview.tsx
```

模型检查覆盖不可变状态、目录范围、独立条目身份、分身不复制素材、原件失联、移动子树、删除子树、断开／重连以及 Windows 路径重命名。浏览器检查使用独立端口 17872，拦截非本机网络请求，截图与结果写入 `apps/desktop/.tmp/library-connections/`。不运行正式桌面应用或操作用户素材库。

2026-10-31 **初版验证**：模型 **16/16**、Chromium **10/10** 场景、预览入口 TypeScript 检查通过。初版浏览器覆盖目录层级／递归、类型筛选、分身增删／独立选择、建立连接、子树移动和删除后的外部分身、失联重连、键盘目录／菜单／弹窗，以及 1500／900／390px 深浅主题；无脚本错误、资源失败或外部网络请求。窄屏原继承的 760px 最小宽度已在预览作用域重置。初版已人工查看桌面深浅主题、目录菜单与窄屏截图。

本轮连续分组修订：Chromium **11/11** 场景及预览 TypeScript 检查通过。覆盖完整目录顺序与折叠独立性、实际滚轮跨组／跨根目录、悬浮块位置、侧栏定位、空集合／末组定位、常驻 ＋ 创建位置及文案，保留分身、文件夹操作、键盘与 1500／900／390px 深浅主题检查。重连按钮明确定位操作所在分组，弹窗打开期间不跟踪底层滚动，焦点恢复不改变滚动；重连取消和成功均保持原集合。无脚本错误、资源失败或外部网络请求。人工查看 `continuous-pinned-dark.png` 和 `light-390.png`；最新结果写入 `ui-results.json`，`failure-*.png` 保留作前轮诊断。

真实实现仍需验证：目录增量索引与中断恢复、稳定素材身份及数据库迁移、引用解析／随图资料恢复、只读目录与失联、跨盘移动／回收站，以及 Windows 和 macOS 的原生端到端行为。

## 正式组件验证

连续分组预览已获用户确认，正式组件已接入。隔离入口为 `scripts/fixtures/connected-collections/preview.html`，加载真实 `Toolbar`、`LibraryHome`、`ConnectedCollections` 和 `VirtualCatalog`，只使用模拟 IPC。`node scripts/connected-collections-ui.test.mjs` 已通过目录顺序、折叠后代、悬浮标题、末组定位、分页与有限渲染、分身独立选择、目录操作、取消／成功连接、页签路由，以及 2505 项选择按 2000 项分批的检查。深浅色截图在 `.tmp/connected-collections/production-dark.png` 和 `production-light.png`。

`node scripts/connection-ingestion-ui.test.mjs` 已通过 Windows／macOS 文件路径粘贴原位连接、纯位图首次保存、剪贴板读取失败与无路径拖入不复制、目录目标分身写入、HEIC 异步显示及滚轮缩放。后端实现和原生验收边界见 [FOLDER-MODE](../../FOLDER-MODE.md)。

旧 `node scripts/file-drop-ui.test.mjs` 已按原位文件路径适配并通过，保留折叠／展开项目目标、路由冻结、批次失败隔离、内部拖放和探索混合载荷检查；集合目标改为创建分身，不再测试虚拟集合写入。
