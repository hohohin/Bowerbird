# 工业制图主题 · 2026-10-29

用户先要求记录当时已实装的版本，再确认接入最新工业制图示意。本目录同时保存旧版恢复材料和本次接入证据；产品约定以 `PROJECT.md` 为准。

## 旧版备份

- `before/`：改动前工作区的 45 份 CSS 与入口文件，包含当时未提交的实际内容，不等同于仅保存 Git HEAD。
- `before-manifest.json`：基线提交 `d17452793232d4c635fbe8b43c1804a7ceb40f30` 与各文件 SHA-256，已逐项验证。
- `before-preview/`：旧版正式组件的冻结网页，已包含编译脚本、样式和演示资源，不随后续源码修改而变化。通过任意本地静态服务打开其中的 `index.html?theme=dark` 或 `?theme=light`。
- `before-dark.png`、`before-geometry.json`：旧版截图与卡片、端口、创作框的位置和尺寸记录。
- `approved-*`：本轮确认的独立示意源文件与深浅主题截图。

现有预览服务运行时，可直接查看[旧版冻结网页](http://127.0.0.1:17864/@fs/D:/H/Project/Bowerbird/dev-doc/ui-studies/industrial-hud-2026-10-29/before-preview/index.html?theme=dark)。该网页已检查：三个正式卡片正常显示，未加载 Industrial 主题变量，画布仍为旧色 `rgb(25,31,33)`。

## 实装范围

新增 `apps/desktop/src/components/IndustrialTheme.css`、`IndustrialCanvas.css`、`IndustrialMenus.css`，在 `App.tsx` 与正式组件验证入口 `scripts/fixtures/canvas-reference/preview.tsx` 的既有样式后加载；初次实装时的文件校验值见 `installed-manifest.json`。

- 深色石墨底、银灰细线；浅色中性灰底、纸白不透明阅读面。画布为 80px 间距的小叉，不增加坐标条或大幅轴测装饰。
- 卡片、菜单与创作框共用细线、局部方点阵和一层错位轮廓；布局、尺寸、端口与点击逻辑保持原状。
- 工程蓝用于当前工具、创作模式、已选项、当前模型方点、输入焦点；普通悬浮与键盘游标为中性空心方点。文本选择保持高对比，错误输入焦点保留错误色。
- 公共对话框、设置及素材库／项目面板接入中性色；provider、成功／警告／错误的语义色保留。独立截图窗口不经过主 App，沿用此前主题。
- 未改生成、存储和计费逻辑，未打包、发布或操作真实用户素材。

## 恢复旧版

在仓库根目录执行以下命令。补丁只撤回两个入口中的三条 Industrial CSS 导入，旧 CSS 未被覆盖；新增 CSS 文件保留，方便再启用。

```powershell
git apply --check dev-doc/ui-studies/industrial-hud-2026-10-29/restore-previous-ui.patch
git apply dev-doc/ui-studies/industrial-hud-2026-10-29/restore-previous-ui.patch
```

重新启用本版：

```powershell
git apply --reverse --check dev-doc/ui-studies/industrial-hud-2026-10-29/restore-previous-ui.patch
git apply --reverse dev-doc/ui-studies/industrial-hud-2026-10-29/restore-previous-ui.patch
```

补丁的正向检查已通过，未实际撤回本次实装。后续若入口发生变化，应先检查补丁并人工合并相应导入，不要整份覆盖 App；若旧 CSS 后续被修改，可以比对 `before/`，冻结网页仍可作为当时视觉参考。

## 验证

- 完整 TypeScript 检查通过；TacticalSelect 六项逻辑测试通过；Vite 生产构建通过。
- 实际正式组件合成网页：13 项卡片／媒体／端口／创作框的坐标与尺寸前后完全相同，7 个工作流端口中心可命中。
- 深浅主题均检查不透明卡片和 80px 小叉、下拉菜单选择与键盘游标、创作模式、设置。展开／关闭素材库时，顶栏的尺寸和颜色完全相同。
- 旧版快照 45 份 SHA-256 全部通过，冻结网页可独立打开，恢复补丁通过 `git apply --check`。
- `after-dark.png`、`after-light.png`、`settings-light.png` 为正式组件效果。合成验证不执行真实模型调用或资料写入；未验证独立原生截图窗口及安装包运行。

[正式组件预览](http://127.0.0.1:17864/.tmp/canvas-structure-preview/index.html?theme=dark) · [独立确认稿](http://127.0.0.1:17864/.tmp/industrial-hud-study/index.html?theme=dark)

## 同日 HUD 悬浮修订

用户随后确认卡片悬浮层次、方点／右上裁角，以及贴顶居中的关闭按钮。该修订已合并至 `IndustrialCanvas.css`；旧版快照、冻结网页与恢复补丁保持，`installed-manifest.json` 仍记录初次实装哈希。当前规则与验证边界见 `PROJECT.md`「画布卡片 HUD 悬浮层次」，实装效果见 [HUD 预览](http://127.0.0.1:17864/.tmp/canvas-hud-depth/index.html?theme=dark)。
