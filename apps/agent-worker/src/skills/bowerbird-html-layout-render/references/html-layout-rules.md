# HTML 排版规则

- 使用语义化的 `main`、`section`、`header`、`figure`、`img`、`table` 等受支持标签。
- CSS 只写确定性静态布局；优先 flex/grid、固定间距和明确尺寸，不使用动画、transition、滤镜或远程字体。
- 中文正文使用系统无衬线字体栈；标题、正文、注释保持清楚层级和足够对比度。
- 长页按自然文档流向下延伸；不要用脚本测量或滚动。fixed/sticky 仅在用户明确需要时使用。
- 图片必须保持比例，通常使用 `object-fit: contain`；不得把 `asset:reference-N` 改写成 URL、data URI 或路径。
- 透明背景只有在输入明确选择时使用；不要以视觉检查结果决定背景或重新排版。
