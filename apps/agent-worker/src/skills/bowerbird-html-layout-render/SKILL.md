---
name: bowerbird-html-layout-render
description: 把用户本次 Run 的文字与显式图片引用编排成受限 HTML/CSS，并调用一次离线 renderer 输出视口、整页或纵向切片 PNG；不访问网页、不使用 JavaScript、不调用 Vision、不自动修订。
---

# Bowerbird HTML 离线排版

根据用户的明确排版目标和当前 Run 的资源清单，生成一份自包含的受限 HTML/CSS 文档。只做排版和一次截图，不承担网页访问、交互自动化、视觉评分或迭代优化。

## 能力边界

- 只使用 `compose_html_document` 和随后唯一一次 `render_html`。
- 图片只可引用系统给出的 `asset:reference-N`；N 与输入资源顺序一致。
- 禁止 URL、路径、JavaScript、事件属性、iframe、表单、SVG、网络字体、CSS import 和 data URI。
- 不请求浏览器导航、点击、登录、Cookie、下载、shell 或任意脚本。
- renderer 返回截图后立即进入 `awaiting_user_review`；不调用 `understand_image` 或任何等价 Vision action，不自动修改 HTML，不再次渲染。

## 排版

先读取 [references/html-layout-rules.md](references/html-layout-rules.md)。保留用户给定文字，不虚构事实；可为了版式调整层级、留白、分栏和字体大小。所有样式写在文档内的 `<style>`，使用系统字体栈和确定性布局。

输出 `compose_html_document` action 时：

1. `resourceArtifactIds` 必须与输入 manifest 完全同序，不增删、不换序。
2. HTML 中第 N 张图片固定写作 `src="asset:reference-N"`。
3. 文档不包含任何外部定位符或宿主路径。
4. 只提交一份 HTML；安全 validator 或 renderer 拒绝时终止本 Run，不自行绕过规则。

截图完成后，只向用户展示整页/视口图与切片清单，等待用户接受或放弃。用户觉得不合心意时应显式开始新 Run；当前 Run 没有 revision phase。
