# 品牌视觉提示词维护

两阶段指令均由 VPS Worker 加载，桌面只发送任务标识 `bowerbird:brand-visual-observation:v2`。

- `observation.md`：看图，区分原图明确标注的品牌标准与观察所得风格，完整转录色号。
- `extraction.md`：跨图归纳普通风格。明确标注由程序从「品牌规范」节原样保留，不受多数支持率影响。

生产维护目录为 `/opt/bowerbird/agent-worker/src/prompts/brand-visual/`，以只读目录挂载到容器 `/app/brand-prompts/`，由 `BOWERBIRD_BRAND_PROMPT_DIR` 指定。未设置时读取代码旁同名目录；设置后缺失、空文件或超过 20000 字符均报错，不偷偷回退到旧提示词。

更新前备份原文件，在同一目录写入 UTF-8 临时文件后原子重命名为对应 `.md`；保持 Worker 用户可读。下一项任务读取新文件，无需重发桌面包或重建镜像。单项任务开始时读取一次，重试和分批过程沿用同一份内容。两文件涉及格式联动时，在队列空闲的维护窗口一并更新，并将修改同步回仓库。

`observation.md` 的「品牌规范」节是解析契约：每行 `类别 | 标注名称与用途 | 原文数值或要求`，没有标准写「无明确标注」。不可删除该节或改分隔格式；色号编码不换算，长规范拆条，不能截断。HEX、RGB、CMYK、Pantone 分行时名称附上编码类型。观察有同名异值时保留各条并要求用户核对；无标注色块只描述风格，不假装取色。

标准格式错误、单条超过 200 字或品牌规范节超过接口 4000 字上限时应明确失败，不以截断内容继续。图片识别仍可能误读，保存前可在规范详情中核对及微调。

本次 v2 会在用户下一次点击提炼时补做缺少 v2 标识的旧观察，以避免复用已遗漏色号的旧反推；既有规范和生成快照不重写。以后只改措辞无需更新任务标识；若改输出契约或必须重新读取旧素材，需配套升级协议与兼容处理。

维护后在 Worker 包目录执行 `node --test src/prompts/brand-visual.test.ts src/cloud-visual/declared-standards.test.ts src/cloud-understand/runtime.test.ts src/cloud-visual/runtime.test.ts`。测试使用合成数据与假模型，不消费真实图片理解或生成额度。
