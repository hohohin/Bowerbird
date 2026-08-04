import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import p1Url from "./assets/presets/p1.jpg";
import p2Url from "./assets/presets/p2.jpg";
import p3Url from "./assets/presets/p3.jpg";
import p4Url from "./assets/presets/p4.jpg";
import p5Url from "./assets/presets/p5.jpg";
import p6Url from "./assets/presets/p6.jpg";
import p7Url from "./assets/presets/p7.jpg";
import p8Url from "./assets/presets/p8.jpg";

const ASSETS = [
  {
    id: "p1",
    name: "花影黑白猫",
    src: p1Url,
    dimensions: {
      构图: "黑白猫正面半身居中，花叶从四周形成自然画框",
      光影: "柔和棚拍光均匀照亮面部，眼睛保留清晰高光",
      色调: "奶油米白、鼠尾草绿与暗粉花朵构成复古低饱和配色",
      材质: "细腻猫毛、做旧纸面与柔焦花瓣的触感对比",
      氛围: "端庄、安静，像一幅维多利亚时代的植物肖像",
    },
  },
  {
    id: "p2",
    name: "桃粉线描猫",
    src: p2Url,
    dimensions: {
      构图: "猫的背影与尾巴占据画面中心，线条向外散开形成流动轮廓",
      光影: "近乎纯黑背景上的桃粉色自发光线条，高反差边缘光",
      色调: "黑色底面与荧光桃粉形成极简双色关系",
      主体动作: "猫背对镜头坐立，尾巴自然垂下并略微弯曲",
      氛围: "神秘、俏皮，带数字霓虹与手绘涂鸦感",
    },
  },
  {
    id: "p3",
    name: "午后茶歇",
    src: p3Url,
    dimensions: {
      构图: "人物侧坐于桌前，茶具与甜点形成前景静物层次",
      光影: "均匀的平面化柔光，仅用少量色块区分明暗",
      色调: "珊瑚粉、奶油白与淡蓝构成高明度编辑配色",
      背景: "简化室内背景与留白，让人物和餐桌成为视觉中心",
      氛围: "轻松、优雅，带当代杂志插画的午后生活感",
    },
  },
  {
    id: "p4",
    name: "红调咖啡馆",
    src: p4Url,
    dimensions: {
      构图: "略高机位的人物环境肖像，桌面、绿植与空间形成多层叙事",
      光影: "室内窗光与暖色环境光混合，阴影自然柔和",
      色调: "砖红、酒红与植物绿形成浓郁互补",
      材质: "木桌、织物、陶器与茂密叶片呈现真实生活质感",
      氛围: "松弛、文艺，像独立咖啡馆里的纪录片瞬间",
    },
  },
  {
    id: "p5",
    name: "户外茶饮",
    src: p5Url,
    dimensions: {
      构图: "男性近景侧面饮用瓶装茶，产品与面部共同占据视觉中心",
      光影: "明亮自然日光塑造面部轮廓，背景虚化并带阳光散景",
      色调: "蜂蜜金、草木绿与肤色构成温暖商业色调",
      材质: "透明塑料瓶、胡须与户外草木形成清晰真实质感",
      氛围: "清爽、自然，具有夏日户外饮品广告的可信感",
    },
  },
  {
    id: "p6",
    name: "夏日旋转",
    src: p6Url,
    dimensions: {
      构图: "人物全身位于草地中央，旋转动作带出裙摆和身体的动态弧线",
      光影: "柔和阴天自然光，人物与草地保持轻盈低反差",
      色调: "鼠尾草绿、雾蓝与暖灰构成清新的自然色系",
      主体动作: "人物在草地上快速旋转，头发和衣摆形成明显运动模糊",
      氛围: "自由、轻快，像夏日记忆中一帧失焦的胶片",
    },
  },
  {
    id: "p7",
    name: "玻璃兰花",
    src: p7Url,
    dimensions: {
      类型: "透明玻璃雕塑感的三维植物艺术",
      构图: "兰花枝条斜向贯穿画面，花朵沿曲线疏密排列",
      色调: "玫瑰粉、紫红与透明高光构成单色渐变",
      材质: "强调透明玻璃、折射边缘与内部气泡般的晶莹质感",
      氛围: "精致、梦幻，兼具奢侈品视觉与数字艺术感",
    },
  },
  {
    id: "p8",
    name: "粉色柚光",
    src: p8Url,
    dimensions: {
      构图: "多格情绪板拼贴，水果切面、玻璃液体与色卡形成节奏",
      光影: "高亮透射光穿过果肉和玻璃，产生清透折射与柔和阴影",
      色调: "葡萄柚粉、珊瑚橙与冷白构成通透渐变",
      材质: "湿润果肉、磨砂玻璃、气泡与高光液体的感官组合",
      氛围: "酸甜、清爽，带香氛与美妆品牌的视觉实验感",
    },
  },
];

const assetById = new Map(ASSETS.map((asset) => [asset.id, asset]));
const assetByName = new Map(ASSETS.map((asset) => [asset.name, asset]));

const creationSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
    image: {
      inline: true,
      atom: true,
      group: "inline",
      attrs: { assetId: {}, name: {}, src: {} },
      parseDOM: [
        {
          tag: "span[data-asset-id]",
          getAttrs: (dom) => ({
            assetId: dom.getAttribute("data-asset-id"),
            name: dom.getAttribute("data-name"),
            src: dom.getAttribute("data-src"),
          }),
        },
      ],
      toDOM(node) {
        return [
          "span",
          {
            class: "pm-image",
            "data-asset-id": node.attrs.assetId,
            "data-name": node.attrs.name,
            "data-src": node.attrs.src,
            title: `参考图：${node.attrs.name}`,
          },
          ["img", { src: node.attrs.src, alt: "" }],
          ["span", {}, node.attrs.name],
        ];
      },
    },
    keyword: {
      inline: true,
      atom: true,
      group: "inline",
      attrs: { title: {}, assetId: {} },
      parseDOM: [
        {
          tag: "span[data-dimension]",
          getAttrs: (dom) => ({
            title: dom.getAttribute("data-dimension"),
            assetId: dom.getAttribute("data-asset-id"),
          }),
        },
      ],
      toDOM(node) {
        return [
          "span",
          {
            class: "pm-keyword",
            "data-dimension": node.attrs.title,
            "data-asset-id": node.attrs.assetId,
            title: `维度：${node.attrs.title}`,
          },
          node.attrs.title,
        ];
      },
    },
  },
});

const imageNode = (asset) =>
  creationSchema.nodes.image.create({ assetId: asset.id, name: asset.name, src: asset.src });

const keywordNode = (assetId, title) =>
  creationSchema.nodes.keyword.create({ assetId, title });

function makeInitialDoc() {
  const p1 = assetById.get("p1");
  const p5 = assetById.get("p5");
  return creationSchema.nodes.doc.create(null, [
    creationSchema.nodes.paragraph.create(null, [
      creationSchema.text("融合 "),
      imageNode(p1),
      creationSchema.text(" 的 "),
      keywordNode("p1", "光影"),
      creationSchema.text(" 和 "),
      keywordNode("p1", "色调"),
      creationSchema.text(" 与 "),
      imageNode(p5),
      creationSchema.text(" 的 "),
      keywordNode("p5", "构图"),
      creationSchema.text("，创作一张夏日户外茶饮广告"),
    ]),
  ]);
}

let activeAssetId = "p1";
let view;
let graphOutputImage = "";
let graphOutputState = "idle";
let graphFrameId = 0;

function textBeforeCursor(state) {
  const selection = state.selection;
  if (!selection.empty || !selection.$head.parent.isTextblock) return null;
  return {
    text: selection.$head.parent.textBetween(0, selection.$head.parentOffset, "\n", "\n"),
    start: selection.$head.start(),
    end: selection.$head.pos,
  };
}

function smartPunctuation(punctuation) {
  return (state, dispatch, editorView) => {
    if (editorView?.composing) return false;
    const before = textBeforeCursor(state);
    if (!before) return false;

    const atIndex = before.text.lastIndexOf("@");
    if (atIndex >= 0) {
      const name = before.text.slice(atIndex + 1);
      const asset = name && !/\s/.test(name) ? assetByName.get(name) : null;
      if (asset) {
        if (dispatch) {
          const tr = state.tr.replaceWith(before.start + atIndex, before.end, imageNode(asset));
          if (punctuation !== "Enter") tr.insertText(punctuation);
          dispatch(tr.scrollIntoView());
          setActiveAsset(asset.id, `已识别 @${asset.name}`);
        }
        return true;
      }
    }

    const active = assetById.get(activeAssetId);
    const title = active
      ? Object.keys(active.dimensions).sort((a, b) => b.length - a.length).find((key) => before.text.endsWith(key))
      : null;
    if (title) {
      if (dispatch) {
        const tr = state.tr.replaceWith(before.end - title.length, before.end, keywordNode(active.id, title));
        if (punctuation !== "Enter") tr.insertText(punctuation);
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    return false;
  };
}

const punctuationKeys = {
  Space: smartPunctuation(" "),
  Enter: smartPunctuation("Enter"),
  ",": smartPunctuation(","),
  ".": smartPunctuation("."),
  "，": smartPunctuation("，"),
  "。": smartPunctuation("。"),
};

function serializeDoc(doc) {
  const paragraphs = [];
  const references = new Set();

  doc.forEach((paragraph) => {
    let output = "";
    paragraph.forEach((node) => {
      if (node.isText) {
        output += node.text;
        return;
      }
      if (node.type.name === "image") {
        references.add(node.attrs.assetId);
        output += `@${node.attrs.name}`;
        return;
      }
      if (node.type.name === "keyword") {
        const asset = assetById.get(node.attrs.assetId);
        const body = asset?.dimensions[node.attrs.title];
        output += body ? `【${node.attrs.title}】：${body}` : `【${node.attrs.title}】`;
      }
    });
    paragraphs.push(output);
  });

  return { prompt: paragraphs.join("\n"), references: [...references] };
}

function usedDimensions(assetId) {
  const used = new Set();
  view.state.doc.descendants((node) => {
    if (node.type.name === "keyword" && node.attrs.assetId === assetId) used.add(node.attrs.title);
  });
  return used;
}

function graphSourcesFromDoc(doc) {
  const sources = new Map();
  const ensureSource = (assetId) => {
    const asset = assetById.get(assetId);
    if (!asset) return null;
    if (!sources.has(assetId)) sources.set(assetId, { asset, dimensions: new Set() });
    return sources.get(assetId);
  };

  doc.descendants((node) => {
    if (node.type.name === "image") ensureSource(node.attrs.assetId);
    if (node.type.name === "keyword") ensureSource(node.attrs.assetId)?.dimensions.add(node.attrs.title);
  });

  return [...sources.values()].map((source) => ({
    asset: source.asset,
    dimensions: [...source.dimensions],
  }));
}

function drawGraphConnections() {
  graphFrameId = 0;
  const canvas = document.getElementById("creation-graph");
  const svg = document.getElementById("graph-connections");
  const outputHandle = canvas.querySelector(".graph-output-handle");
  if (!canvas.clientWidth || !canvas.clientHeight || !outputHandle) return;

  const canvasRect = canvas.getBoundingClientRect();
  const outputRect = outputHandle.getBoundingClientRect();
  const outputX = outputRect.left + outputRect.width / 2 - canvasRect.left;
  const outputY = outputRect.top + outputRect.height / 2 - canvasRect.top;
  svg.setAttribute("viewBox", `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
  svg.replaceChildren();

  canvas.querySelectorAll(".graph-dimension-handle").forEach((handle) => {
    const sourceRect = handle.getBoundingClientRect();
    const sourceX = sourceRect.left + sourceRect.width / 2 - canvasRect.left;
    const sourceY = sourceRect.top + sourceRect.height / 2 - canvasRect.top;
    const bend = Math.max(24, (outputX - sourceX) * 0.48);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${outputX - bend} ${outputY}, ${outputX} ${outputY}`);
    svg.appendChild(path);
  });
}

function scheduleGraphConnections() {
  if (graphFrameId) window.cancelAnimationFrame(graphFrameId);
  graphFrameId = window.requestAnimationFrame(drawGraphConnections);
}

function renderCreationGraph() {
  const sources = graphSourcesFromDoc(view.state.doc);
  const container = document.getElementById("graph-sources");
  const dimensionCount = sources.reduce((total, source) => total + source.dimensions.length, 0);
  container.replaceChildren();

  if (!sources.length) {
    const emptyNode = document.createElement("article");
    emptyNode.className = "graph-node graph-source-node is-empty";
    const kicker = document.createElement("span");
    kicker.className = "graph-node-kicker";
    kicker.textContent = "IMAGE INPUT";
    const title = document.createElement("strong");
    title.textContent = "添加一张参考图";
    emptyNode.append(kicker, title);
    container.appendChild(emptyNode);
  }

  sources.forEach(({ asset, dimensions }, index) => {
    const node = document.createElement("article");
    node.className = "graph-node graph-source-node";
    node.dataset.assetId = asset.id;

    const kicker = document.createElement("span");
    kicker.className = "graph-node-kicker";
    kicker.textContent = `IMAGE INPUT ${String(index + 1).padStart(2, "0")}`;

    const main = document.createElement("div");
    main.className = "graph-source-main";
    const identity = document.createElement("div");
    identity.className = "graph-source-identity";
    const image = document.createElement("img");
    image.src = asset.src;
    image.alt = "";
    const name = document.createElement("strong");
    name.textContent = asset.name;
    identity.append(image, name);

    const dimensionsWrap = document.createElement("div");
    dimensionsWrap.className = "graph-dimension-nodes";
    const visibleDimensions = dimensions.length ? dimensions : ["整图参考"];
    visibleDimensions.forEach((title) => {
      const dimensionNode = document.createElement("div");
      dimensionNode.className = `graph-dimension-node${dimensions.length ? "" : " is-reference"}`;
      const label = document.createElement("span");
      label.textContent = title;
      const handle = document.createElement("span");
      handle.className = "graph-handle graph-dimension-handle";
      handle.setAttribute("aria-hidden", "true");
      dimensionNode.append(label, handle);
      dimensionsWrap.appendChild(dimensionNode);
    });
    main.append(identity, dimensionsWrap);
    node.append(kicker, main);
    container.appendChild(node);
  });

  document.getElementById("graph-summary").textContent = `${sources.length} 图 · ${dimensionCount} 维度`;
  const relation = sources
    .map(({ asset, dimensions }) => `${asset.name}的${dimensions.length ? dimensions.join("、") : "整图"}`)
    .join("；");
  document.getElementById("creation-graph").setAttribute("aria-label", `${relation || "等待参考图"}，共同生成新图`);

  const outputNode = document.getElementById("graph-output-node");
  const outputMark = document.getElementById("graph-output-mark");
  const outputImage = document.getElementById("graph-output-image");
  const outputTitle = document.getElementById("graph-output-title");
  const outputMeta = document.getElementById("graph-output-meta");
  outputNode.classList.remove("is-loading", "is-complete", "is-error");
  outputNode.classList.toggle(`is-${graphOutputState}`, graphOutputState !== "idle");

  const outputCopy = {
    idle: ["生成新图", "等待节点输入"],
    loading: ["正在生成", "节点已发送至模型"],
    complete: ["AI 新作 · 已入库", "生成节点完成"],
    error: ["生成未完成", "调整节点后可重试"],
  }[graphOutputState];
  [outputTitle.textContent, outputMeta.textContent] = outputCopy;
  outputImage.hidden = !graphOutputImage;
  outputMark.hidden = Boolean(graphOutputImage);
  if (graphOutputImage) outputImage.src = graphOutputImage;
  else outputImage.removeAttribute("src");
  scheduleGraphConnections();
}

function setActiveAsset(assetId, message = "已切换当前参考图") {
  const asset = assetById.get(assetId);
  if (!asset) return;
  activeAssetId = assetId;
  document.querySelectorAll(".asset-card").forEach((card) => {
    card.classList.toggle("is-active", card.dataset.id === assetId);
  });
  document.getElementById("active-asset-name").textContent = asset.name;
  document.getElementById("editor-state").textContent = message;
  renderDimensions();
}

function renderDimensions() {
  const container = document.getElementById("dimension-list");
  const asset = assetById.get(activeAssetId);
  const used = usedDimensions(activeAssetId);
  container.replaceChildren();

  Object.keys(asset.dimensions).forEach((title) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `dimension-button${used.has(title) ? " is-used" : ""}`;
    button.textContent = title;
    button.title = asset.dimensions[title];
    button.addEventListener("click", () => insertDimension(title));
    container.appendChild(button);
  });
}

function updateDerivedUI() {
  const { references } = serializeDoc(view.state.doc);
  document.getElementById("editor-state").textContent = `${references.length} 张参考图 · ${view.state.doc.content.size} 个文档单位`;
  renderDimensions();
  renderCreationGraph();
}

function insertAsset(assetId) {
  const asset = assetById.get(assetId);
  if (!asset) return;
  const tr = view.state.tr.replaceSelectionWith(imageNode(asset)).scrollIntoView();
  view.dispatch(tr);
  view.focus();
  setActiveAsset(assetId, `已在当前光标插入「${asset.name}」`);
}

function insertDimension(title) {
  const asset = assetById.get(activeAssetId);
  if (!asset) return;
  const alreadyUsed = usedDimensions(activeAssetId).has(title);
  if (alreadyUsed) {
    document.getElementById("editor-state").textContent = `「${title}」已在文稿中，可选中后退格删除`;
    view.focus();
    return;
  }
  view.dispatch(view.state.tr.replaceSelectionWith(keywordNode(activeAssetId, title)).scrollIntoView());
  view.focus();
  document.getElementById("editor-state").textContent = `已插入「${asset.name} / ${title}」`;
}

view = new EditorView(document.getElementById("board-editor"), {
  state: EditorState.create({
    doc: makeInitialDoc(),
    plugins: [
      history(),
      keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
      keymap(punctuationKeys),
      keymap(baseKeymap),
    ],
  }),
  dispatchTransaction(transaction) {
    view.updateState(view.state.apply(transaction));
    if (transaction.docChanged && graphOutputState === "complete") {
      graphOutputImage = "";
      graphOutputState = "idle";
    }
    updateDerivedUI();
  },
  handleClickOn(_view, _pos, node) {
    if (node.type.name === "image") setActiveAsset(node.attrs.assetId, `当前参考图：${node.attrs.name}`);
    return false;
  },
});

document.getElementById("editor-wrap").addEventListener("click", (event) => {
  // ProseMirror 会根据正文里的点击位置自行更新选区；再次 focus 会把它拉回旧位置。
  if (event.target.closest(".ProseMirror, .editor-meta")) return;
  view.focus();
});

const assetGrid = document.getElementById("asset-grid");
const dimensionList = document.getElementById("dimension-list");

function preserveEditorSelection(event) {
  if (event.button === 0 && event.target.closest("button")) event.preventDefault();
}

// 鼠标按下按钮时不先夺走编辑器焦点，click 仍照常插入到当前选区；键盘操作不受影响。
assetGrid.addEventListener("mousedown", preserveEditorSelection);
dimensionList.addEventListener("mousedown", preserveEditorSelection);

assetGrid.addEventListener("click", (event) => {
  const card = event.target.closest(".asset-card");
  if (card) insertAsset(card.dataset.id);
});

const generateButton = document.getElementById("generate-image");
const generationResult = document.getElementById("generation-result");
const generationPlaceholder = document.getElementById("generation-placeholder");
const generationStatus = document.getElementById("generation-status");
const providerStatus = document.getElementById("provider-status");
const generatedImage = document.getElementById("generated-image");
const windowAssetCount = document.getElementById("window-asset-count");
const paneAssetCount = document.getElementById("pane-asset-count");
const windowsDownload = document.getElementById("windows-download");
const DEMO_COMPLETED_KEY = "bowerbird.websiteDemoCompleted";
let demoDailyLimit = 3;
let demoCurrentDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
let displayedAssetCount = ASSETS.length;
let imageService = null;

function readDemoUsage() {
  try {
    const raw = window.localStorage.getItem(DEMO_COMPLETED_KEY);
    if (!raw) return { day: demoCurrentDay, count: 0 };
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.day === demoCurrentDay && Number.isFinite(parsed.count)) {
        return { day: demoCurrentDay, count: Math.max(0, Math.floor(parsed.count)) };
      }
    } catch {
      const legacyDate = new Date(raw);
      if (!Number.isNaN(legacyDate.getTime())) {
        const legacyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(legacyDate);
        if (legacyDay === demoCurrentDay) return { day: demoCurrentDay, count: 1 };
      }
    }
  } catch {
    // localStorage 不可用时，服务端的 IP 限额仍会生效。
  }
  return { day: demoCurrentDay, count: 0 };
}

function writeDemoUsage(count) {
  try {
    window.localStorage.setItem(DEMO_COMPLETED_KEY, JSON.stringify({ day: demoCurrentDay, count }));
  } catch {
    // 服务端额度仍是最终约束，localStorage 只负责同步当前浏览器的界面。
  }
}

function hasCompletedDemo() {
  return readDemoUsage().count >= demoDailyLimit;
}

function recordDemoUse(authoritativeRemaining) {
  const usage = readDemoUsage();
  const count = Number.isFinite(authoritativeRemaining)
    ? Math.max(0, demoDailyLimit - Math.max(0, Math.floor(authoritativeRemaining)))
    : Math.min(demoDailyLimit, usage.count + 1);
  writeDemoUsage(count);
  return Math.max(0, demoDailyLimit - count);
}

function markDemoLimitReached() {
  writeDemoUsage(demoDailyLimit);
  generateButton.hidden = true;
  generateButton.disabled = true;
  generateButton.dataset.state = "complete";
}

function showDemoLimitReached() {
  markDemoLimitReached();
  showGenerationMessage("下载 Bowerbird，继续使用完整创作与自动入库流程", "");
}

function addGeneratedAsset(imageUrl) {
  const card = document.createElement("article");
  card.className = "asset-card generated-asset";
  card.setAttribute("aria-label", "刚刚生成并自动入库的作品");

  const image = document.createElement("img");
  image.src = imageUrl;
  image.alt = "刚刚生成并自动入库的作品";

  const name = document.createElement("span");
  name.textContent = "AI 新作 · 已入库";

  const badge = document.createElement("i");
  badge.textContent = "✨ NEW";

  card.append(image, name, badge);
  assetGrid.prepend(card);
  displayedAssetCount += 1;
  windowAssetCount.textContent = String(displayedAssetCount);
  paneAssetCount.textContent = String(displayedAssetCount);
}

function showGenerationMessage(title, detail, state = "ready") {
  if (!generationStatus) return;
  generationResult.classList.toggle("is-loading", state === "loading");
  generationResult.classList.toggle("is-error", state === "error");
  generationPlaceholder.hidden = false;
  generationStatus.textContent = title;
  providerStatus.textContent = detail;
  providerStatus.hidden = !detail;
}

function applyDownloadConfig(url) {
  if (typeof url !== "string" || !url.startsWith("https://")) return;
  windowsDownload.href = url;
  windowsDownload.removeAttribute("aria-disabled");
  windowsDownload.classList.remove("is-disabled");
}

async function loadImageService() {
  if (window.location.protocol === "file:") {
    showGenerationMessage("当前是静态预览", "运行 pnpm --filter @bowerbird/website dev 后即可真实生成");
    return;
  }

  try {
    const response = await fetch("/api/image-config", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "生成服务不可用");
    imageService = payload;
    applyDownloadConfig(payload.windowsDownloadUrl);
    demoDailyLimit = Number.isFinite(payload.trialLimit) ? payload.trialLimit : 3;
    demoCurrentDay = payload.trialDay || demoCurrentDay;
    if (hasCompletedDemo()) {
      showDemoLimitReached();
      return;
    }
    const detail = payload.configured
      ? `每位访客每日可体验 ${demoDailyLimit} 次 · 生成结果自动进入左侧素材库`
      : "请先在 website/.env.local 配置服务端密钥";
    showGenerationMessage(`${payload.label}${payload.configured ? " 已就绪" : " 待配置"}`, detail);
  } catch {
    showGenerationMessage("未连接到生成服务", "请通过项目开发服务器打开本页", "error");
  }
}

generateButton.addEventListener("click", async () => {
  if (hasCompletedDemo()) {
    showDemoLimitReached();
    return;
  }
  if (window.location.protocol === "file:") {
    showGenerationMessage("静态文件无法安全调用生图 API", "请用项目开发服务器打开；API Key 不会写进网页", "error");
    return;
  }

  const { prompt, references } = serializeDoc(view.state.doc);
  if (!prompt.trim()) {
    showGenerationMessage("先写下你的创作意图", "Prompt 不能为空", "error");
    view.focus();
    return;
  }

  generateButton.disabled = true;
  generateButton.querySelector("span").textContent = "生成中…";
  generatedImage.hidden = true;
  graphOutputImage = "";
  graphOutputState = "loading";
  renderCreationGraph();
  showGenerationMessage(
    `正在调用 ${imageService?.label || "图像模型"}`,
    `发送 ${references.length} 张参考图，请保持页面开启`,
    "loading",
  );

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 135000);

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ prompt, referenceIds: references }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 429) {
        graphOutputState = "error";
        renderCreationGraph();
        showDemoLimitReached();
        return;
      }
      throw new Error(payload.error || `生成失败（${response.status}）`);
    }
    if (!payload.image) throw new Error("服务未返回图片");

    addGeneratedAsset(payload.image);
    generatedImage.src = payload.image;
    generatedImage.hidden = false;
    graphOutputImage = payload.image;
    graphOutputState = "complete";
    renderCreationGraph();
    const remaining = recordDemoUse(payload.trialRemaining);
    if (remaining === 0) showDemoLimitReached();
    else showGenerationMessage("生成完成，已自动入库", `新作品已进入左侧素材库 · 今日还可体验 ${remaining} 次`);
    imageService = { ...imageService, label: payload.providerLabel || imageService?.label };
  } catch (error) {
    const message = error.name === "AbortError" ? "生成超时，请稍后重试" : error.message;
    graphOutputState = "error";
    renderCreationGraph();
    showGenerationMessage("这次没有生成成功", message, "error");
  } finally {
    window.clearTimeout(timeoutId);
    if (!hasCompletedDemo()) {
      generateButton.hidden = false;
      generateButton.disabled = false;
      generateButton.querySelector("span").textContent = "创作图片";
    }
  }
});

const menuToggle = document.getElementById("menu-toggle");
const siteNav = document.getElementById("site-nav");
menuToggle.addEventListener("click", () => {
  const open = siteNav.classList.toggle("is-open");
  menuToggle.setAttribute("aria-expanded", String(open));
});
siteNav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    siteNav.classList.remove("is-open");
    menuToggle.setAttribute("aria-expanded", "false");
  });
});

document.documentElement.classList.add("js");

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.08 },
);
document.querySelectorAll(".reveal").forEach((element) => revealObserver.observe(element));

window.addEventListener("resize", scheduleGraphConnections);

updateDerivedUI();
loadImageService();
