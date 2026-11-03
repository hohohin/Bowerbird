# 长按拖出反馈候选

2026-11-03 用户已确认透明投影版，正式组件与双端原生拖影源码已接入；安装包未更新，Mac 与真实跨应用体验待验。

保留 600ms 长按、4px 移动取消与素材库直接拖出；增加长按进度、240ms 渐显固定 6px 模糊、HUD 操作指引，以及鼠标右下方的清晰缩略图。按用户补充参考提取透明投影、空间层次、局部亮边与虚实景深，不照搬弧环、点阵或其他背景图案。投影轮廓绑定被抓起素材的实际位置与尺寸；鼠标旁缩略图保留原比例和颜色，以贴边方点、短线及一层淡后缘表现提起，无留白底板。HUD 提示无实体卡片，不加虚构数据。减少动态效果时取消动画。松手／Esc／失焦清理。

从桌面目录运行 `node scripts/fixtures/canvas-drag-hud/server.mjs`，打开 http://127.0.0.1:17943/scripts/fixtures/canvas-drag-hud/preview.html 。长按画布图片后保持按住，拖到右侧接收演示区域再松手；该区域不是实际外部应用。

`node scripts/canvas-drag-hud-preview-ui.test.mjs` 验证长按与移动区分、渐显时长、HUD、清晰拖影、投递演示、松手／Esc／失焦、素材库直接拖出和深浅主题。截图在 `.tmp/canvas-drag-hud-preview/`。

正式 Windows IDragSourceHelper 与 Mac NSDraggingItem 已接入受限尺寸缓存缩略图，无缓存则保留图标回退；DOM 浮层不能实现跨窗口跟随。原生交接需保证提示已绘制、取消信号仍有效，不能把浏览器示意计作 OS 验收。
