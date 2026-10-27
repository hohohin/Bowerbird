# 素材库样式备份 · 2026-10-26

同时保留**实装前的样式**和**用户确认的最新 Tactical 示意稿**。当前产品约定与发布状态以 [PROJECT.md](../../../PROJECT.md) 为准；此目录是固定时间点的恢复资料，不随之后的设计更新覆盖。

## 内容

- `before/`：改版前相关源码的原样副本，包含当时已经存在的未提交改动，不等于 Git HEAD。
- `approved-source/`：确认稿的示意源码，保留原有布局和最终动效参数。它依赖当时的应用组件；独立复现请使用下面的 `site/`。
- `site/`：实装前冻结编译的完整示意页，含示例图片，可切换原样式／新样式、深浅主题和闪动。
- `screenshots/`：原样式、深浅主题、吸顶状态和悬浮效果的固定截图。
- `integration.patch`：首次实装的原始增量，保持不变。
- `integration-with-focus-fix.patch`：包含首次接入及 10 月 26 日悬浮动效修复的累计增量，作为该阶段记录保留。
- `integration-clockwise.patch`：再加入项目入口强化、四方点顺时针移动和降低透明度，作为该阶段累计增量保留。反向应用可恢复实装前样式，保留此前已有的布局、分栏及其他改动。
- `light-gray.patch`：仅将浅色背景从 `#f5f4f0` 改为 `#e6e7e5`，作为浅灰背景阶段增量保留。
- `zones.patch`：区域区分试版，仅包含删除顶栏下方 hatchbar 的 `App.tsx` 增量，以及顶部／侧栏／瀑布流三层表面和顶栏空白轨道像素的 `LibraryTactical.css` 增量，作为该阶段记录保留。
- `switch-isolation.patch`：切换条串闪修复及对应回归，只在当前交互的是已选中标签时闪动共用选中底块。
- `structure-approved.patch`：用户确认的结构与项目管理配色接入；包含四份生产文件及两份配套 UI 回归的增量。顶部操作分组、克制的「我的项目」底色、标签管理按钮、侧栏刻度、分类真实数量均在此步。
- [`structure-approved/`](structure-approved/README.md)：本次接入前／后的六份源码、独立 SHA-256 清单和隔离恢复验证记录。**当前恢复依次反向撤回 `structure-approved.patch` → `switch-isolation.patch` → `zones.patch` → `light-gray.patch` → `integration-clockwise.patch`**；原冻结稿和此前补丁均保持不变。
- `manifest.json`：源码副本、冻结预览和本次接入文件的 SHA-256；用于检查备份完整性和后续修改。

## 查看冻结示意页

在仓库根目录运行（需要 Node.js，无需安装依赖）：

```powershell
node dev-doc/ui-studies/library-tactical-2026-10-26/serve.mjs
```

打开 [浅色确认稿](http://127.0.0.1:17865/?theme=light) 或 [深色确认稿](http://127.0.0.1:17865/?theme=dark)。左下「查看原样式」切换到实装前效果，Ctrl+C 停止服务。仅使用冻结示例素材，不读写真实素材库。

## 恢复实装前样式

先保存之后的工作区改动，在仓库根目录检查并撤回最新结构与配色接入：

```powershell
git apply --reverse --check dev-doc/ui-studies/library-tactical-2026-10-26/structure-approved.patch
git apply --reverse dev-doc/ui-studies/library-tactical-2026-10-26/structure-approved.patch
```

然后检查并撤回切换条串闪修复，以回到旧累计补丁的精确基线：

```powershell
git apply --reverse --check dev-doc/ui-studies/library-tactical-2026-10-26/switch-isolation.patch
git apply --reverse dev-doc/ui-studies/library-tactical-2026-10-26/switch-isolation.patch
```

然后检查并撤回区域区分试版：

```powershell
git apply --reverse --check dev-doc/ui-studies/library-tactical-2026-10-26/zones.patch
git apply --reverse dev-doc/ui-studies/library-tactical-2026-10-26/zones.patch
```

然后检查并撤回浅灰背景这一步：

```powershell
git apply --reverse --check dev-doc/ui-studies/library-tactical-2026-10-26/light-gray.patch
git apply --reverse dev-doc/ui-studies/library-tactical-2026-10-26/light-gray.patch
```

然后检查并撤回顺时针阶段的累计增量：

```powershell
git apply --reverse --check dev-doc/ui-studies/library-tactical-2026-10-26/integration-clockwise.patch
git apply --reverse dev-doc/ui-studies/library-tactical-2026-10-26/integration-clockwise.patch
```

每一步仅在对应 `--check` 通过后应用。仅撤回最新结构与配色时，到第一步即停止，保留串闪修复。需要重新接回本版时，按 `integration-clockwise.patch` → `light-gray.patch` → `zones.patch` → `switch-isolation.patch` → `structure-approved.patch` 顺序，去掉 `--reverse`，同样逐个先 `--check` 再应用。恢复的是源码，需要重新启动开发版本或构建安装包后才影响运行中的应用。

如果检查失败，说明相关文件已继续演进。此时依据 `before/` 和补丁逐处合并样式差异，不要整批覆盖当前文件；这样可保留后续功能。补丁不回退本文档、项目记录、素材、数据库或账号数据。

## 接入验收记录

同日最新结构与配色接入：用户确认后迁移示意样式，沿用项目管理面板的暖灰／石墨配色；「我的项目」采用低对比中性底色，顶部保留朴素图标与分组，标签管理常态无底块。侧栏装饰不拦截指针，分类数量由真实 `section.count` 提供，不迁移预览的 DOM observer、模拟 IPC 或对比菜单。Tactical、分栏、toolbar-layout Chromium 回归及 Vite 构建通过。当前完整 TypeScript 检查仍报创建编辑器／WorkflowPromptEditor 的既有 16 项 ProseMirror 相关错误，本次四份生产文件无报错。新增两份补丁与前后源码另行保存，未覆盖旧冻结资料；在隔离临时副本完整反向应用五步恢复链，再正向接回，全部 `--check` 与应用通过，文本与保存的源码逐份一致（比较时统一换行符），原备份哈希保持。未在工作区实际撤回，也未打包发布或修改真实用户数据。

同日区域区分试版：以本轮开始保存的 `LibraryTactical.before.css` 和 `App.before.tsx` 为起点生成 `zones.patch`，仅包含两份生产文件的本轮增量，不包含临时预览夹具。Tactical 与 toolbar-layout 两组现有回归通过；深浅主题截图确认三层表面区分、顶栏矩阵仅占空白轨道且不干扰字母条。新补丁反向 `--check` 通过，31 项原源码副本／冻结文件／旧补丁哈希保持一致；未实际应用补丁。当前恢复先撤回此试版，再按浅灰背景、顺时针阶段顺序撤回。

同日浅灰背景调整：仅增补 `light-gray.patch`，浅色 `--lt-base` 从 `#f5f4f0` 改为 `#e6e7e5`；原冻结稿、源码副本和前三份补丁保持不变。新补丁反向 `--check` 及 30 项原备份哈希核验通过，撤回色值后的内存文本与顺时针阶段 CSS 哈希一致。恢复顺序为先反向撤回此补丁，再撤回 `integration-clockwise.patch`。

同日顺时针迭代：项目入口强化及 hover／active 无旧阴影；控件透光量降低 20%，同时修复旧导入按钮 hover 实色覆盖。四个方点先在顶点出现，80ms 后沿边顺时针移动，总计 400ms 到下一角并保持，继承抵达后 160ms 短闪。Tactical、轻动效、900–1920px 顶栏布局回归及完整 TypeScript／Vite 通过；专项另覆盖 390px、动画中途沿边位置与 900ms 后终态、无焦点及动态效果偏好。原始备份和前两份补丁保持，当前累计撤回使用 `integration-clockwise.patch`。

同日动效修复：内嵌页面可见但没有键盘焦点时，旧 `document.hasFocus()` 条件将悬浮动效全部取消。现仅在文档隐藏或素材区离屏时暂停，窗口失焦仍清理拖拽状态；减少动态效果保持。增强专项在挂载前固定 `hasFocus=false`，旧代码稳定失败、修复后控件／装饰点短闪和 400ms 展开后停在四角均通过；主页／项目／文件浏览轻动效回归及生产构建通过。当前内置浏览器页也核对了展开过程与四角终态。原源码、确认稿、冻结预览和首次补丁的哈希均保持，新增累计恢复补丁通过反向检查。

2026-10-26：素材库 Tactical 专项、轻动效、分栏、顶栏布局、30 万素材分页 Chromium 回归通过；冻结确认稿与实际组件的深浅主题九组主要控件几何和表面样式一致，Vite 生产构建通过。覆盖中心展开 400ms 后短闪 160ms、四点跨越图片顶点、控件高亮、文件导航、图片／视频、减少动态效果和后台暂停。

全量 TypeScript 检查仍有创建编辑器相关的既有 16 项错误。旧 `library-pages-ui`、`library-media-filter-ui` 测试夹具仍依赖已淘汰的标签／素材 mock，未通过；当前对应交互由 Tactical、分栏和分页测试覆盖。没有修改真实用户数据，也未制作或发布安装包。

2026-10-26 存档复核：当前完整 TypeScript 与 Vite 已通过；Tactical、分栏、轻动效、顶栏及分页回归再次通过。41 项源码副本／冻结文件／补丁／当前接入文件哈希及累计补丁反向检查通过。上方 16 项类型错误为此前检查记录，不代表本次状态；旧夹具未在本轮重跑。

2026-10-26 后续存档复核：85 项原始／分阶段备份及补丁哈希通过；当前源码已另行接入连续瀑布流，structure-approved.patch 的 VirtualCatalog.tsx 旧上下文不再匹配，反向检查失败。需要恢复时按 before/after 与补丁逐处合并样式差异，保留新的布局算法，不强行套用补丁或覆盖整文件。当前完整 TypeScript、桌面构建与相关 Chromium 回归通过；轻动效测试改为悬浮实际选中标签并等待拖动动画终态，不改变已确认的产品样式。
