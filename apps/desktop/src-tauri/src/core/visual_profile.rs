//! 品牌视觉规范 —— 素材库内独立保存的版本与快照。
//!
//! 本模块只读取文字观察记录；品牌工作流会在用户点击总结后，通过既有理解队列补齐图片分析。
//! 来源是用户指定的普通素材库文件夹，规范可用于任何创作，不依附项目。
//! 只由命令主动触发，不监听库变化、不自动改写已保存版本。
//!
//! 提炼为确定性基线（apps/agent-worker/src/visual/extract.ts 的 Rust 移植，V0 可审计基线）；
//! 真实模型的分批事实抽取与聚合属 V2。内容主题只进 contentThemes，绝不转视觉硬约束。

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::error::{AppError, AppResult};

pub const MIN_EFFECTIVE_CARDS: usize = 5;
/// 品牌图片工作流允许从一张图片开始；离线统计基线仍保留原门槛。
pub const MIN_BRAND_IMAGES: usize = 1;
const BRAND_OBSERVATION_TASK: &str = "bowerbird:brand-visual-observation:v2";
const DOMINANT_COVERAGE: f64 = 0.6;
const SECONDARY_CONFLICT_RATIO: f64 = 0.25;
const MIN_DIRECTION_RATIO: f64 = 0.2;
const MAX_CANDIDATE_DIRECTIONS: usize = 3;

/// 参与提炼的 caption 维度（action 是内容性维度，不进视觉语言）。
const VISUAL_DIMENSIONS: [&str; 4] = ["composition", "light", "palette", "mood"];

fn section_category(title: &str) -> Option<&'static str> {
    match title.trim() {
        "材质" | "笔触" => Some("material"),
        "类型" | "媒介" => Some("medium"),
        "版式" => Some("layout"),
        _ => None,
    }
}

fn is_content_theme_title(title: &str) -> bool {
    matches!(title.trim(), "主体" | "内容" | "题材" | "主题" | "内容主题")
}

fn is_generated_source(source: &str) -> bool {
    matches!(
        source,
        "codex" | "openai" | "jimeng" | "annotation" | "bowerbird-agent"
    ) || source.starts_with("bowerbird-cloud")
}

// ---------------------------------------------------------------------------
// 数据契约（与 apps/agent-worker/src/contracts/visual-profile.ts 对齐）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvidenceSection {
    pub title: String,
    pub body: String,
}

/// 规范化反推证据卡。不含文件路径、原文件名、图片 URL、缩略图、二进制（§8.3）。
/// camelCase 序列化与云端 visual-profile create 的白名单字段同形（V2 提交载荷直接复用）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualEvidenceCard {
    pub asset_id: String,
    pub caption_id: String,
    pub caption_hash: String,
    pub sections: Vec<EvidenceSection>,
    pub dimensions: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_fallback: Option<String>,
    pub parse_status: String,
    /// imported | generated_confirmed | generated_other
    pub source_class: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DraftRule {
    pub id: String,
    pub category: String,
    pub value: String,
    /// must | prefer | avoid
    pub polarity: String,
    pub confidence: f64,
    pub supporting_asset_ids: Vec<String>,
    pub opposing_asset_ids: Vec<String>,
    pub confirmed_by_user: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentTheme {
    pub value: String,
    pub supporting_asset_ids: Vec<String>,
    pub coverage: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub value: String,
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceConflict {
    pub description: String,
    pub side_a: ConflictSide,
    pub side_b: ConflictSide,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDirection {
    pub label: String,
    pub summary: String,
    pub supporting_asset_ids: Vec<String>,
    pub opposing_asset_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// caption 规范化（纯函数）
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct CaptionPayload {
    #[serde(default)]
    instruction: Option<String>,
    #[serde(default)]
    sections: Vec<EvidenceSection>,
    #[serde(default)]
    dimensions: BTreeMap<String, String>,
    #[serde(default)]
    parse_status: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let mut out = String::with_capacity(64);
    for byte in Sha256::digest(bytes).iter() {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// caption 内容 hash：canonical JSON {s: sections, d: dimensions, t: text}（对象键排序）。
fn caption_hash(
    sections: &[EvidenceSection],
    dimensions: &BTreeMap<String, String>,
    text: Option<&str>,
) -> String {
    let payload = serde_json::json!({
        "s": sections,
        "d": dimensions,
        "t": text.unwrap_or(""),
    });
    hex_digest(
        serde_json::to_string(&payload)
            .unwrap_or_default()
            .as_bytes(),
    )
}

/// 解析 caption payload 为证据卡；旧 `{text}` / 无结构 payload → sections/dimensions 为空，
/// effective=false（不参与提炼，也不触发自动补反推）。
fn to_evidence_card(
    asset_id: &str,
    caption_id: &str,
    payload_json: &str,
    source: &str,
) -> VisualEvidenceCard {
    let parsed: CaptionPayload = serde_json::from_str(payload_json).unwrap_or_default();
    let effective = !parsed.sections.is_empty() || !parsed.dimensions.is_empty();
    let parse_status = parsed
        .parse_status
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if effective {
                "ok".into()
            } else {
                "raw_fallback".into()
            }
        });
    VisualEvidenceCard {
        asset_id: asset_id.to_string(),
        caption_id: caption_id.to_string(),
        caption_hash: caption_hash(&parsed.sections, &parsed.dimensions, parsed.text.as_deref()),
        sections: parsed.sections,
        dimensions: parsed.dimensions,
        text_fallback: parsed.text.filter(|t| !t.trim().is_empty()),
        parse_status,
        source_class: if is_generated_source(source) {
            "generated_confirmed".into()
        } else {
            "imported".into()
        },
    }
}

fn card_is_effective(card: &VisualEvidenceCard) -> bool {
    !card.sections.is_empty() || !card.dimensions.is_empty()
}

// ---------------------------------------------------------------------------
// scope hash（§8.3：冻结点击瞬间快照，不用于持续监听）
// ---------------------------------------------------------------------------

pub fn source_scope_hash(
    _project_id: &str,
    folder_id: &str,
    cards: &[VisualEvidenceCard],
) -> String {
    let mut entries: Vec<String> = cards
        .iter()
        .map(|c| format!("{}:{}:{}", c.asset_id, c.caption_id, c.caption_hash))
        .collect();
    entries.sort();
    hex_digest(format!("scope|{folder_id}|{}", entries.join("|")).as_bytes())
}

// ---------------------------------------------------------------------------
// 确定性提取（V0 基线移植）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VisualProfileDraft {
    pub schema_version: i32,
    pub source_scope_hash: String,
    pub summary: String,
    pub visual_rules: Vec<DraftRule>,
    pub content_themes: Vec<ContentTheme>,
    pub conflicts: Vec<EvidenceConflict>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidate_directions: Vec<CandidateDirection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ExtractOutcome {
    Insufficient {
        effective_count: usize,
        min_required: usize,
    },
    Draft {
        draft: VisualProfileDraft,
        effective_count: usize,
    },
}

struct CardValue {
    value: String,
    asset_id: String,
}

fn visual_values(card: &VisualEvidenceCard) -> Vec<(&'static str, CardValue)> {
    let mut out = Vec::new();
    for key in VISUAL_DIMENSIONS {
        if let Some(v) = card.dimensions.get(key) {
            if !v.trim().is_empty() {
                out.push((
                    key,
                    CardValue {
                        value: v.trim().to_string(),
                        asset_id: card.asset_id.clone(),
                    },
                ));
            }
        }
    }
    for section in &card.sections {
        if let Some(category) = section_category(&section.title) {
            if !section.body.trim().is_empty() {
                out.push((
                    category,
                    CardValue {
                        value: section.body.trim().to_string(),
                        asset_id: card.asset_id.clone(),
                    },
                ));
            }
        }
    }
    out
}

fn content_values(card: &VisualEvidenceCard) -> Vec<CardValue> {
    let mut out = Vec::new();
    for section in &card.sections {
        if is_content_theme_title(&section.title) {
            for token in section.body.split(['、', ',', '，', '；', ';']) {
                let token = token.trim();
                if !token.is_empty() {
                    out.push(CardValue {
                        value: token.to_string(),
                        asset_id: card.asset_id.clone(),
                    });
                }
            }
        }
    }
    out
}

/// 聚合为 (value → assetIds)，按支持数降序、同数按 value 升序保证确定性。
fn aggregate(values: Vec<CardValue>) -> Vec<(String, Vec<String>)> {
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for v in values {
        map.entry(v.value).or_default().push(v.asset_id);
    }
    let mut groups: Vec<(String, Vec<String>)> = map.into_iter().collect();
    groups.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
    groups
}

pub fn extract_draft(
    project_id: &str,
    folder_id: &str,
    cards: &[VisualEvidenceCard],
) -> ExtractOutcome {
    let effective: Vec<&VisualEvidenceCard> =
        cards.iter().filter(|c| card_is_effective(c)).collect();
    if effective.len() < MIN_EFFECTIVE_CARDS {
        return ExtractOutcome::Insufficient {
            effective_count: effective.len(),
            min_required: MIN_EFFECTIVE_CARDS,
        };
    }

    // 视觉规则 / 冲突：按类别聚合
    let mut by_category: BTreeMap<&'static str, Vec<CardValue>> = BTreeMap::new();
    for card in &effective {
        for (category, value) in visual_values(card) {
            by_category.entry(category).or_default().push(value);
        }
    }
    let mut visual_rules = Vec::new();
    let mut conflicts = Vec::new();
    for (category, values) in by_category {
        let total = values.len().max(1) as f64;
        let agg = aggregate(values);
        let Some((top_value, top_ids)) = agg.first() else {
            continue;
        };
        let top_coverage = top_ids.len() as f64 / total;
        if top_coverage >= DOMINANT_COVERAGE {
            let opposing = agg[1..]
                .iter()
                .flat_map(|(_, ids)| ids.clone())
                .collect::<Vec<_>>();
            visual_rules.push(DraftRule {
                id: Ulid::new().to_string(),
                category: category.to_string(),
                value: top_value.clone(),
                polarity: "prefer".into(),
                confidence: top_coverage,
                supporting_asset_ids: top_ids.clone(),
                opposing_asset_ids: opposing,
                confirmed_by_user: false,
            });
        } else if agg.len() >= 2 && agg[1].1.len() as f64 / total >= SECONDARY_CONFLICT_RATIO {
            let (a_value, a_ids) = &agg[0];
            let (b_value, b_ids) = &agg[1];
            conflicts.push(EvidenceConflict {
                description: format!("{category}: {a_value} vs {b_value}"),
                side_a: ConflictSide {
                    value: a_value.clone(),
                    asset_ids: a_ids.clone(),
                },
                side_b: ConflictSide {
                    value: b_value.clone(),
                    asset_ids: b_ids.clone(),
                },
            });
        }
    }

    // 内容主题（绝不转视觉硬约束）
    let content_all: Vec<CardValue> = effective.iter().flat_map(|c| content_values(c)).collect();
    let content_total = content_all.len().max(1) as f64;
    let content_themes: Vec<ContentTheme> = aggregate(content_all)
        .into_iter()
        .map(|(value, ids)| {
            let coverage = ids.len() as f64 / content_total;
            ContentTheme {
                value,
                supporting_asset_ids: ids,
                coverage,
                confidence: coverage,
            }
        })
        .collect();

    // 候选方向：palette+mood 签名聚类，≥2 簇才产出（不强行平均，§8.4）
    let mut clusters: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for card in &effective {
        let signature = format!(
            "{}|{}",
            card.dimensions
                .get("palette")
                .map(String::as_str)
                .unwrap_or(""),
            card.dimensions
                .get("mood")
                .map(String::as_str)
                .unwrap_or("")
        );
        clusters
            .entry(signature)
            .or_default()
            .push(card.asset_id.clone());
    }
    let mut sorted_clusters: Vec<(String, Vec<String>)> = clusters.into_iter().collect();
    sorted_clusters.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
    let total = effective.len() as f64;
    let mut candidate_directions = Vec::new();
    if sorted_clusters.len() >= 2 {
        for (signature, ids) in &sorted_clusters {
            if ids.len() as f64 / total < MIN_DIRECTION_RATIO {
                continue;
            }
            if candidate_directions.len() >= MAX_CANDIDATE_DIRECTIONS {
                break;
            }
            let opposing = sorted_clusters
                .iter()
                .filter(|(s, _)| s != signature)
                .flat_map(|(_, ids)| ids.clone())
                .collect::<Vec<_>>();
            candidate_directions.push(CandidateDirection {
                label: if signature.is_empty() {
                    "default".into()
                } else {
                    signature.clone()
                },
                summary: format!("{} 张素材支持此方向", ids.len()),
                supporting_asset_ids: ids.clone(),
                opposing_asset_ids: opposing,
            });
        }
    }

    let draft = VisualProfileDraft {
        schema_version: 1,
        source_scope_hash: source_scope_hash(project_id, folder_id, cards),
        summary: format!(
            "{} 张有效反推素材；{} 条视觉规则，{} 处冲突，{} 个内容主题。",
            effective.len(),
            visual_rules.len(),
            conflicts.len(),
            content_themes.len()
        ),
        visual_rules,
        content_themes,
        conflicts,
        candidate_directions,
    };
    ExtractOutcome::Draft {
        draft,
        effective_count: effective.len(),
    }
}

/// V3-T1：从 draft 规则编译纯文生验证 prompt。**只含文字规则 + 中性主题**：
/// 不含内容主题（默认不转硬约束）、不含任何来源素材图片（reference_assets 恒为空）。
pub fn compile_validation_prompt(rules: &[DraftRule], theme: &str) -> String {
    const CATEGORY_LABELS: [(&str, &str); 7] = [
        ("composition", "构图"),
        ("light", "光线"),
        ("palette", "色彩"),
        ("mood", "氛围"),
        ("material", "材质"),
        ("medium", "类型"),
        ("layout", "版式"),
    ];
    let label = |category: &str| -> String {
        CATEGORY_LABELS
            .iter()
            .find(|(key, _)| *key == category)
            .map(|(_, label)| label.to_string())
            .unwrap_or_else(|| category.to_string())
    };
    let mut must = Vec::new();
    let mut prefer = Vec::new();
    let mut avoid = Vec::new();
    for rule in rules {
        let line = format!("{}：{}", label(&rule.category), rule.value.trim());
        match rule.polarity.as_str() {
            "must" => must.push(line),
            "avoid" => avoid.push(line),
            _ => prefer.push(line),
        }
    }
    let mut prompt = format!(
        "一张{}的图片。整体遵循以下品牌视觉风格规范：",
        theme.trim().chars().take(120).collect::<String>()
    );
    if !must.is_empty() {
        prompt.push_str("\n必须满足：");
        prompt.push_str(&must.join("；"));
    }
    if !prefer.is_empty() {
        prompt.push_str("\n风格倾向：");
        prompt.push_str(&prefer.join("；"));
    }
    if !avoid.is_empty() {
        prompt.push_str("\n避免出现：");
        prompt.push_str(&avoid.join("；"));
    }
    prompt.push_str("\n画面内不要出现任何文字。");
    prompt
}

// ---------------------------------------------------------------------------
// 查询与落库
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingAsset {
    pub asset_id: String,
    pub name: String,
    /// no_caption | not_parseable
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopePreview {
    pub asset_ids: Vec<String>,
    pub folder_id: String,
    pub folder_name: String,
    /// 用户明确选择的普通文件夹中的素材数（不要求项目成员关系）
    pub in_folder: usize,
    /// 有最新有效反推、将参与提炼的素材数
    pub effective: usize,
    pub missing: Vec<MissingAsset>,
    pub min_required: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualProfileSummary {
    pub id: String,
    /// Historical origin only; independent profiles have no project owner.
    pub project_id: Option<String>,
    pub folder_id: String,
    pub name: String,
    pub version: i64,
    pub status: String,
    pub extractor: String,
    pub summary: String,
    pub source_count: i64,
    pub rule_count: i64,
    pub created_at: i64,
    pub confirmed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualProfileDetail {
    #[serde(flatten)]
    pub summary: VisualProfileSummary,
    pub source_scope_hash: String,
    pub source_asset_ids: Vec<String>,
    pub source_requirements: Option<String>,
    pub rules: Vec<DraftRule>,
    pub content_themes: Vec<ContentTheme>,
    pub conflicts: Vec<EvidenceConflict>,
    pub candidate_directions: Vec<CandidateDirection>,
}

/// V4 注入用的已确认规则值。证据细节只留在本地 profile 表，不进入生成 prompt / Agent Run。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VisualRuleValue {
    pub category: String,
    pub value: String,
    pub polarity: String,
}

/// 已确认视觉设定的只读、版本化快照（AGENT-RUNTIME-PLAN §8.8 / V4）。
/// `hash` 对除自身外的全部字段做 canonical JSON SHA-256，供生成历史与 Agent Run 追溯。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VisualProfileCapsule {
    pub schema_version: u8,
    pub profile_id: String,
    pub version: i64,
    pub source_scope_hash: String,
    pub summary: String,
    pub must: Vec<VisualRuleValue>,
    pub prefer: Vec<VisualRuleValue>,
    pub avoid: Vec<VisualRuleValue>,
    pub content_themes: Vec<String>,
    pub hash: String,
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".into(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => {
            serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
        }
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(values) => {
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into()),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn capsule_hash_payload(capsule: &VisualProfileCapsule) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": capsule.schema_version,
        "profileId": capsule.profile_id,
        "version": capsule.version,
        "sourceScopeHash": capsule.source_scope_hash,
        "summary": capsule.summary,
        "must": capsule.must,
        "prefer": capsule.prefer,
        "avoid": capsule.avoid,
        "contentThemes": capsule.content_themes,
    })
}

fn compile_capsule(detail: &VisualProfileDetail) -> AppResult<VisualProfileCapsule> {
    if detail.summary.status != "confirmed" {
        return Err(AppError::Other("只有已确认的视觉设定可以用于生成".into()));
    }
    let values = |polarity: &str| {
        detail
            .rules
            .iter()
            .filter(|rule| rule.polarity == polarity)
            .map(|rule| VisualRuleValue {
                category: rule.category.clone(),
                value: rule.value.trim().to_string(),
                polarity: polarity.to_string(),
            })
            .collect::<Vec<_>>()
    };
    let mut capsule = VisualProfileCapsule {
        schema_version: 1,
        profile_id: detail.summary.id.clone(),
        version: detail.summary.version,
        source_scope_hash: detail.source_scope_hash.clone(),
        summary: detail.summary.summary.clone(),
        must: values("must"),
        prefer: values("prefer"),
        avoid: values("avoid"),
        content_themes: detail
            .content_themes
            .iter()
            .map(|theme| theme.value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect(),
        hash: String::new(),
    };
    capsule.hash = format!(
        "{:x}",
        Sha256::digest(canonical_json(&capsule_hash_payload(&capsule)).as_bytes())
    );
    Ok(capsule)
}

/// 直接生成的确定性 PromptCompiler。视觉设定只填补本次任务未说明的视觉选择；
/// 用户当前明确目标永远优先，内容主题不进入 prompt，避免变成强制画面元素。
pub fn inject_visual_profile_prompt(prompt: &str, capsule: &VisualProfileCapsule) -> String {
    let render = |label: &str, values: &[VisualRuleValue]| -> Option<String> {
        (!values.is_empty()).then(|| {
            format!(
                "{label}：{}",
                values
                    .iter()
                    .map(|rule| format!("{}={}", rule.category, rule.value))
                    .collect::<Vec<_>>()
                    .join("；")
            )
        })
    };
    let rules = [
        render("必须保持", &capsule.must),
        render("尽量遵循", &capsule.prefer),
        render("必须避免", &capsule.avoid),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");
    if rules.is_empty() {
        return prompt.to_string();
    }
    format!(
        "{prompt}\n\n【品牌视觉规范 v{}】\n以下规则只补充本次任务未明确指定的部分；若与本次明确要求冲突，一律以本次要求为准。不得把常见内容主题自动加入画面。\n{rules}",
        capsule.version
    )
}

struct FolderAssetRow {
    asset_id: String,
    name: String,
    origin_path: Option<String>,
    store_path: Option<String>,
    source_url: Option<String>,
    source: String,
    caption_id: Option<String>,
    caption_payload: Option<String>,
}

fn load_folder_assets(
    conn: &Connection,
    folder_id: &str,
) -> AppResult<Vec<FolderAssetRow>> {
    load_visual_source_assets(conn, Some(folder_id), &[])
}

fn load_visual_source_assets(conn: &Connection, folder_id: Option<&str>, asset_ids: &[String]) -> AppResult<Vec<FolderAssetRow>> {
    // Source images and saved profiles belong to the central library.
    // Do not intersect the source selection with canvas membership.
    // 最新 caption 按 created_at DESC, rowid DESC 决胜（同秒多行约定，core/library.rs）。
    let sql = r#"
        SELECT a.id, a.name, a.origin_path, a.store_path, a.source_url, a.source,
               (SELECT ca.id FROM analyses ca
                 WHERE ca.asset_id = a.id AND ca.kind = 'caption'
                 ORDER BY ca.created_at DESC, ca.rowid DESC LIMIT 1),
               (SELECT ca.payload FROM analyses ca
                 WHERE ca.asset_id = a.id AND ca.kind = 'caption'
                 ORDER BY ca.created_at DESC, ca.rowid DESC LIMIT 1)
        FROM assets a
        WHERE (?1 IS NOT NULL AND a.folder_id = ?1) OR (?1 IS NULL AND a.id IN (SELECT value FROM json_each(?2)))
        ORDER BY a.id
    "#;
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(rusqlite::params![folder_id, serde_json::to_string(asset_ids)?], |row| {
        Ok(FolderAssetRow {
            asset_id: row.get(0)?,
            name: row.get(1)?,
            origin_path: row.get(2)?,
            store_path: row.get(3)?,
            source_url: row.get(4)?,
            source: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            caption_id: row.get(6)?,
            caption_payload: row.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn assert_source_folder(conn: &Connection, _project_id: &str, folder_id: &str) -> AppResult<String> {
    if folder_id == "root" {
        return Err(AppError::Other(
            "「全部素材」不能作为视觉设定来源，请选择一个普通文件夹".into(),
        ));
    }
    let folder: Option<(String, String)> = conn
        .query_row(
            "SELECT name, COALESCE(kind,'folder') FROM folders WHERE id = ?1",
            rusqlite::params![folder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    let Some((name, kind)) = folder else {
        return Err(AppError::Other("文件夹不存在".into()));
    };
    if kind != "folder" {
        return Err(AppError::Other(
            "只有普通文件夹能提炼视觉设定（收藏夹/智能文件夹不支持）".into(),
        ));
    }
    Ok(name)
}

/// 提交载荷脱敏断言（V1-T3）：序列化证据卡不得包含任何源资产的
/// 文件名 / 路径 / source_url。构造路径本身不读这些字段，此断言是 fail-closed 兜底。
fn assert_payload_clean(cards: &[VisualEvidenceCard], rows: &[FolderAssetRow]) -> AppResult<()> {
    let payload = serde_json::to_string(cards)
        .map_err(|error| AppError::Other(format!("证据卡序列化失败: {error}")))?;
    for row in rows {
        let mut sensitive_values: Vec<&str> = vec![row.name.as_str()];
        for value in [&row.origin_path, &row.store_path, &row.source_url] {
            if let Some(value) = value {
                sensitive_values.push(value.as_str());
            }
        }
        for value in sensitive_values {
            let value = value.trim();
            if value.len() >= 4 && payload.contains(value) {
                return Err(AppError::Other(format!(
                    "证据载荷包含本机敏感信息（asset {}），已阻止落库",
                    row.asset_id
                )));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// V2：草稿编辑输入与云端 draft 解析
// ---------------------------------------------------------------------------

/// V2-T3 草稿编辑的单条规则输入（整组替换语义）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleEdit {
    pub category: String,
    pub value: String,
    pub polarity: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub supporting_asset_ids: Vec<String>,
    #[serde(default)]
    pub opposing_asset_ids: Vec<String>,
    #[serde(default)]
    pub confirmed_by_user: bool,
}

fn validate_rule_shape(category: &str, value: &str, polarity: &str) -> AppResult<()> {
    const CATEGORIES: [&str; 7] = [
        "composition",
        "light",
        "palette",
        "mood",
        "material",
        "medium",
        "layout",
    ];
    if !CATEGORIES.contains(&category) {
        return Err(AppError::Other(format!("未知视觉类别：{category}")));
    }
    if !["must", "prefer", "avoid"].contains(&polarity) {
        return Err(AppError::Other(format!("未知规则强度：{polarity}")));
    }
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 200 {
        return Err(AppError::Other("规则内容需在 1–200 字之间".into()));
    }
    Ok(())
}

/// 从冻结证据卡 JSON 提取 asset id 集合（source 关联行用）。
fn draft_asset_ids(cards_json: &str) -> Vec<String> {
    let value: serde_json::Value = serde_json::from_str(cards_json).unwrap_or_default();
    serde_json::from_value::<Vec<VisualEvidenceCard>>(value.get("cards").unwrap_or(&value).clone())
        .map(|cards| cards.into_iter().map(|c| c.asset_id).collect())
        .unwrap_or_default()
}

/// 解析并校验云端返回的 draft JSON（V2-T2 结构化输出校验的桌面侧收口）：
/// 类别闭集、极性枚举、素材 provenance 白名单（引用未知素材的条目丢弃）。
fn parse_cloud_draft(
    cloud_draft_json: &str,
    cards: &[VisualEvidenceCard],
    project_id: &str,
    folder_id: &str,
    allow_text_rules: bool,
) -> AppResult<VisualProfileDraft> {
    // worker 聚合输出为 camelCase（apps/agent-worker cloud-visual CloudVisualDraft）。
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CloudTheme {
        value: String,
        #[serde(default)]
        supporting_asset_ids: Vec<String>,
        #[serde(default)]
        coverage: f64,
        #[serde(default)]
        confidence: f64,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CloudSide {
        value: String,
        #[serde(default)]
        asset_ids: Vec<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CloudRule {
        category: String,
        value: String,
        polarity: String,
        #[serde(default)]
        confidence: f64,
        #[serde(default)]
        supporting_asset_ids: Vec<String>,
        #[serde(default)]
        opposing_asset_ids: Vec<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CloudConflict {
        description: String,
        side_a: CloudSide,
        side_b: CloudSide,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CloudDirection {
        label: String,
        summary: String,
        #[serde(default)]
        supporting_asset_ids: Vec<String>,
        #[serde(default)]
        opposing_asset_ids: Vec<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CloudDraft {
        schema_version: i32,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        visual_rules: Vec<CloudRule>,
        #[serde(default)]
        content_themes: Vec<CloudTheme>,
        #[serde(default)]
        conflicts: Vec<CloudConflict>,
        #[serde(default)]
        candidate_directions: Vec<CloudDirection>,
    }
    let parsed: CloudDraft = serde_json::from_str(cloud_draft_json)
        .map_err(|error| AppError::Other(format!("云端提炼结果无法解析: {error}")))?;
    if parsed.schema_version != 1 {
        return Err(AppError::Other(format!(
            "云端提炼结果版本不支持: {}",
            parsed.schema_version
        )));
    }
    let known: std::collections::HashSet<&str> =
        cards.iter().map(|c| c.asset_id.as_str()).collect();
    let filter_ids = |ids: &[String]| -> Vec<String> {
        ids.iter()
            .filter(|id| known.contains(id.as_str()))
            .cloned()
            .collect()
    };
    let mut visual_rules = Vec::new();
    for rule in parsed.visual_rules.into_iter().take(64) {
        let supporting = filter_ids(&rule.supporting_asset_ids);
        if supporting.is_empty() && !allow_text_rules {
            continue;
        }
        validate_rule_shape(&rule.category, &rule.value, &rule.polarity)?;
        visual_rules.push(DraftRule {
            id: Ulid::new().to_string(),
            category: rule.category,
            value: rule.value.trim().chars().take(200).collect(),
            polarity: rule.polarity,
            confidence: rule.confidence.clamp(0.0, 1.0),
            supporting_asset_ids: supporting,
            opposing_asset_ids: filter_ids(&rule.opposing_asset_ids),
            confirmed_by_user: false,
        });
    }
    let content_themes: Vec<ContentTheme> = parsed
        .content_themes
        .into_iter()
        .filter_map(|theme| {
            let supporting = filter_ids(&theme.supporting_asset_ids);
            if supporting.is_empty() {
                None
            } else {
                Some(ContentTheme {
                    value: theme.value.trim().chars().take(200).collect(),
                    supporting_asset_ids: supporting,
                    coverage: theme.coverage.clamp(0.0, 1.0),
                    confidence: theme.confidence.clamp(0.0, 1.0),
                })
            }
        })
        .take(64)
        .collect();
    let conflicts: Vec<EvidenceConflict> = parsed
        .conflicts
        .into_iter()
        .map(|conflict| EvidenceConflict {
            description: conflict.description.trim().chars().take(300).collect(),
            side_a: ConflictSide {
                value: conflict.side_a.value,
                asset_ids: filter_ids(&conflict.side_a.asset_ids),
            },
            side_b: ConflictSide {
                value: conflict.side_b.value,
                asset_ids: filter_ids(&conflict.side_b.asset_ids),
            },
        })
        .take(32)
        .collect();
    let candidate_directions: Vec<CandidateDirection> = parsed
        .candidate_directions
        .into_iter()
        .map(|direction| CandidateDirection {
            label: direction.label.trim().chars().take(120).collect(),
            summary: direction.summary.trim().chars().take(200).collect(),
            supporting_asset_ids: filter_ids(&direction.supporting_asset_ids),
            opposing_asset_ids: filter_ids(&direction.opposing_asset_ids),
        })
        .take(3)
        .collect();
    Ok(VisualProfileDraft {
        schema_version: 1,
        source_scope_hash: source_scope_hash(project_id, folder_id, cards),
        summary: if parsed.summary.trim().is_empty() {
            format!("云端模型提炼；{} 条视觉规则。", visual_rules.len())
        } else {
            parsed.summary.trim().chars().take(300).collect()
        },
        visual_rules,
        content_themes,
        conflicts,
        candidate_directions,
    })
}

// ---------------------------------------------------------------------------
// Database 扩展
// ---------------------------------------------------------------------------

impl crate::db::Database {
    /// Workflow sources are explicit assets, never a synthetic folder or project-owned profile.
    pub fn visual_profile_input_cards(&self, asset_ids: &[String], require_complete: bool) -> AppResult<(Vec<VisualEvidenceCard>, Vec<String>)> {
        let unique: std::collections::BTreeSet<_> = asset_ids.iter().collect();
        if unique.len() != asset_ids.len() || asset_ids.len() > 500 { return Err(AppError::Other("图片范围无效，最多 500 张".into())); }
        let conn = self.conn.lock().unwrap();
        let rows = load_visual_source_assets(&conn, None, asset_ids)?;
        if rows.len() != asset_ids.len() { return Err(AppError::Other("输入图片已丢失，请重新选择".into())); }
        let mut cards = Vec::new();
        let mut missing = Vec::new();
        for row in &rows {
            let parsed = row.caption_payload.as_deref().and_then(|raw| serde_json::from_str::<CaptionPayload>(raw).ok());
            let card = row.caption_id.as_deref().zip(row.caption_payload.as_deref())
                .map(|(id, payload)| to_evidence_card(&row.asset_id, id, payload, &row.source));
            if parsed.and_then(|p| p.instruction).as_deref() == Some(BRAND_OBSERVATION_TASK) && card.as_ref().is_some_and(card_is_effective) {
                cards.push(card.unwrap());
            } else { missing.push(row.asset_id.clone()); }
        }
        if require_complete && !missing.is_empty() { return Err(AppError::Other("请先完成所有输入图片的品牌观察".into())); }
        assert_payload_clean(&cards, &rows)?;
        Ok((cards, missing))
    }

    pub fn persist_workflow_visual_profile(&self, scope_key: &str, name: &str, cards: &[VisualEvidenceCard], requirements: &str, raw: &str) -> AppResult<VisualProfileDetail> {
        let scope = format!("workflow:{scope_key}");
        let mut draft = parse_cloud_draft(raw, cards, "", &scope, !requirements.trim().is_empty())?;
        if draft.visual_rules.is_empty() { return Err(AppError::Other("未提炼出可用的视觉规则，请补充图片或文字".into())); }
        draft.source_scope_hash = hex_digest(format!("{}\n{}", draft.source_scope_hash, requirements));
        let payload = serde_json::json!({"schemaVersion":2,"cards":cards,"requirements":requirements}).to_string();
        let mut conn = self.conn.lock().unwrap();
        let id = Self::insert_draft_row(&mut conn, "", &scope, name, &draft, &payload, cards.len() as i64, "cloud_model")?;
        Self::visual_profile_detail(&conn, &id)
    }

    /// 覆盖率预览（只读，不产生任何副作用；§8.3「启动前本地检查」）。
    pub fn visual_profile_preview(
        &self,
        project_id: &str,
        folder_id: &str,
    ) -> AppResult<ScopePreview> {
        let conn = self.conn.lock().unwrap();
        let folder_name = assert_source_folder(&conn, project_id, folder_id)?;
        let rows = load_folder_assets(&conn, folder_id)?;
        let mut missing = Vec::new();
        let mut effective = 0usize;
        for row in &rows {
            let effective_row = row
                .caption_payload
                .as_deref()
                .and_then(|payload| serde_json::from_str::<CaptionPayload>(payload).ok())
                .map(|parsed| parsed.instruction.as_deref() == Some(BRAND_OBSERVATION_TASK)
                    && (!parsed.sections.is_empty() || !parsed.dimensions.is_empty()))
                .unwrap_or(false);
            if effective_row {
                effective += 1;
            } else {
                let reason = if row.caption_id.is_none() {
                    "no_caption"
                } else {
                    "brand_observation_required"
                };
                missing.push(MissingAsset {
                    asset_id: row.asset_id.clone(),
                    name: row.name.clone(),
                    reason: reason.into(),
                });
            }
        }
        Ok(ScopePreview {
            asset_ids: rows.iter().map(|row| row.asset_id.clone()).collect(),
            folder_id: folder_id.to_string(),
            folder_name,
            in_folder: rows.len(),
            effective,
            missing,
            min_required: MIN_BRAND_IMAGES,
        })
    }

    /// 提炼并落库为新 draft 版本（每次调用创建新版本，不覆盖旧行；§8.5）。
    pub fn extract_visual_profile(
        &self,
        project_id: &str,
        folder_id: &str,
    ) -> AppResult<VisualProfileDetail> {
        let mut conn = self.conn.lock().unwrap();
        let folder_name = assert_source_folder(&conn, project_id, folder_id)?;
        let rows = load_folder_assets(&conn, folder_id)?;
        let cards: Vec<VisualEvidenceCard> = rows
            .iter()
            .filter_map(|row| {
                row.caption_id
                    .as_deref()
                    .zip(row.caption_payload.as_deref())
                    .map(|(caption_id, payload)| {
                        to_evidence_card(&row.asset_id, caption_id, payload, &row.source)
                    })
            })
            .collect();
        let outcome = extract_draft(project_id, folder_id, &cards);
        let (draft, effective_count) = match outcome {
            ExtractOutcome::Draft {
                draft,
                effective_count,
            } => (draft, effective_count),
            ExtractOutcome::Insufficient {
                effective_count,
                min_required,
            } => {
                return Err(AppError::Other(format!(
                    "有效反推素材不足（{effective_count}/{min_required}）。请先在该文件夹整理并反推素材；不会自动补反推，也不会上传图片。"
                )));
            }
        };
        assert_payload_clean(&cards, &rows)?;
        let effective_count = effective_count as i64;
        let cards_json = serde_json::to_string(&cards).unwrap_or_else(|_| "[]".into());
        let profile_id = Self::insert_draft_row(
            &mut conn,
            project_id,
            folder_id,
            &folder_name,
            &draft,
            &cards_json,
            effective_count,
            "local_baseline",
        )?;
        Ok(Self::visual_profile_detail(&conn, &profile_id)?)
    }

    /// 共享落库：新 draft 版本（不覆盖旧行）。extractor 标记来源（V2）。
    fn insert_draft_row(
        conn: &mut Connection,
        _project_id: &str,
        folder_id: &str,
        folder_name: &str,
        draft: &VisualProfileDraft,
        cards_json: &str,
        source_count: i64,
        extractor: &str,
    ) -> AppResult<String> {
        let tx = conn.transaction()?;
        let profile_id = Ulid::new().to_string();
        let next_version: i64 = tx.query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM project_visual_profiles
              WHERE source_folder_id = ?1",
            rusqlite::params![folder_id],
            |row| row.get(0),
        )?;
        tx.execute(
            r#"INSERT INTO project_visual_profiles
                 (id, project_id, source_folder_id, name, version, status, summary,
                  source_scope_hash, source_count, source_payload, extractor,
                  content_themes, conflicts, candidate_directions, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                       CAST(strftime('%s','now') AS INTEGER))"#,
            rusqlite::params![
                profile_id,
                Option::<String>::None,
                folder_id,
                folder_name,
                next_version,
                draft.summary,
                draft.source_scope_hash,
                source_count,
                cards_json,
                extractor,
                serde_json::to_string(&draft.content_themes).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&draft.conflicts).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&draft.candidate_directions).unwrap_or_else(|_| "[]".into()),
            ],
        )?;
        for rule in &draft.visual_rules {
            tx.execute(
                r#"INSERT INTO visual_profile_rules
                     (id, profile_id, category, value, polarity, confidence,
                      supporting_asset_ids, opposing_asset_ids, confirmed_by_user)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
                rusqlite::params![
                    rule.id,
                    profile_id,
                    rule.category,
                    rule.value,
                    rule.polarity,
                    rule.confidence,
                    serde_json::to_string(&rule.supporting_asset_ids)
                        .unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&rule.opposing_asset_ids).unwrap_or_else(|_| "[]".into()),
                    rule.confirmed_by_user as i64,
                ],
            )?;
        }
        let mut source_ids: Vec<String> = draft_asset_ids(cards_json);
        source_ids.sort();
        source_ids.dedup();
        for asset_id in &source_ids {
            tx.execute(
                "INSERT OR IGNORE INTO visual_profile_assets (profile_id, asset_id, role)
                 VALUES (?1, ?2, 'source')",
                rusqlite::params![profile_id, asset_id],
            )?;
        }
        tx.commit()?;
        Ok(profile_id)
    }

    /// V2 云端提炼第 1 步：冻结证据卡快照（与本地提取同一套校验/脱敏断言），
    /// 供命令层提交云端后原样用于落库——中途移动素材不影响本次提炼。
    pub fn visual_profile_freeze_cards(
        &self,
        project_id: &str,
        folder_id: &str,
    ) -> AppResult<(String, Vec<VisualEvidenceCard>)> {
        self.visual_profile_freeze_brand_cards(project_id, folder_id, None)
    }

    pub fn visual_profile_freeze_brand_cards(
        &self,
        project_id: &str,
        folder_id: &str,
        expected_asset_ids: Option<&[String]>,
    ) -> AppResult<(String, Vec<VisualEvidenceCard>)> {
        let conn = self.conn.lock().unwrap();
        let folder_name = assert_source_folder(&conn, project_id, folder_id)?;
        let rows = load_folder_assets(&conn, folder_id)?;
        if let Some(expected) = expected_asset_ids {
            let expected: std::collections::BTreeSet<_> = expected.iter().map(String::as_str).collect();
            let actual: std::collections::BTreeSet<_> = rows.iter().map(|row| row.asset_id.as_str()).collect();
            if expected != actual {
                return Err(AppError::Other("品牌图片已发生变化，请重新查看后再总结".into()));
            }
        }
        if expected_asset_ids.is_some() && rows.iter().any(|row| {
            row.caption_payload.as_deref()
                .and_then(|payload| serde_json::from_str::<CaptionPayload>(payload).ok())
                .and_then(|parsed| parsed.instruction).as_deref() != Some(BRAND_OBSERVATION_TASK)
        }) {
            return Err(AppError::Other("需要补齐可保留品牌标注的图片分析，请重新开始提炼".into()));
        }
        let cards: Vec<VisualEvidenceCard> = rows
            .iter()
            .filter_map(|row| {
                row.caption_id
                    .as_deref()
                    .zip(row.caption_payload.as_deref())
                    .map(|(caption_id, payload)| {
                        to_evidence_card(&row.asset_id, caption_id, payload, &row.source)
                    })
            })
            .collect();
        let effective = cards.iter().filter(|c| card_is_effective(c)).count();
        if expected_asset_ids.is_some() && effective != rows.len() {
            return Err(AppError::Other("还有图片尚未分析完成，请稍后重试".into()));
        }
        if effective < MIN_BRAND_IMAGES {
            return Err(AppError::Other(format!(
                "还没有可用的品牌图片（{effective}/{MIN_BRAND_IMAGES}），请添加图片后再试。"
            )));
        }
        assert_payload_clean(&cards, &rows)?;
        Ok((folder_name, cards))
    }

    /// V2 云端提炼第 3 步：校验云端 draft（闭集类别/极性/素材 provenance 白名单），
    /// 附加本地 scope hash 后按 cloud_model 来源落为新 draft 版本。
    pub fn persist_cloud_visual_profile(
        &self,
        project_id: &str,
        folder_id: &str,
        cards: &[VisualEvidenceCard],
        cloud_draft_json: &str,
    ) -> AppResult<VisualProfileDetail> {
        let mut conn = self.conn.lock().unwrap();
        let folder_name = assert_source_folder(&conn, project_id, folder_id)?;
        let draft = parse_cloud_draft(cloud_draft_json, cards, project_id, folder_id, false)?;
        let effective_count = cards.iter().filter(|c| card_is_effective(c)).count() as i64;
        let cards_json = serde_json::to_string(cards).unwrap_or_else(|_| "[]".into());
        let profile_id = Self::insert_draft_row(
            &mut conn,
            project_id,
            folder_id,
            &folder_name,
            &draft,
            &cards_json,
            effective_count,
            "cloud_model",
        )?;
        Ok(Self::visual_profile_detail(&conn, &profile_id)?)
    }

    /// V2-T3 草稿编辑：整组替换 draft 的规则（仅 draft 状态可改；confirmed 只读）。
    pub fn update_visual_profile_rules(
        &self,
        profile_id: &str,
        rules: &[RuleEdit],
    ) -> AppResult<VisualProfileDetail> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let status: Option<String> = tx
            .query_row(
                "SELECT status FROM project_visual_profiles WHERE id = ?1",
                rusqlite::params![profile_id],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        match status.as_deref() {
            Some("draft") => {}
            Some(_) => return Err(AppError::Other("只有草稿可以编辑规则".into())),
            None => return Err(AppError::Other("视觉设定不存在".into())),
        }
        if rules.len() > 64 {
            return Err(AppError::Other("规则数量超出上限（64）".into()));
        }
        for rule in rules {
            validate_rule_shape(&rule.category, &rule.value, &rule.polarity)?;
        }
        tx.execute(
            "DELETE FROM visual_profile_rules WHERE profile_id = ?1",
            rusqlite::params![profile_id],
        )?;
        for rule in rules {
            tx.execute(
                r#"INSERT INTO visual_profile_rules
                     (id, profile_id, category, value, polarity, confidence,
                      supporting_asset_ids, opposing_asset_ids, confirmed_by_user)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
                rusqlite::params![
                    Ulid::new().to_string(),
                    profile_id,
                    rule.category,
                    rule.value,
                    rule.polarity,
                    rule.confidence,
                    serde_json::to_string(&rule.supporting_asset_ids)
                        .unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&rule.opposing_asset_ids).unwrap_or_else(|_| "[]".into()),
                    rule.confirmed_by_user as i64,
                ],
            )?;
        }
        let detail = Self::visual_profile_detail(&tx, profile_id)?;
        tx.commit()?;
        Ok(detail)
    }

    /// 单个 profile 的完整读取（V3 验证图编译 prompt 用；桌面命令层入口）。
    pub fn visual_profile_get(&self, profile_id: &str) -> AppResult<VisualProfileDetail> {
        let conn = self.conn.lock().unwrap();
        Self::visual_profile_detail(&conn, profile_id)
    }

    /// 按用户选中的不可变 confirmed 版本编译冻结 capsule，可用于任何创作。
    pub fn visual_profile_capsule(
        &self,
        profile_id: &str,
    ) -> AppResult<VisualProfileCapsule> {
        let conn = self.conn.lock().unwrap();
        let detail = Self::visual_profile_detail(&conn, profile_id)?;
        compile_capsule(&detail)
    }

    /// V3-T4：把已入库的验证图关联到 profile（role=validation；幂等）。
    pub fn link_validation_asset(&self, profile_id: &str, asset_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM project_visual_profiles WHERE id = ?1",
                rusqlite::params![profile_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|n| n > 0)?;
        if !exists {
            return Err(AppError::Other("视觉设定不存在".into()));
        }
        conn.execute(
            "INSERT OR IGNORE INTO visual_profile_assets (profile_id, asset_id, role)
             VALUES (?1, ?2, 'validation')",
            rusqlite::params![profile_id, asset_id],
        )?;
        Ok(())
    }

    /// 用户「确认并保存」：draft → confirmed（幂等拒绝二次确认以外的状态）。
    pub fn confirm_visual_profile(&self, profile_id: &str) -> AppResult<VisualProfileDetail> {
        let conn = self.conn.lock().unwrap();
        let detail = Self::visual_profile_detail(&conn, profile_id)?;
        if detail.rules.iter().any(|rule| rule.value.starts_with("待核对的原图标注：")) {
            return Err(AppError::Other("品牌标注存在冲突，请核对并微调后保存".into()));
        }
        let updated = conn.execute(
            "UPDATE project_visual_profiles
                SET status = 'confirmed', confirmed_at = CAST(strftime('%s','now') AS INTEGER)
              WHERE id = ?1 AND status = 'draft'",
            rusqlite::params![profile_id],
        )?;
        if updated == 0 {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM project_visual_profiles WHERE id = ?1",
                    rusqlite::params![profile_id],
                    |row| row.get::<_, i64>(0),
                )
                .map(|n| n > 0)?;
            return Err(AppError::Other(if exists {
                "该视觉设定已确认或已归档".into()
            } else {
                "视觉设定不存在".into()
            }));
        }
        Self::visual_profile_detail(&conn, profile_id)
    }

    /// Remove a version from user-facing lists without destroying frozen generation provenance.
    pub fn delete_visual_profile(&self, profile_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE project_visual_profiles SET status = 'archived' WHERE id = ?1",
            rusqlite::params![profile_id],
        )?;
        if updated == 0 { return Err(AppError::Other("视觉规范不存在".into())); }
        Ok(())
    }

    pub fn list_visual_profiles(
        &self,
        _project_id: &str,
        folder_id: Option<&str>,
    ) -> AppResult<Vec<VisualProfileSummary>> {
        let conn = self.conn.lock().unwrap();
        let sql = r#"
            SELECT p.id, p.project_id, p.source_folder_id, p.name, p.version, p.status,
                   p.summary, p.source_count, p.created_at, p.confirmed_at,
                   (SELECT COUNT(*) FROM visual_profile_rules r WHERE r.profile_id = p.id), p.extractor
            FROM project_visual_profiles p
            WHERE p.status != 'archived' AND (?1 IS NULL OR p.source_folder_id = ?1)
            ORDER BY p.source_folder_id, p.version DESC, p.created_at DESC, p.id DESC
        "#;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params![folder_id], |row| {
            Ok(VisualProfileSummary {
                id: row.get(0)?,
                project_id: row.get(1)?,
                folder_id: row.get(2)?,
                name: row.get(3)?,
                version: row.get(4)?,
                status: row.get(5)?,
                summary: row.get(6)?,
                source_count: row.get(7)?,
                rule_count: row.get(10)?,
                created_at: row.get(8)?,
                confirmed_at: row.get(9)?,
                extractor: row.get(11)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    fn visual_profile_detail(
        conn: &Connection,
        profile_id: &str,
    ) -> AppResult<VisualProfileDetail> {
        let summary = conn
            .query_row(
                r#"SELECT p.id, p.project_id, p.source_folder_id, p.name, p.version, p.status,
                          p.summary, p.source_count, p.created_at, p.confirmed_at,
                          (SELECT COUNT(*) FROM visual_profile_rules r WHERE r.profile_id = p.id),
                          p.source_scope_hash, p.extractor
                   FROM project_visual_profiles p WHERE p.id = ?1"#,
                rusqlite::params![profile_id],
                |row| {
                    Ok((
                        VisualProfileSummary {
                            id: row.get(0)?,
                            project_id: row.get(1)?,
                            folder_id: row.get(2)?,
                            name: row.get(3)?,
                            version: row.get(4)?,
                            status: row.get(5)?,
                            summary: row.get(6)?,
                            source_count: row.get(7)?,
                            rule_count: row.get(10)?,
                            created_at: row.get(8)?,
                            confirmed_at: row.get(9)?,
                            extractor: row.get(12)?,
                        },
                        row.get::<_, String>(11)?,
                    ))
                },
            )
            .map_err(|_| AppError::Other("视觉设定不存在".into()))?;
        let (summary, scope_hash) = summary;

        let mut stmt = conn.prepare(
            "SELECT category, value, polarity, confidence, supporting_asset_ids, opposing_asset_ids,
                    confirmed_by_user
               FROM visual_profile_rules WHERE profile_id = ?1
               ORDER BY confidence DESC, category, value",
        )?;
        let rules: Vec<DraftRule> = stmt
            .query_map(rusqlite::params![profile_id], |row| {
                Ok(DraftRule {
                    id: String::new(),
                    category: row.get(0)?,
                    value: row.get(1)?,
                    polarity: row.get(2)?,
                    confidence: row.get(3)?,
                    supporting_asset_ids: serde_json::from_str(&row.get::<_, String>(4)?)
                        .unwrap_or_default(),
                    opposing_asset_ids: serde_json::from_str(&row.get::<_, String>(5)?)
                        .unwrap_or_default(),
                    confirmed_by_user: row.get::<_, i64>(6)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let parse_json_column = |sql: &str| -> AppResult<String> {
            Ok(conn.query_row(sql, rusqlite::params![profile_id], |row| row.get(0))?)
        };
        let content_themes: Vec<ContentTheme> = serde_json::from_str(&parse_json_column(
            "SELECT content_themes FROM project_visual_profiles WHERE id = ?1",
        )?)
        .unwrap_or_default();
        let conflicts: Vec<EvidenceConflict> = serde_json::from_str(&parse_json_column(
            "SELECT conflicts FROM project_visual_profiles WHERE id = ?1",
        )?)
        .unwrap_or_default();
        let candidate_directions: Vec<CandidateDirection> =
            serde_json::from_str(&parse_json_column(
                "SELECT candidate_directions FROM project_visual_profiles WHERE id = ?1",
            )?)
            .unwrap_or_default();
        Ok(VisualProfileDetail {
            summary,
            source_scope_hash: scope_hash,
            source_asset_ids: draft_asset_ids(&parse_json_column(
                "SELECT source_payload FROM project_visual_profiles WHERE id = ?1",
            )?),
            source_requirements: serde_json::from_str::<serde_json::Value>(&parse_json_column(
                "SELECT source_payload FROM project_visual_profiles WHERE id = ?1",
            )?).ok().and_then(|v| v.get("requirements").and_then(|s| s.as_str()).map(str::to_owned)),
            rules,
            content_themes,
            conflicts,
            candidate_directions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use rusqlite::params;

    fn card(asset: &str, dims: &[(&str, &str)], sections: &[(&str, &str)]) -> VisualEvidenceCard {
        let mut dimensions = BTreeMap::new();
        for (key, value) in dims {
            dimensions.insert(key.to_string(), value.to_string());
        }
        VisualEvidenceCard {
            asset_id: asset.into(),
            caption_id: format!("cap-{asset}"),
            caption_hash: format!("hash-{asset}"),
            sections: sections
                .iter()
                .map(|(title, body)| EvidenceSection {
                    title: title.to_string(),
                    body: body.to_string(),
                })
                .collect(),
            dimensions,
            text_fallback: None,
            parse_status: "structured".into(),
            source_class: "imported".into(),
        }
    }

    fn caption_json(dims: &[(&str, &str)], sections: &[(&str, &str)]) -> String {
        let dimensions: BTreeMap<String, String> = dims
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        serde_json::json!({
            "schema_version": 1,
            "instruction": BRAND_OBSERVATION_TASK,
            "text": "fallback text",
            "sections": sections
                .iter()
                .map(|(t, b)| serde_json::json!({"title": t, "body": b}))
                .collect::<Vec<_>>(),
            "dimensions": dimensions,
            "parse_status": "structured",
        })
        .to_string()
    }

    #[test]
    fn normalize_handles_structured_legacy_and_broken_payloads() {
        let structured = to_evidence_card(
            "a1",
            "c1",
            &caption_json(&[("palette", "低饱和暖调")], &[("材质", "哑光")]),
            "imported",
        );
        assert_eq!(structured.parse_status, "structured");
        assert_eq!(
            structured.dimensions.get("palette").map(String::as_str),
            Some("低饱和暖调")
        );
        assert_eq!(structured.sections.len(), 1);
        assert_eq!(structured.source_class, "imported");

        let legacy = to_evidence_card("a2", "c2", r#"{"text":"只有整段文本"}"#, "codex");
        assert_eq!(legacy.sections.len(), 0);
        assert_eq!(legacy.dimensions.len(), 0);
        assert_eq!(legacy.parse_status, "raw_fallback");
        assert_eq!(legacy.source_class, "generated_confirmed");

        let broken = to_evidence_card("a3", "c3", "not-json", "imported");
        assert_eq!(broken.parse_status, "raw_fallback");

        // 内容 hash 确定性：同输入同 hash，不同输入不同 hash
        let h1 = caption_hash(&structured.sections, &structured.dimensions, None);
        let h2 = caption_hash(&structured.sections, &structured.dimensions, None);
        assert_eq!(h1, h2);
        let h3 = caption_hash(&structured.sections, &BTreeMap::new(), None);
        assert_ne!(h1, h3);
    }

    #[test]
    fn scope_hash_is_order_independent_and_input_sensitive() {
        let mut cards = vec![
            card("a1", &[("palette", "暖调")], &[]),
            card("a2", &[("palette", "暖调")], &[]),
        ];
        let hash1 = source_scope_hash("p", "f", &cards);
        cards.reverse();
        assert_eq!(hash1, source_scope_hash("p", "f", &cards));
        cards[0].caption_hash = "changed".into();
        assert_ne!(hash1, source_scope_hash("p", "f", &cards));
        assert_ne!(hash1, source_scope_hash("p2", "f", &cards));
    }

    #[test]
    fn extract_requires_minimum_effective_cards() {
        let cards: Vec<_> = (0..4)
            .map(|i| card(&format!("a{i}"), &[("palette", "暖调")], &[]))
            .collect();
        assert_eq!(
            extract_draft("p", "f", &cards),
            ExtractOutcome::Insufficient {
                effective_count: 4,
                min_required: 5
            }
        );
    }

    #[test]
    fn extract_produces_prefer_rule_for_dominant_value() {
        let cards: Vec<_> = (0..6)
            .map(|i| {
                card(
                    &format!("a{i}"),
                    &[("palette", "低饱和暖调"), ("mood", "宁静")],
                    &[("主体", "茶具"), ("材质", "哑光陶瓷")],
                )
            })
            .collect();
        let ExtractOutcome::Draft {
            draft,
            effective_count,
        } = extract_draft("p", "f", &cards)
        else {
            panic!("expected draft");
        };
        assert_eq!(effective_count, 6);
        let find = |category: &str| draft.visual_rules.iter().find(|r| r.category == category);
        let palette = find("palette").expect("palette rule");
        assert_eq!(palette.value, "低饱和暖调");
        assert_eq!(palette.polarity, "prefer");
        assert_eq!(palette.supporting_asset_ids.len(), 6);
        let material = find("material").expect("material rule from section");
        assert_eq!(material.value, "哑光陶瓷");
        // 内容主题只进 contentThemes，绝不进视觉规则
        assert!(!draft.visual_rules.iter().any(|r| r.value.contains("茶具")));
        assert!(draft.content_themes.iter().any(|t| t.value == "茶具"));
        // 全部素材同一方向：无候选方向
        assert!(draft.candidate_directions.is_empty());
    }

    #[test]
    fn extract_reports_conflict_without_rule_when_split() {
        let mut cards = Vec::new();
        for i in 0..5 {
            cards.push(card(&format!("a{i}"), &[("palette", "暗调")], &[]));
        }
        for i in 5..9 {
            cards.push(card(&format!("a{i}"), &[("palette", "亮调")], &[]));
        }
        let ExtractOutcome::Draft { draft, .. } = extract_draft("p", "f", &cards) else {
            panic!("expected draft");
        };
        assert!(draft.visual_rules.iter().all(|r| r.category != "palette"));
        assert_eq!(draft.conflicts.len(), 1);
        assert!(draft.conflicts[0].description.contains("palette"));
        // 两簇都 ≥20% → 两个候选方向，不强行平均
        assert_eq!(draft.candidate_directions.len(), 2);
    }

    fn seeded_db() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, workspace_path, workspace_key, kind, created_at) VALUES ('p1', '测试项目', 'C:\\ws', 'ws-key', 'user', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, name, kind, created_at) VALUES ('f1', '风格参考', 'folder', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folders (id, name, kind, created_at) VALUES ('col1', '收藏夹', 'collection', 1)",
            [],
        )
        .unwrap();
        for i in 0..6 {
            conn.execute(
                "INSERT INTO assets (id, name, folder_id, source, created_at) VALUES (?1, ?2, 'f1', 'imported', 1)",
                params![format!("asset-{i}"), format!("本机文件名{i}.png")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO project_assets (project_id, asset_id, created_at) VALUES ('p1', ?1, 1)",
                params![format!("asset-{i}")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO analyses (id, asset_id, kind, payload, provider, created_at) VALUES (?1, ?2, 'caption', ?3, 'test', ?4)",
                params![
                    format!("cap-{i}"),
                    format!("asset-{i}"),
                    caption_json(&[("palette", "低饱和暖调"), ("mood", "宁静")], &[("主体", "茶具"), ("材质", "哑光陶瓷")]),
                    i as i64
                ],
            )
            .unwrap();
        }
        // 来源按所选文件夹读取；包含尚未加入项目的素材。
        conn.execute(
            "INSERT INTO assets (id, name, folder_id, source, created_at) VALUES ('asset-out', '外部素材.png', 'f1', 'imported', 1)",
            [],
        )
        .unwrap();
        for asset_id in ["asset-none", "asset-raw"] {
            conn.execute(
                "INSERT INTO assets (id, name, folder_id, source, created_at) VALUES (?1, '无反推素材.png', 'f1', 'imported', 1)",
                params![asset_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO project_assets (project_id, asset_id, created_at) VALUES ('p1', ?1, 1)",
                params![asset_id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO analyses (id, asset_id, kind, payload, provider, created_at) VALUES ('cap-raw', 'asset-raw', 'caption', '{\"text\":\"整段\"}', 'test', 1)",
            [],
        )
        .unwrap();
        drop(conn);
        db
    }

    #[test]
    fn workflow_visual_profile_accepts_explicit_sources_and_freezes_text() {
        let db = seeded_db();
        let ids = vec!["asset-0".to_string()];
        let (cards, missing) = db.visual_profile_input_cards(&ids, true).unwrap();
        assert!(missing.is_empty());
        assert_eq!(cards.len(), 1);
        assert!(db.visual_profile_input_cards(&["missing".into()], true).is_err());
        assert!(db.visual_profile_input_cards(&["asset-none".into()], true).is_err());
        let raw = serde_json::json!({"schemaVersion":1,"summary":"蓝色留白","visualRules":[{"category":"palette","value":"使用蓝色","polarity":"must","supportingAssetIds":[]}]}).to_string();
        let first = db.persist_workflow_visual_profile("p:node", "画板规范", &cards, "使用蓝色", &raw).unwrap();
        assert_eq!(first.source_asset_ids, ids);
        assert_eq!(first.source_requirements.as_deref(), Some("使用蓝色"));
        assert!(db.visual_profile_capsule(&first.summary.id).is_err());
        db.confirm_visual_profile(&first.summary.id).unwrap();
        assert_eq!(db.visual_profile_capsule(&first.summary.id).unwrap().must[0].value, "使用蓝色");
        let second = db.persist_workflow_visual_profile("p:node", "画板规范", &[], "蓝色且留白", &raw).unwrap();
        assert_eq!(second.summary.version, 2);
        assert!(second.source_asset_ids.is_empty());
        assert_ne!(first.source_scope_hash, second.source_scope_hash);
        assert!(db.update_visual_profile_rules(&first.summary.id, &[]).is_err());
    }

    #[test]
    fn independent_visual_profile_migration_preserves_versions_rules_and_links() {
        let db = Database::open_in_memory().unwrap();
        {
            let mut conn = db.conn.lock().unwrap();
            crate::db::migrations::migrations().to_version(&mut conn, 26).unwrap();
            conn.execute_batch(r#"
                INSERT INTO projects(id,name,workspace_path,workspace_key,kind,created_at)
                  VALUES ('old-a','A','a','a','user',1), ('old-b','B','b','b','user',1);
                INSERT INTO folders(id,name,kind,created_at) VALUES ('brand','Brand','folder',1);
                INSERT INTO assets(id,name,source,created_at) VALUES ('photo','Photo','imported',1);
                INSERT INTO project_visual_profiles(id,project_id,source_folder_id,name,version,status,source_scope_hash,source_payload,created_at)
                  VALUES ('guide-a','old-a','brand','A',1,'confirmed','frozen-a','[]',1),
                         ('guide-b','old-b','brand','B',1,'confirmed','frozen-b','[]',2);
                INSERT INTO visual_profile_rules(id,profile_id,category,value,polarity)
                  VALUES ('rule-a','guide-a','palette','自然暖色','prefer');
                INSERT INTO visual_profile_assets(profile_id,asset_id,role) VALUES ('guide-a','photo','source');
            "#).unwrap();
        }
        let before = db.visual_profile_capsule("guide-a").unwrap();
        db.migrate().unwrap();
        db.migrate().unwrap();
        assert_eq!(db.list_visual_profiles("", None).unwrap().len(), 2);
        assert_eq!(db.visual_profile_capsule("guide-a").unwrap().hash, before.hash);
        {
            let conn = db.conn.lock().unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM visual_profile_assets", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
            conn.execute("DELETE FROM projects WHERE id IN ('old-a','old-b')", []).unwrap();
            conn.execute("DELETE FROM folders WHERE id='brand'", []).unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            assert_eq!(conn.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        }
        assert_eq!(db.visual_profile_capsule("guide-a").unwrap().hash, before.hash);
        assert_eq!(db.visual_profile_get("guide-b").unwrap().summary.version, 1);
        assert_eq!(db.list_visual_profiles("unrelated-project", None).unwrap().len(), 2);
    }

    #[test]
    fn brand_profiles_can_be_created_without_project_and_used_after_project_deletion() {
        let db = seeded_db();
        let first = db.extract_visual_profile("", "f1").unwrap();
        assert!(first.summary.project_id.is_none());
        db.confirm_visual_profile(&first.summary.id).unwrap();
        let capsule = db.visual_profile_capsule(&first.summary.id).unwrap();
        db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p1'", []).unwrap();
        assert_eq!(db.visual_profile_capsule(&first.summary.id).unwrap().hash, capsule.hash);
        assert_eq!(db.visual_profile_preview("", "f1").unwrap().in_folder, 9);
        let next = db.extract_visual_profile("unrelated-project", "f1").unwrap();
        assert_eq!(next.summary.version, first.summary.version + 1);
        assert_eq!(db.list_visual_profiles("", Some("f1")).unwrap().len(), 2);
        assert!(db.visual_profile_capsule(&next.summary.id).is_err(), "drafts still require confirmation");
    }

    #[test]
    fn draft_edit_rolls_back_all_rules_when_an_insert_fails() {
        let db = seeded_db();
        let original = db.extract_visual_profile("p1", "f1").unwrap();
        db.conn.lock().unwrap().execute_batch(
            "CREATE TEMP TRIGGER fail_rule_insert BEFORE INSERT ON visual_profile_rules
             WHEN NEW.value = '模拟写入失败' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
        ).unwrap();
        let edits = ["第一条应回滚", "模拟写入失败"].map(|value| RuleEdit {
            category: "palette".into(), value: value.into(), polarity: "prefer".into(),
            confidence: 0.8, supporting_asset_ids: vec![], opposing_asset_ids: vec![],
            confirmed_by_user: true,
        });
        assert!(db.update_visual_profile_rules(&original.summary.id, &edits).is_err());
        let after = db.visual_profile_get(&original.summary.id).unwrap();
        assert_eq!(serde_json::to_value(&after.rules).unwrap(), serde_json::to_value(&original.rules).unwrap());
        assert_eq!(after.summary.status, "draft");
        db.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_rule_insert").unwrap();
        let saved = db.update_visual_profile_rules(&original.summary.id, &edits[..1]).unwrap();
        assert_eq!(saved.rules.len(), 1);
        assert_eq!(saved.rules[0].value, "第一条应回滚");
    }

    #[test]
    fn profile_reads_preserve_extractor_identity() {
        let db = seeded_db();
        let original = db.extract_visual_profile("p1", "f1").unwrap();
        assert_eq!(original.summary.extractor, "local_baseline");
        db.conn.lock().unwrap().execute(
            "UPDATE project_visual_profiles SET extractor = 'cloud_model' WHERE id = ?1",
            params![original.summary.id],
        ).unwrap();
        let detail = db.visual_profile_get(&original.summary.id).unwrap();
        let list = db.list_visual_profiles("p1", Some("f1")).unwrap();
        assert_eq!(detail.summary.extractor, "cloud_model");
        assert_eq!(list[0].extractor, "cloud_model");
        assert_eq!(serde_json::to_value(&detail).unwrap()["extractor"], "cloud_model");
    }

    #[test]
    fn preview_counts_selected_folder_with_reasons() {
        let db = seeded_db();
        let preview = db.visual_profile_preview("p1", "f1").unwrap();
        assert_eq!(preview.folder_name, "风格参考");
        assert_eq!(preview.in_folder, 9); // 6 有效 + asset-none + asset-raw + asset-out
        assert_eq!(preview.effective, 6);
        let no_caption = preview
            .missing
            .iter()
            .find(|m| m.asset_id == "asset-none")
            .unwrap();
        assert_eq!(no_caption.reason, "no_caption");
        let raw = preview
            .missing
            .iter()
            .find(|m| m.asset_id == "asset-raw")
            .unwrap();
        assert_eq!(raw.reason, "brand_observation_required");

        // root / 收藏夹 / 不存在文件夹 均拒绝
        assert!(db.visual_profile_preview("p1", "root").is_err());
        assert!(db.visual_profile_preview("p1", "col1").is_err());
        assert!(db.visual_profile_preview("p1", "missing").is_err());
        assert!(db.visual_profile_preview("missing", "f1").is_ok());
    }

    #[test]
    fn folder_captions_are_usable_without_project_membership() {
        let db = seeded_db();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("DELETE FROM project_assets WHERE project_id = 'p1'", []).unwrap();
            conn.execute("INSERT INTO assets (id,name,folder_id,source,created_at) VALUES ('elsewhere','其他夹',NULL,'imported',1)", []).unwrap();
            conn.execute("INSERT INTO analyses (id,asset_id,kind,payload,provider,created_at) VALUES ('elsewhere-caption','elsewhere','caption',?1,'test',1)",
                params![caption_json(&[("palette", "不应读入")], &[])]).unwrap();
        }
        let preview = db.visual_profile_preview("p1", "f1").unwrap();
        assert_eq!(preview.in_folder, 9);
        assert_eq!(preview.effective, 6);
        let (_, cards) = db.visual_profile_freeze_cards("p1", "f1").unwrap();
        assert_eq!(cards.iter().filter(|card| card_is_effective(card)).count(), 6);
        assert!(!cards.iter().any(|card| card.asset_id == "elsewhere"));
        let detail = db.extract_visual_profile("p1", "f1").unwrap();
        assert_eq!(detail.summary.source_count, 6);
        let conn = db.conn.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p1'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn extract_creates_versioned_drafts_and_confirm_upgrades() {
        let db = seeded_db();
        let detail = db.extract_visual_profile("p1", "f1").unwrap();
        assert_eq!(detail.summary.version, 1);
        assert_eq!(detail.summary.status, "draft");
        assert_eq!(detail.summary.source_count, 6);
        assert!(!detail.rules.is_empty());
        assert!(!detail.source_scope_hash.is_empty());
        let scope_v1 = detail.source_scope_hash.clone();

        // 再次提炼 → 新 draft v2，旧 v1 不被覆盖
        let detail2 = db.extract_visual_profile("p1", "f1").unwrap();
        assert_eq!(detail2.summary.version, 2);
        assert_eq!(detail2.source_scope_hash, scope_v1);

        // 确认 v2；v1 仍为 draft（可独立确认）
        let confirmed = db.confirm_visual_profile(&detail2.summary.id).unwrap();
        assert_eq!(confirmed.summary.status, "confirmed");
        assert!(confirmed.summary.confirmed_at.is_some());
        assert!(
            db.confirm_visual_profile(&detail2.summary.id).is_err(),
            "重复确认被拒绝"
        );

        let list = db.list_visual_profiles("p1", Some("f1")).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].version, 2);
        assert_eq!(list[0].status, "confirmed");

        // 库变化后旧行不动：移动素材/加反推不影响已落盘 draft（验收：不自动触发/不随文件夹变化）
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE assets SET folder_id = NULL WHERE id = 'asset-0'",
                [],
            )
            .unwrap();
        }
        let detail_again = db.list_visual_profiles("p1", None).unwrap();
        assert_eq!(detail_again[0].source_count, 6);
        let preview = db.visual_profile_preview("p1", "f1").unwrap();
        assert_eq!(preview.effective, 5);
        let detail3 = db.extract_visual_profile("p1", "f1").unwrap();
        assert_eq!(detail3.summary.version, 3);
        assert_eq!(detail3.summary.source_count, 5);
        assert_ne!(detail3.source_scope_hash, scope_v1);
    }

    #[test]
    fn deleted_versions_leave_lists_but_preserve_sources_and_version_numbers() {
        let db = seeded_db();
        let first = db.extract_visual_profile("p1", "f1").unwrap();
        let second = db.extract_visual_profile("p1", "f1").unwrap();
        let id = &second.summary.id;
        db.confirm_visual_profile(id).unwrap();
        let capsule = db.visual_profile_capsule(id).unwrap();
        db.delete_visual_profile(id).unwrap();
        db.delete_visual_profile(id).unwrap(); // Retrying a completed deletion is safe.
        assert!(db.delete_visual_profile("missing").is_err());
        let list = db.list_visual_profiles("p1", None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, first.summary.id);
        assert_eq!(db.list_visual_profiles("p1", Some("f1")).unwrap().len(), 1);
        let archived = db.visual_profile_get(id).unwrap();
        assert_eq!(archived.summary.status, "archived");
        assert_eq!(archived.rules.len(), second.rules.len());
        assert_eq!(archived.source_asset_ids, second.source_asset_ids);
        assert!(db.visual_profile_capsule(id).is_err());
        assert!(db.confirm_visual_profile(id).is_err());
        assert!(!inject_visual_profile_prompt("新画面", &capsule).is_empty());
        assert_eq!(db.visual_profile_preview("p1", "f1").unwrap().effective, 6);
        assert_eq!(db.extract_visual_profile("p1", "f1").unwrap().summary.version, 3);
    }

    #[test]
    fn saved_sources_survive_collection_changes_and_asset_removal() {
        let db = seeded_db();
        let profile = db.extract_visual_profile("p1", "f1").unwrap();
        // The frozen input also includes the legacy caption with no usable style claims.
        assert_eq!(profile.source_asset_ids.len(), 7);
        assert!(profile.source_asset_ids.contains(&"asset-0".to_string()));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE assets SET folder_id = NULL WHERE id = 'asset-0'", []).unwrap();
            conn.execute("DELETE FROM assets WHERE id = 'asset-1'", []).unwrap();
        }
        let saved = db.visual_profile_get(&profile.summary.id).unwrap();
        assert_eq!(saved.source_asset_ids, profile.source_asset_ids);
        assert_eq!(saved.summary.source_count, 6);
        assert_eq!(db.visual_profile_preview("p1", "f1").unwrap().effective, 4);
    }

    #[test]
    fn extract_guards_insufficient_coverage_in_db_path() {
        let db = seeded_db();
        {
            let conn = db.conn.lock().unwrap();
            for i in 0..4 {
                conn.execute(
                    "DELETE FROM analyses WHERE asset_id = ?1",
                    params![format!("asset-{i}")],
                )
                .unwrap();
            }
        }
        let error = db.extract_visual_profile("p1", "f1").unwrap_err();
        assert!(error.to_string().contains("有效反推素材不足"));
    }

    #[test]
    fn freeze_and_cloud_persist_with_provenance_filtering() {
        let db = seeded_db();
        let (_, cards) = db.visual_profile_freeze_cards("p1", "f1").unwrap();
        // 6 张有效 + 1 张 raw caption 卡（无效但可作 provenance 白名单成员）
        assert_eq!(cards.len(), 7);

        let cloud_draft = serde_json::json!({
            "schemaVersion": 1,
            "summary": "云端模型归纳：整体低饱和暖调。",
            "visualRules": [
                { "category": "palette", "value": "低饱和暖调", "polarity": "prefer", "confidence": 0.9,
                  "supportingAssetIds": ["asset-0", "asset-1", "ghost"], "opposingAssetIds": [] },
                { "category": "palette", "value": "幽灵素材规则", "polarity": "prefer", "confidence": 0.5,
                  "supportingAssetIds": ["ghost"], "opposingAssetIds": [] }
            ],
            "contentThemes": [{ "value": "茶具", "supportingAssetIds": ["asset-2"], "coverage": 0.5, "confidence": 0.5 }],
            "conflicts": [],
            "candidateDirections": []
        })
        .to_string();
        let detail = db
            .persist_cloud_visual_profile("p1", "f1", &cards, &cloud_draft)
            .unwrap();
        assert_eq!(detail.summary.version, 1);
        // ghost 素材的规则被 provenance 白名单整条丢弃；好规则的 ghost 引用也被剔除
        assert_eq!(detail.rules.len(), 1);
        assert_eq!(
            detail.rules[0].supporting_asset_ids,
            vec!["asset-0".to_string(), "asset-1".to_string()]
        );
        assert_eq!(detail.content_themes.len(), 1);
        // extractor = cloud_model
        {
            let conn = db.conn.lock().unwrap();
            let extractor: String = conn
                .query_row(
                    "SELECT extractor FROM project_visual_profiles WHERE id = ?1",
                    params![detail.summary.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(extractor, "cloud_model");
        }
        // 本地提取仍是 local_baseline 且版本递增
        let local = db.extract_visual_profile("p1", "f1").unwrap();
        assert_eq!(local.summary.version, 2);
        {
            let conn = db.conn.lock().unwrap();
            let extractor: String = conn
                .query_row(
                    "SELECT extractor FROM project_visual_profiles WHERE id = ?1",
                    params![local.summary.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(extractor, "local_baseline");
        }

        // 闭集外的类别 fail closed
        let bad = serde_json::json!({
            "schemaVersion": 1,
            "visualRules": [{ "category": "vibe", "value": "越权", "polarity": "prefer", "supportingAssetIds": ["asset-0"] }]
        }).to_string();
        assert!(db
            .persist_cloud_visual_profile("p1", "f1", &cards, &bad)
            .is_err());
    }

    #[test]
    fn update_draft_rules_replaces_set_and_guards_confirmed() {
        let db = seeded_db();
        let detail = db.extract_visual_profile("p1", "f1").unwrap();
        let rules = vec![super::RuleEdit {
            category: "palette".into(),
            value: "编辑后的暖调".into(),
            polarity: "must".into(),
            confidence: 0.8,
            supporting_asset_ids: detail.rules[0].supporting_asset_ids.clone(),
            opposing_asset_ids: vec![],
            confirmed_by_user: true,
        }];
        let updated = db
            .update_visual_profile_rules(&detail.summary.id, &rules)
            .unwrap();
        assert_eq!(updated.rules.len(), 1);
        assert_eq!(updated.rules[0].value, "编辑后的暖调");
        assert_eq!(updated.rules[0].polarity, "must");

        // confirmed 后不可再编辑
        db.confirm_visual_profile(&detail.summary.id).unwrap();
        assert!(db
            .update_visual_profile_rules(&detail.summary.id, &rules)
            .is_err());
        // 非法极性 / 空值拒绝
        let bad_polarity = vec![super::RuleEdit {
            category: "palette".into(),
            value: "x".into(),
            polarity: "maybe".into(),
            confidence: 0.0,
            supporting_asset_ids: vec![],
            opposing_asset_ids: vec![],
            confirmed_by_user: false,
        }];
        let draft2 = db.extract_visual_profile("p1", "f1").unwrap();
        assert!(db
            .update_visual_profile_rules(&draft2.summary.id, &bad_polarity)
            .is_err());
    }

    #[test]
    fn confirmed_profile_compiles_frozen_capsule_and_prompt_with_task_priority() {
        let db = seeded_db();
        let detail = db.extract_visual_profile("p1", "f1").unwrap();
        let rules = vec![
            RuleEdit {
                category: "palette".into(),
                value: "低饱和暖调".into(),
                polarity: "must".into(),
                confidence: 0.9,
                supporting_asset_ids: vec!["asset-0".into()],
                opposing_asset_ids: vec![],
                confirmed_by_user: true,
            },
            RuleEdit {
                category: "mood".into(),
                value: "高饱和撞色".into(),
                polarity: "avoid".into(),
                confidence: 0.8,
                supporting_asset_ids: vec!["asset-1".into()],
                opposing_asset_ids: vec![],
                confirmed_by_user: true,
            },
        ];
        db.update_visual_profile_rules(&detail.summary.id, &rules)
            .unwrap();
        db.confirm_visual_profile(&detail.summary.id).unwrap();

        let capsule = db.visual_profile_capsule(&detail.summary.id).unwrap();
        assert_eq!(capsule.profile_id, detail.summary.id);
        assert_eq!(capsule.version, 1);
        assert_eq!(capsule.must.len(), 1);
        assert_eq!(capsule.avoid.len(), 1);
        assert_eq!(capsule.hash.len(), 64);
        assert_eq!(db.visual_profile_capsule(&capsule.profile_id).unwrap().hash, capsule.hash);

        let prompt = inject_visual_profile_prompt("本次明确改成高饱和红色海报", &capsule);
        assert!(prompt.starts_with("本次明确改成高饱和红色海报"));
        assert!(prompt.contains("若与本次明确要求冲突，一律以本次要求为准"));
        assert!(prompt.contains("必须保持：palette=低饱和暖调"));
        assert!(prompt.contains("必须避免：mood=高饱和撞色"));
        assert!(!prompt.contains("茶具"), "内容主题不得注入直接生成 prompt");
    }

    #[test]
    fn brand_scope_rejects_new_unanalyzed_images_before_submission() {
        let db = seeded_db();
        db.conn.lock().unwrap().execute("UPDATE assets SET folder_id = NULL WHERE id != 'asset-0'", []).unwrap();
        let expected = vec!["asset-0".to_string()];
        assert!(db.visual_profile_freeze_brand_cards("p1", "f1", Some(&expected)).is_ok());
        db.conn.lock().unwrap().execute("UPDATE assets SET folder_id = 'f1' WHERE id = 'asset-none'", []).unwrap();
        let error = db.visual_profile_freeze_brand_cards("p1", "f1", Some(&expected)).unwrap_err();
        assert!(error.to_string().contains("图片已发生变化"));
    }

    #[test]
    fn old_captions_require_brand_observation_without_rewriting_saved_profiles() {
        let db = seeded_db();
        db.conn.lock().unwrap().execute("UPDATE assets SET folder_id = NULL WHERE id != 'asset-0'", []).unwrap();
        db.conn.lock().unwrap().execute("UPDATE analyses SET payload = json_remove(payload, '$.instruction') WHERE asset_id = 'asset-0'", []).unwrap();
        let preview = db.visual_profile_preview("", "f1").unwrap();
        assert_eq!(preview.effective, 0);
        assert_eq!(preview.missing[0].reason, "brand_observation_required");
        assert!(db.visual_profile_freeze_brand_cards("", "f1", Some(&preview.asset_ids)).is_err());
    }

    #[test]
    fn labelled_colour_codes_survive_caption_draft_confirmation_and_capsule() {
        let db = seeded_db();
        let raw = "- **品牌规范**\npalette | 主色 HEX | #1a2B3c\npalette | 主色 CMYK | C57 M28 Y0 K76\n- **色调**\n低饱和冷色";
        let parsed = crate::core::caption::parse(raw);
        let payload = crate::core::caption::build_payload(raw, BRAND_OBSERVATION_TASK, None, "bowerbird-cloud", &parsed);
        let card = to_evidence_card("asset-0", "labelled", &payload, "imported");
        assert!(card.sections.iter().any(|section| section.title == "品牌规范" && section.body.contains("#1a2B3c") && section.body.contains("C57 M28 Y0 K76")));
        let value = "原图明确标注：主色 HEX：#1a2B3c";
        let draft = serde_json::json!({"schemaVersion":1,"visualRules":[{"category":"palette","value":value,"polarity":"must","confidence":1,"supportingAssetIds":["asset-0"]}]}).to_string();
        let detail = db.persist_cloud_visual_profile("", "f1", &[card], &draft).unwrap();
        db.confirm_visual_profile(&detail.summary.id).unwrap();
        let capsule = db.visual_profile_capsule(&detail.summary.id).unwrap();
        assert_eq!(capsule.must[0].value, value);
        assert!(inject_visual_profile_prompt("做一张海报", &capsule).contains("#1a2B3c"));
    }

    #[test]
    fn conflicting_labelled_standards_require_review_before_confirmation() {
        let db = seeded_db();
        let (_, cards) = db.visual_profile_freeze_cards("p1", "f1").unwrap();
        let draft = serde_json::json!({"schemaVersion":1,"visualRules":[{"category":"palette","value":"待核对的原图标注：主色 HEX：#112233","polarity":"prefer","supportingAssetIds":["asset-0"]}]}).to_string();
        let detail = db.persist_cloud_visual_profile("", "f1", &cards, &draft).unwrap();
        assert!(db.confirm_visual_profile(&detail.summary.id).unwrap_err().to_string().contains("冲突"));
    }

    #[test]
    fn brand_cloud_scope_can_start_with_one_analyzed_image() {
        let db = seeded_db();
        db.conn.lock().unwrap().execute("DELETE FROM analyses WHERE asset_id != 'asset-0'", []).unwrap();
        let preview = db.visual_profile_preview("p1", "f1").unwrap();
        assert_eq!(preview.min_required, 1);
        assert_eq!(preview.asset_ids.len(), preview.in_folder);
        let (_, cards) = db.visual_profile_freeze_cards("p1", "f1").unwrap();
        assert_eq!(cards.iter().filter(|card| card_is_effective(card)).count(), 1);
    }

    #[test]
    fn freeze_rejects_insufficient_coverage() {
        let db = seeded_db();
        {
            let conn = db.conn.lock().unwrap();
            for i in 0..6 {
                conn.execute(
                    "DELETE FROM analyses WHERE asset_id = ?1",
                    params![format!("asset-{i}")],
                )
                .unwrap();
            }
        }
        assert!(db.visual_profile_freeze_cards("p1", "f1").is_err());
    }

    #[test]
    fn validation_prompt_compiles_rules_without_themes() {
        let rules = vec![
            DraftRule {
                id: "r1".into(),
                category: "palette".into(),
                value: "低饱和暖调".into(),
                polarity: "must".into(),
                confidence: 0.9,
                supporting_asset_ids: vec![],
                opposing_asset_ids: vec![],
                confirmed_by_user: false,
            },
            DraftRule {
                id: "r2".into(),
                category: "light".into(),
                value: "柔和散射光".into(),
                polarity: "prefer".into(),
                confidence: 0.8,
                supporting_asset_ids: vec![],
                opposing_asset_ids: vec![],
                confirmed_by_user: false,
            },
            DraftRule {
                id: "r3".into(),
                category: "mood".into(),
                value: "高饱和撞色".into(),
                polarity: "avoid".into(),
                confidence: 0.7,
                supporting_asset_ids: vec![],
                opposing_asset_ids: vec![],
                confirmed_by_user: false,
            },
        ];
        let prompt = super::compile_validation_prompt(&rules, "静物台面");
        assert!(prompt.contains("静物台面"));
        assert!(prompt.contains("必须满足：色彩：低饱和暖调"));
        assert!(prompt.contains("风格倾向：光线：柔和散射光"));
        assert!(prompt.contains("避免出现：氛围：高饱和撞色"));
        assert!(prompt.contains("不要出现任何文字"));
        // 内容主题不进入 prompt（由调用方只传规则保证，这里验证编译器只消费规则）
        let empty = super::compile_validation_prompt(&[], "室内一角");
        assert!(empty.contains("室内一角"));
    }

    #[test]
    fn link_validation_asset_is_idempotent_and_guarded() {
        let db = seeded_db();
        let detail = db.extract_visual_profile("p1", "f1").unwrap();
        assert!(db
            .link_validation_asset(&detail.summary.id, "asset-0")
            .is_ok());
        assert!(db
            .link_validation_asset(&detail.summary.id, "asset-0")
            .is_ok());
        assert!(db
            .link_validation_asset("missing-profile", "asset-0")
            .is_err());
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM visual_profile_assets WHERE profile_id = ?1 AND role = 'validation'",
                params![detail.summary.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn payload_stays_clean_of_local_file_metadata() {
        let db = seeded_db();
        // 证据卡只从 caption 文字构造；本机文件名/路径不得出现在落库载荷中
        let detail = db.extract_visual_profile("p1", "f1").unwrap();
        let payload: String = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT source_payload FROM project_visual_profiles WHERE id = ?1",
                params![detail.summary.id],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert!(
            !payload.contains(".png"),
            "payload 不应包含文件名后缀: {payload}"
        );
        assert!(!payload.contains("本机文件名"));
        assert!(!payload.contains("store_path"));
        assert!(payload.contains("低饱和暖调"), "caption 文字应保留");
    }
}
