/**
 * 反推（理解引擎描述图片）指令的存取。详情页「反推」与瀑布流右键「反推提示词」共用：
 * 默认指令是带维度的结构化模板（产出 `- **维度名**` 段落，后端 caption::parse 据此切 sections，
 * 创作板维度 chips 即来自这些标题）。用户在详情页自定义后写 localStorage，两处都读同一份。
 */
const DEFAULT_DESCRIBE_PROMPT = `请分析这张图片，并严格按下面的 Markdown 格式输出。

要求：
1. 每个维度必须独立成段。
2. 每个段落标题必须使用一行 \`- **维度名**\`，不要使用其它标题格式。
3. 段落正文写在标题下一行，可以多行。
4. 不要把多个维度合并到同一段。
5. 如果某个维度不适用，也要输出该维度，并写"无明显特征"。
6. 最后输出"反推提示词"和"负面提示词"，也必须作为独立维度段落。
7. 不要在段落正文里再使用 \`**标题**\`。

请使用以下维度名，顺序不要变：

- **类型**
- **ratio**
- **构图**
- **光影**
- **色调**
- **主体动作**
- **材质 / 笔触**
- **背景**
- **氛围 / 情绪**
- **反推提示词**
- **负面提示词**

输出格式示例：

- **类型**
绘画 / AI 插画 / 数字绘画。说明它不是摄影或 3D。

- **构图**
说明画幅比例、主体位置、视线方向、留白、动势、镜头距离。

- **光影**
说明主光方向、逆光/侧光/顶光、高光、阴影、曝光、发光边缘。

- **色调**
说明主色、辅色、饱和度、冷暖、整体色彩情绪。

- **主体动作**
说明主体姿态、动作方向、速度感、身体动态。

- **材质 / 笔触**
说明绘画媒介感、颗粒、笔触、模糊、纹理。

- **背景**
说明背景内容、空间层次、虚实关系、装饰元素。

- **氛围 / 情绪**
说明整体情绪、联想、叙事感、心理感受。

- **反推提示词**
写一段可直接用于 AI 图像生成的正向提示词，尽量包含前面各维度的关键词。

- **负面提示词**
写一段需要避免的元素。`;
// 旧默认值；localStorage 里若还是它，视作「未自定义」→ 升级到新模板。
const LEGACY_DEFAULT_PROMPT = "请描述这张图片";
const DESCRIBE_PROMPT_KEY = "bowerbird.describePrompt";
const DESCRIBE_PROMPT_HISTORY_KEY = "bowerbird.describePromptHistory";
export const MAX_DESCRIBE_PROMPT_HISTORY = 8;

export function loadDescribePrompt() {
  try {
    const stored = localStorage.getItem(DESCRIBE_PROMPT_KEY);
    if (!stored || stored === LEGACY_DEFAULT_PROMPT) {
      return DEFAULT_DESCRIBE_PROMPT;
    }
    return stored;
  } catch {
    return DEFAULT_DESCRIBE_PROMPT;
  }
}

export function loadDescribePromptHistory() {
  try {
    const v = JSON.parse(
      localStorage.getItem(DESCRIBE_PROMPT_HISTORY_KEY) || "[]"
    );
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveDescribePrompt(prompt: string) {
  try {
    localStorage.setItem(DESCRIBE_PROMPT_KEY, prompt);
  } catch {
    // ignore storage errors
  }
}

export function saveDescribePromptHistory(history: string[]) {
  try {
    localStorage.setItem(DESCRIBE_PROMPT_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // ignore storage errors
  }
}

export { DEFAULT_DESCRIBE_PROMPT };
