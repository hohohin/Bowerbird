/**
 * A/B 路线共用评测 fixture 集 + 真值标注。
 *
 * - input.originalPrompt 一律按编辑框 raw 形态书写（@assetId 的【维度】chip 不带正文；
 *   裸 @assetId = 纯参考引用），expand.ts 负责合成模板展开版。
 * - truth 是确定性评分依据：泄漏词取自维度原文（逐字检查），意图词可用 "/" 分隔多个可接受写法。
 * - assetId 用短 id，name 用贴近真实采集的 hash 文件名（对齐 SKILL.md「平台靠 @文件名绑定」的事实）。
 */

import type { PromptAgentInput } from "../prompt-agent.ts";

export type FixtureTruth = {
  /** 每张参考图应承担的职责（语义归属；泄漏判定与人工评分的参照）。 */
  ownership: Array<{ assetId: string; owns: string[] }>;
  /** 不得出现在正向描述中的维度原文片段（排除行除外；逐字检查）。 */
  forbiddenPositiveTerms: string[];
  /** 最终 prompt 应保留的意图关键词；"/" 分隔可接受的同义写法。 */
  requiredIntentTerms: string[];
  /** 必须原样出现的 @文件名 token（绑定完整性）。 */
  requiredReferenceNames: string[];
};

export type AssemblyFixture = {
  id: string;
  description: string;
  input: PromptAgentInput;
  truth: FixtureTruth;
};

const NAME_A = "5b354d6db6ed443b996d21553e60da9c~tplv-aigc.webp";
const NAME_B = "7a6a2fa339444b4aabfb9450cf1f37ae~tplv-aigc.webp";
const NAME_C = "2fef4516c2cd4c46aafc1e67e7e55100~tplv-aigc.webp";

const SUBJ_A_RAW =
  "A young, androgynous person of ambiguous ethnicity with vibrant, multi-colored hair styled in a modern undercut, wearing futuristic goggles with dark lenses, a red leather biker jacket with black pants, and an aged shirt";
const CLOTH_B_RAW =
  "黑色机车皮夹克搭深灰连帽卫衣，下身是米色工装长裤与厚底短靴，佩戴银色工业风项链";
const SCENE_C_RAW = "黄昏时分的城市天台，远处是暖橙色天际线与楼宇剪影，地面有雨水反光";

export const FIXTURES: AssemblyFixture[] = [
  {
    id: "abc-clothing-swap",
    description: "正典 case：A 主体维度携带服装描述，与 B 的服装职责冲突（用户首倡场景）",
    input: {
      originalPrompt:
        "参考@subj-a 的【主体】，让他穿上@cloth-b 的【服装】，放在@scene-c 的【场景】里，生成一张全身照",
      references: [
        { assetId: "subj-a", name: NAME_A, dimensions: [{ key: "主体", label: "主体", raw: SUBJ_A_RAW }] },
        { assetId: "cloth-b", name: NAME_B, dimensions: [{ key: "服装", label: "服装", raw: CLOTH_B_RAW }] },
        { assetId: "scene-c", name: NAME_C, dimensions: [{ key: "场景", label: "场景", raw: SCENE_C_RAW }] },
      ],
      output: { kind: "图片", ratio: "3:4" },
    },
    truth: {
      ownership: [
        { assetId: "subj-a", owns: ["人物身份与长相（服装除外）"] },
        { assetId: "cloth-b", owns: ["服装"] },
        { assetId: "scene-c", owns: ["场景"] },
      ],
      forbiddenPositiveTerms: ["red leather biker jacket", "black pants", "aged shirt"],
      requiredIntentTerms: ["全身"],
      requiredReferenceNames: [NAME_A, NAME_B, NAME_C],
    },
  },
  {
    id: "abc-clothing-swap-unanalyzed-b",
    description: "同正典场景，但 B 未反推（裸 @引用）→ 职责声明通道，图靠 reference_images 传给生图模型",
    input: {
      originalPrompt:
        "参考@subj-a 的【主体】，让他穿上@cloth-b 的衣服，放在@scene-c 的【场景】里，生成一张全身照",
      references: [
        { assetId: "subj-a", name: NAME_A, dimensions: [{ key: "主体", label: "主体", raw: SUBJ_A_RAW }] },
        { assetId: "cloth-b", name: NAME_B, dimensions: [] },
        { assetId: "scene-c", name: NAME_C, dimensions: [{ key: "场景", label: "场景", raw: SCENE_C_RAW }] },
      ],
      output: { kind: "图片", ratio: "3:4" },
    },
    truth: {
      ownership: [
        { assetId: "subj-a", owns: ["人物身份与长相（服装除外）"] },
        { assetId: "cloth-b", owns: ["服装（无反推数据，职责声明 + 附图）"] },
        { assetId: "scene-c", owns: ["场景"] },
      ],
      forbiddenPositiveTerms: ["red leather biker jacket", "black pants", "aged shirt"],
      requiredIntentTerms: ["全身"],
      requiredReferenceNames: [NAME_A, NAME_B, NAME_C],
    },
  },
  {
    id: "goggles-not-jacket",
    description: "同维度内部分歧：要 A 主体的护目镜与发型，不要皮夹克",
    input: {
      originalPrompt:
        "参考@subj-a 的【主体】（保留他的护目镜和发型，但不要皮夹克），让他穿上@cloth-b 的【服装】，生成一张半身像",
      references: [
        { assetId: "subj-a", name: NAME_A, dimensions: [{ key: "主体", label: "主体", raw: SUBJ_A_RAW }] },
        { assetId: "cloth-b", name: NAME_B, dimensions: [{ key: "服装", label: "服装", raw: CLOTH_B_RAW }] },
      ],
      output: { kind: "图片" },
    },
    truth: {
      ownership: [
        { assetId: "subj-a", owns: ["人物长相、发型、护目镜（不要皮夹克）"] },
        { assetId: "cloth-b", owns: ["服装"] },
      ],
      forbiddenPositiveTerms: ["red leather biker jacket", "black pants", "aged shirt"],
      requiredIntentTerms: ["护目镜/goggles", "半身"],
      requiredReferenceNames: [NAME_A, NAME_B],
    },
  },
  {
    id: "zero-references",
    description: "零参考图纯文生",
    input: {
      originalPrompt: "生成一张赛博朋克风格的城市街道夜景海报，霓虹雨夜，不要画面文字",
      references: [],
      output: { kind: "海报", ratio: "16:9" },
    },
    truth: {
      ownership: [],
      forbiddenPositiveTerms: [],
      requiredIntentTerms: ["赛博朋克", "夜景"],
      requiredReferenceNames: [],
    },
  },
  {
    id: "max-references",
    description: "满 8 参考图：多职责组合；构图维度的内容物（茶壶）不得随构图迁移",
    input: {
      originalPrompt:
        "把@r1 的【主体】、@r2 的【构图】、@r3 的【光线】、@r4 的【色调】、@r5 的【材质】、@r6 的【氛围】、@r7 的【类型】组合成一张电影海报，@r8 整体作为排版参考",
      references: [
        { assetId: "r1", name: "11a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6~tplv-aigc.webp", dimensions: [{ key: "主体", label: "主体", raw: "一位独自远行的宇航员，磨损的白色宇航服，面罩上映着星云" }] },
        { assetId: "r2", name: "22b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7~tplv-aigc.webp", dimensions: [{ key: "构图", label: "构图", raw: "茶壶位于画面正中，四周环绕器物，顶部大面积留白" }] },
        { assetId: "r3", name: "33c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8~tplv-aigc.webp", dimensions: [{ key: "光线", label: "光线", raw: "窗边少女的侧逆光，尘埃在光柱中漂浮" }] },
        { assetId: "r4", name: "44d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9~tplv-aigc.webp", dimensions: [{ key: "色调", label: "色调", raw: "低饱和的青橙对比，暗部偏墨绿" }] },
        { assetId: "r5", name: "55e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0~tplv-aigc.webp", dimensions: [{ key: "材质", label: "材质", raw: "哑光磨砂质感，细微划痕与做旧颗粒" }] },
        { assetId: "r6", name: "66f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1~tplv-aigc.webp", dimensions: [{ key: "氛围", label: "氛围", raw: "孤寂、静谧而宏大，带有末世诗意" }] },
        { assetId: "r7", name: "77a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2~tplv-aigc.webp", dimensions: [{ key: "类型", label: "类型", raw: "电影剧照质感，宽画幅叙事" }] },
        { assetId: "r8", name: "88b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3~tplv-aigc.webp", dimensions: [] },
      ],
      output: { kind: "海报", ratio: "2.39:1" },
    },
    truth: {
      ownership: [
        { assetId: "r1", owns: ["主体"] },
        { assetId: "r2", owns: ["构图（布局结构，不含茶壶）"] },
        { assetId: "r3", owns: ["光线（不含窗边少女）"] },
        { assetId: "r4", owns: ["色调"] },
        { assetId: "r5", owns: ["材质"] },
        { assetId: "r6", owns: ["氛围"] },
        { assetId: "r7", owns: ["类型"] },
        { assetId: "r8", owns: ["排版整体参考（无维度）"] },
      ],
      forbiddenPositiveTerms: ["茶壶", "少女"],
      requiredIntentTerms: ["电影海报"],
      requiredReferenceNames: [
        "11a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6~tplv-aigc.webp",
        "22b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7~tplv-aigc.webp",
        "33c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8~tplv-aigc.webp",
        "44d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9~tplv-aigc.webp",
        "55e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0~tplv-aigc.webp",
        "66f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1~tplv-aigc.webp",
        "77a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2~tplv-aigc.webp",
        "88b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3~tplv-aigc.webp",
      ],
    },
  },
  {
    id: "cn-en-mixed",
    description: "全英文维度正文 × 中文意图：测切分器英文鲁棒性与中英拼接",
    input: {
      originalPrompt:
        "参考@en-a 的【subject】，用@en-b 的【lighting】，配上@en-c 的【color palette】，生成一张特写肖像",
      references: [
        { assetId: "en-a", name: "99c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4~tplv-aigc.webp", dimensions: [{ key: "subject", label: "subject", raw: "An elderly fisherman with deep wrinkles and a salt-and-pepper beard, wearing a yellow raincoat, holding a wooden pipe" }] },
        { assetId: "en-b", name: "a0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5~tplv-aigc.webp", dimensions: [{ key: "lighting", label: "lighting", raw: "soft diffused window light from the left, long shadows across the face, warm late afternoon tones" }] },
        { assetId: "en-c", name: "b1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6~tplv-aigc.webp", dimensions: [{ key: "color palette", label: "color palette", raw: "muted teal and amber palette, desaturated background, faded neon sign in the distance" }] },
      ],
      output: { kind: "肖像" },
    },
    truth: {
      ownership: [
        { assetId: "en-a", owns: ["subject（含雨衣与烟斗：用户未排除）"] },
        { assetId: "en-b", owns: ["lighting"] },
        { assetId: "en-c", owns: ["color palette（不含远景霓虹招牌物件）"] },
      ],
      forbiddenPositiveTerms: ["neon sign"],
      requiredIntentTerms: ["特写"],
      requiredReferenceNames: [
        "99c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4~tplv-aigc.webp",
        "a0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5~tplv-aigc.webp",
        "b1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6~tplv-aigc.webp",
      ],
    },
  },
  {
    id: "fluency-style-merge",
    description: "流畅性压力 case（B 主场）：主体 × 水彩风格 × 场景需融合措辞，不能像拼贴",
    input: {
      originalPrompt:
        "参考@model-a 的【主体】，画成@style-b 的【风格】，背景是@scene-c 的【场景】，像一张完整的水彩插画而不是拼贴",
      references: [
        { assetId: "model-a", name: "c2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7~tplv-aigc.webp", dimensions: [{ key: "主体", label: "主体", raw: "一只蜷坐在窗台上的橘猫，尾巴垂落，毛色带虎斑纹" }] },
        { assetId: "style-b", name: "d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8~tplv-aigc.webp", dimensions: [{ key: "风格", label: "风格", raw: "loose wet-on-wet watercolor washes with visible paper texture, soft bleeding edges, hand-drawn ink outlines, warm ochre and indigo palette" }] },
        { assetId: "scene-c", name: "e4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9~tplv-aigc.webp", dimensions: [{ key: "场景", label: "场景", raw: "江南水乡的雨后小巷，青石板路与白墙黛瓦，远处有撑伞的游客" }] },
      ],
      output: { kind: "插画" },
    },
    truth: {
      ownership: [
        { assetId: "model-a", owns: ["主体（橘猫）"] },
        { assetId: "style-b", owns: ["风格"] },
        { assetId: "scene-c", owns: ["场景（不含撑伞游客）"] },
      ],
      forbiddenPositiveTerms: ["游客"],
      requiredIntentTerms: ["水彩"],
      requiredReferenceNames: [
        "c2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7~tplv-aigc.webp",
        "d3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8~tplv-aigc.webp",
        "e4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9~tplv-aigc.webp",
      ],
    },
  },
  {
    id: "product-anchor",
    description: "商品锚定 case（对齐 SKILL.md 真实场景）：动作参考的发型泄漏是高频翻车点",
    input: {
      originalPrompt:
        "生成一张模特戴耳环的商品图：模特来自@model-a 的【主体】，耳环用@jewel-b 的【商品】，姿势参考@pose-c 的【动作】，耳环要清晰可见不被遮挡",
      references: [
        { assetId: "model-a", name: "f5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0~tplv-aigc.webp", dimensions: [{ key: "主体", label: "主体", raw: "A young woman with a calm expression, dark hair pulled back, wearing a simple black top" }] },
        { assetId: "jewel-b", name: "06d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1~tplv-aigc.webp", dimensions: [{ key: "商品", label: "商品", raw: "垂坠式金属耳环，细链与不规则银片，冷光泽" }] },
        { assetId: "pose-c", name: "17e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2~tplv-aigc.webp", dimensions: [{ key: "动作", label: "动作", raw: "侧身站立，上半身微微后仰，头部转向镜头，蓬松长卷发垂落肩侧" }] },
      ],
      output: { kind: "商品图", ratio: "3:4" },
    },
    truth: {
      ownership: [
        { assetId: "model-a", owns: ["模特主体（含黑上衣）"] },
        { assetId: "jewel-b", owns: ["耳环商品"] },
        { assetId: "pose-c", owns: ["动作姿势（不含其发型）"] },
      ],
      forbiddenPositiveTerms: ["长卷发"],
      requiredIntentTerms: ["耳环", "清晰可见"],
      requiredReferenceNames: [
        "f5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0~tplv-aigc.webp",
        "06d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1~tplv-aigc.webp",
        "17e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2~tplv-aigc.webp",
      ],
    },
  },
];
