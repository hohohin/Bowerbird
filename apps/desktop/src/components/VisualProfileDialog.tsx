import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { effectivePolicy } from "../lib/entitlement";
import { notifySuccess } from "../lib/notify";
import { useStore } from "../store";
import { ModalShell } from "./ModalShell";
import type {
  VisualProfileDetail,
  VisualProfileDraftRule,
  VisualProfileScopePreview,
  VisualProfileSummary,
} from "../lib/types";

/**
 * 项目视觉设定弹窗（V1+V2）：覆盖率预览 → 云端模型提炼（2 积分，DeepSeek 分批）或
 * 本地基线（免费）→ 可编辑草稿（V2-T3：改值/改强度/删规则/选方向）→ 确认保存。
 * 三条不可变边界文案明示：只用已有反推文字、不上传图片、不自动补反推。
 */

const CATEGORY_LABELS: Record<string, string> = {
  composition: "构图",
  light: "光线",
  palette: "色彩",
  mood: "氛围",
  material: "材质",
  medium: "类型",
  layout: "版式",
};

const VALIDATION_THEMES = ["静物台面", "室内一角", "自然场景", "抽象背景"];

const VALIDATION_DIMENSIONS: Array<{ key: string; label: string }> = [
  { key: "composition", label: "构图" },
  { key: "palette", label: "色彩" },
  { key: "light", label: "光线" },
  { key: "mood", label: "氛围" },
  { key: "material", label: "材质" },
];

const RATING_OPTIONS = ["符合", "部分符合", "不符合"];

const POLARITY_LABELS: Record<string, string> = {
  must: "必须",
  prefer: "倾向",
  avoid: "避免",
};

type EditableRule = VisualProfileDraftRule & { deleted?: boolean };

function categoryLabel(category: string) {
  return CATEGORY_LABELS[category] ?? category;
}

function formatTime(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleString();
}

type Phase = "preview" | "draft" | "done";

export function VisualProfileDialog() {
  const folder = useStore((s) => s.visualProfileFolder);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const close = useStore((s) => s.closeVisualProfile);
  const reloadVisualProfiles = useStore((s) => s.reloadVisualProfiles);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);

  const [phase, setPhase] = useState<Phase>("preview");
  const [preview, setPreview] = useState<VisualProfileScopePreview | null>(null);
  const [history, setHistory] = useState<VisualProfileSummary[]>([]);
  const [detail, setDetail] = useState<VisualProfileDetail | null>(null);
  const [rules, setRules] = useState<EditableRule[]>([]);
  const [selectedDirection, setSelectedDirection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  // —— V3 方向验证图（可选；未确认不入库，丢弃即删缓存文件）——
  const [theme, setTheme] = useState(VALIDATION_THEMES[0]!);
  const [customTheme, setCustomTheme] = useState("");
  const [validation, setValidation] = useState<{ imagePath: string; prompt: string; credits: number } | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationRounds, setValidationRounds] = useState(0);
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [adoptedAssetId, setAdoptedAssetId] = useState<string | null>(null);

  const cloudAvailable =
    !!cloudAuth?.logged_in &&
    !!cloudAuth.cloud_available &&
    effectivePolicy(cloudEntitlement).can_use_visual_profiles;

  useEffect(() => {
    if (!folder || !currentProjectId) return;
    setPhase("preview");
    setPreview(null);
    setHistory([]);
    setDetail(null);
    setRules([]);
    setSelectedDirection(null);
    setError(null);
    setValidation(null);
    setValidationRounds(0);
    setRatings({});
    setAdoptedAssetId(null);
    setValidationError(null);
    setBusy(true);
    Promise.all([
      api.visualProfilePreview(currentProjectId, folder.id),
      api.visualProfileList(currentProjectId, folder.id),
    ])
      .then(([scope, list]) => {
        setPreview(scope);
        setHistory(list);
      })
      .catch((e) => setError(typeof e === "string" ? e : "读取文件夹反推覆盖情况失败"))
      .finally(() => setBusy(false));
  }, [folder, currentProjectId]);

  const resetToPreview = () => {
    setPhase("preview");
    setDetail(null);
    setRules([]);
    setSelectedDirection(null);
  };

  function applyDetail(value: VisualProfileDetail) {
    setDetail(value);
    setRules(value.rules.map((rule) => ({ ...rule })));
    setSelectedDirection(null);
    setPhase("draft");
  }

  const directionAssets = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const direction of detail?.candidateDirections ?? []) {
      map.set(direction.label, new Set(direction.supportingAssetIds));
    }
    return map;
  }, [detail]);

  const visibleRules = useMemo(() => {
    if (!selectedDirection) return rules.filter((rule) => !rule.deleted);
    const assets = directionAssets.get(selectedDirection) ?? new Set<string>();
    return rules.filter(
      (rule) => !rule.deleted && rule.supportingAssetIds.some((id) => assets.has(id)),
    );
  }, [rules, selectedDirection, directionAssets]);

  // 关闭/切换文件夹时清理未采用的验证图缓存（V3-T4：未确认不入库不留存）。
  // 必须位于早退 return 之前，否则关闭再重开时 hook 顺序不一致会崩溃。
  const pendingValidationRef = useRef<string | null>(null);
  pendingValidationRef.current = validation && !adoptedAssetId ? validation.imagePath : null;
  useEffect(() => {
    return () => {
      const pending = pendingValidationRef.current;
      if (pending) void api.visualProfileDiscardValidation(pending).catch(() => {});
    };
  }, [folder]);

  // 双击竞态锁（useRef 必须位于早退 return 之前，否则关闭弹窗时 hook 数变少会崩溃）。
  const generatingRef = useRef(false);

  if (!folder || !currentProjectId) return null;

  const generateValidation = async () => {
    if (!detail || validating || generatingRef.current) return;
    generatingRef.current = true;
    setValidationError(null);
    try {
      if (dirty) {
        // 有未保存编辑时先自动保存（失败则中止并提示），避免「点了没反应」。
        const saved = await saveEdits();
        if (!saved) {
          setValidationError("规则编辑保存失败，验证图未生成");
          return;
        }
      }
      if (validationRounds >= 2) {
        setValidationError("已达最多两次验证");
        return;
      }
      setValidating(true);
      const effectiveTheme = customTheme.trim() || theme;
      const result = await api.visualProfileGenerateValidation(detail.id, effectiveTheme);
      if (validation) void api.visualProfileDiscardValidation(validation.imagePath).catch(() => {});
      setValidation({ imagePath: result.imagePath, prompt: result.prompt, credits: result.credits });
      setRatings({});
      setValidationRounds((round) => round + 1);
    } catch (e) {
      setValidationError(typeof e === "string" ? e : "验证图生成失败（积分已自动退回）");
    } finally {
      setValidating(false);
      generatingRef.current = false;
    }
  };

  const adoptValidation = async () => {
    if (!detail || !validation || busy) return;
    setBusy(true);
    setValidationError(null);
    try {
      const adopted = await api.visualProfileConfirmValidation(detail.id, validation.imagePath);
      setAdoptedAssetId(adopted.assetId);
      setValidation(null);
      notifySuccess("验证图已入库并关联该视觉设定");
    } catch (e) {
      setValidationError(typeof e === "string" ? e : "采用验证图失败");
    } finally {
      setBusy(false);
    }
  };

  const discardValidation = async () => {
    if (!validation) return;
    const imagePath = validation.imagePath;
    setValidation(null);
    setRatings({});
    try {
      await api.visualProfileDiscardValidation(imagePath);
    } catch {
      // 缓存清理失败不影响主流程
    }
  };

  const runExtraction = async (cloud: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setBusyLabel(cloud ? "云端模型提炼中…（通常 1–3 分钟，失败不扣分）" : "本地基线提炼中…");
    try {
      const created = cloud
        ? await api.visualProfileCloudExtract(currentProjectId, folder.id)
        : await api.visualProfileExtract(currentProjectId, folder.id);
      applyDetail(created);
      setHistory(await api.visualProfileList(currentProjectId, folder.id));
    } catch (e) {
      setError(typeof e === "string" ? e : "提炼失败");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }

  const dirty =
    rules.some((rule) => rule.deleted) ||
    rules.some((rule, index) => {
      const original = detail?.rules[index];
      return !original || original.value !== rule.value || original.polarity !== rule.polarity;
    }) ||
    (selectedDirection !== null && rules.some((rule) => !rule.deleted && rule.supportingAssetIds.length > 0 &&
      !rule.supportingAssetIds.some((id) => (directionAssets.get(selectedDirection) ?? new Set<string>()).has(id))));

  const saveEdits = async (): Promise<boolean> => {
    if (!detail || !dirty) return true;
    const kept = visibleRules.map((rule) => ({
      category: rule.category,
      value: rule.value.trim(),
      polarity: rule.polarity,
      confidence: rule.confidence,
      supportingAssetIds: rule.supportingAssetIds,
      opposingAssetIds: rule.opposingAssetIds,
      confirmedByUser: true,
    }));
    try {
      const updated = await api.visualProfileUpdateDraft(detail.id, kept);
      setDetail(updated);
      setRules(updated.rules.map((rule) => ({ ...rule })));
      return true;
    } catch (e) {
      setError(typeof e === "string" ? e : "保存编辑失败");
      return false;
    }
  }

  const confirm = async () => {
    if (!detail || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await saveEdits())) return;
      const confirmed = await api.visualProfileConfirm(detail.id);
      setDetail(confirmed);
      setRules(confirmed.rules.map((rule) => ({ ...rule })));
      setPhase("done");
      setHistory(await api.visualProfileList(currentProjectId, folder.id));
      await reloadVisualProfiles();
      notifySuccess(`视觉设定 v${confirmed.version} 已保存`);
    } catch (e) {
      setError(typeof e === "string" ? e : "确认失败");
    } finally {
      setBusy(false);
    }
  }

  const insufficient = preview !== null && preview.effective < preview.minRequired;
  const isDraft = detail?.status === "draft";

  return (
    <ModalShell
      title={`提炼视觉设定 · ${folder.name}`}
      eyebrow="Project visual profile"
      description="从该文件夹素材的已有反推文字中提炼项目级视觉规则。不会上传任何图片；只使用当前分析，不自动补反推。"
      onClose={close}
      preventClose={busy}
      width="md"
      footer={
        phase === "preview" ? (
          <>
            <button onClick={close} disabled={busy} className="app-modal-button">
              关闭
            </button>
            {cloudAvailable && (
              <button
                onClick={() => void runExtraction(true)}
                disabled={busy || insufficient}
                className="app-modal-button is-primary"
              >
                {busy && <span className="app-spinner" aria-hidden />}
                {busy ? busyLabel || "提炼中…" : insufficient ? "有效反推不足" : `云端提炼（2 积分）`}
              </button>
            )}
            <button
              onClick={() => void runExtraction(false)}
              disabled={busy || insufficient}
              className={cloudAvailable ? "app-modal-button" : "app-modal-button is-primary"}
            >
              本地基线（免费）
            </button>
          </>
        ) : phase === "draft" ? (
          <>
            <button onClick={resetToPreview} disabled={busy} className="app-modal-button">
              返回
            </button>
            <button onClick={() => void saveEdits()} disabled={busy || !dirty || !isDraft} className="app-modal-button">
              保存编辑
            </button>
            <button onClick={() => void confirm()} disabled={busy || !isDraft} className="app-modal-button is-primary">
              {busy && <span className="app-spinner" aria-hidden />}
              {busy ? "保存中…" : dirty ? "保存并确认" : `确认并保存 v${detail?.version ?? ""}`}
            </button>
          </>
        ) : (
          <button onClick={close} className="app-modal-button is-primary">
            完成
          </button>
        )
      }
    >
      {error && (
        <p className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {phase === "preview" && (
        <div className="space-y-3 text-xs text-ink">
          {busy && !preview && <p className="text-muted">{busyLabel || "读取中…"}</p>}
          {preview && (
            <>
              <p data-modal-autofocus className="tabular-nums">
                将分析 <span className="font-semibold text-accent">{preview.effective}</span>{" "}
                张已有反推素材；
                {preview.missing.length > 0 ? (
                  <>
                    <span className="font-semibold">{preview.missing.length}</span> 张没有可解析反推，本次忽略。
                  </>
                ) : (
                  "该文件夹项目内素材全部有效。"
                )}
              </p>
              <p className="text-[11px] text-faint">
                范围 = 当前项目 ∩「{preview.folderName}」文件夹（共 {preview.inFolder} 张项目内素材）。提炼只读取反推文字，
                不会上传图片或缩略图；数据不足时请先手动反推，系统不会自动补。
                {cloudAvailable ? " 云端提炼消耗 2 积分，失败自动退回。" : " 当前未登录 Cloud，仅本地基线提炼可用。"}
              </p>
              {insufficient && (
                <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
                  有效反推素材不足（{preview.effective}/{preview.minRequired}）。请先在该文件夹整理并反推至少{" "}
                  {preview.minRequired} 张素材。
                </p>
              )}
              {preview.missing.length > 0 && (
                <div className="rounded-lg border border-edge bg-panel2 px-3 py-2">
                  <p className="mb-1 text-[10px] font-medium text-muted">本次忽略（最多显示 8 条）：</p>
                  <ul className="space-y-0.5 text-[11px] text-faint">
                    {preview.missing.slice(0, 8).map((item) => (
                      <li key={item.assetId} className="truncate">
                        · {item.name}（{item.reason === "no_caption" ? "没有反推" : "反推无结构，不可解析"}）
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {phase !== "preview" && detail && (
        <div className="space-y-4 text-xs text-ink">
          {phase === "done" && (
            <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-emerald-300">
              视觉设定 v{detail.version} 已确认保存到本地。生成接入属 V4；重新提炼会生成新草稿，不影响此版本。
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-faint">
              草稿 v{detail.version}（{detail.extractor === "cloud_model" ? "云端模型提炼" : "本地基线"} · 基于{" "}
              {detail.sourceCount} 张素材快照）
            </p>
            <span className="text-[10px] text-faint">
              {isDraft ? "可编辑：改文字、换强度（必须/倾向/避免）、删除" : "已确认，只读"}
            </span>
          </div>
          <div>
            <p className="mb-2 text-[10px] font-medium text-muted">摘要</p>
            <p>{detail.summary}</p>
          </div>

          {(detail.candidateDirections.length > 0 || selectedDirection !== null) && (
            <div>
              <p className="mb-2 text-[10px] font-medium text-muted">
                方向选择（检测到多个方向；选择后只保留该方向的规则）
              </p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setSelectedDirection(null)}
                  disabled={!isDraft}
                  className={`rounded-full border px-2.5 py-1 text-[10px] ${
                    selectedDirection === null
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-edge bg-panel2 text-muted hover:text-ink"
                  }`}
                >
                  全部保留
                </button>
                {detail.candidateDirections.map((direction) => (
                  <button
                    key={direction.label}
                    onClick={() => setSelectedDirection(direction.label)}
                    disabled={!isDraft}
                    className={`rounded-full border px-2.5 py-1 text-[10px] ${
                      selectedDirection === direction.label
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-edge bg-panel2 text-muted hover:text-ink"
                    }`}
                    title={direction.summary}
                  >
                    {direction.label || "default"} · {direction.supportingAssetIds.length} 张
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 text-[10px] font-medium text-muted">
              视觉规则（{visibleRules.length}）
            </p>
            {visibleRules.length === 0 ? (
              <p className="text-faint">未提炼出主导视觉规则（各维度支持度均低于阈值，或有冲突）。</p>
            ) : (
              <ul className="space-y-1.5">
                {visibleRules.map((rule) => {
                  const ruleIndex = rules.indexOf(rule);
                  return (
                    <li
                      key={`${rule.category}-${ruleIndex}`}
                      className="flex items-center gap-2 rounded-lg border border-edge bg-panel2 px-2.5 py-1.5"
                    >
                      <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                        {categoryLabel(rule.category)}
                      </span>
                      {isDraft ? (
                        <>
                          <input
                            value={rule.value}
                            maxLength={200}
                            onChange={(e) =>
                              setRules((current) =>
                                current.map((item, i) =>
                                  i === ruleIndex ? { ...item, value: e.target.value } : item,
                                ),
                              )
                            }
                            className="app-form-input min-w-0 flex-1 px-2 py-0.5 text-xs"
                          />
                          <select
                            value={rule.polarity}
                            onChange={(e) =>
                              setRules((current) =>
                                current.map((item, i) =>
                                  i === ruleIndex
                                    ? { ...item, polarity: e.target.value as EditableRule["polarity"] }
                                    : item,
                                ),
                              )
                            }
                            className="app-form-input shrink-0 px-1 py-0.5 text-[11px]"
                          >
                            {Object.entries(POLARITY_LABELS).map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() =>
                              setRules((current) =>
                                current.map((item, i) => (i === ruleIndex ? { ...item, deleted: true } : item)),
                              )
                            }
                            className="shrink-0 rounded px-1 text-xs text-muted hover:text-red-400"
                            title="删除该规则"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate" title={rule.value}>
                            {rule.value}
                          </span>
                          <span className="shrink-0 text-[10px] text-faint">
                            {POLARITY_LABELS[rule.polarity] ?? rule.polarity} ·{" "}
                            {(rule.confidence * 100).toFixed(0)}% · {rule.supportingAssetIds.length} 张支持
                          </span>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {detail.conflicts.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] font-medium text-muted">冲突（{detail.conflicts.length}）</p>
              <ul className="space-y-1 text-[11px] text-faint">
                {detail.conflicts.map((conflict, index) => (
                  <li key={index}>
                    ⚠ {conflict.description}（{conflict.sideA.assetIds.length} 张 vs {conflict.sideB.assetIds.length}{" "}
                    张）
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.contentThemes.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] font-medium text-muted">
                内容主题（仅背景信息，不会成为生成硬约束）
              </p>
              <div className="flex flex-wrap gap-1.5">
                {detail.contentThemes.slice(0, 12).map((theme) => (
                  <span
                    key={theme.value}
                    className="rounded-full border border-edge bg-panel2 px-2 py-0.5 text-[10px] text-muted"
                  >
                    {theme.value} × {theme.supportingAssetIds.length}
                  </span>
                ))}
              </div>
            </div>
          )}
          {cloudAvailable && (isDraft || adoptedAssetId) && (
            <div className="rounded-lg border border-edge bg-panel2 px-3 py-2.5">
              <p className="mb-2 text-[10px] font-medium text-muted">
                方向验证图（可选，V3）：只用上方文字规则纯文生图，不携带任何来源素材；验证的是「规则能否指导生成」。
              </p>
              {adoptedAssetId ? (
                <p className="text-[11px] text-emerald-300">
                  ✓ 验证图已入库并关联（资产 {adoptedAssetId.slice(0, 12)}…）
                </p>
              ) : validation ? (
                <div className="space-y-2">
                  <img
                    src={convertFileSrc(validation.imagePath)}
                    alt="方向验证图"
                    className="max-h-64 w-full rounded border border-edge object-contain"
                  />
                  <p className="text-[10px] text-faint" title={validation.prompt}>
                    实际发送的规则摘要：{validation.prompt.replace(/\n/g, " ").slice(0, 120)}…
                  </p>
                  <div className="space-y-1">
                    {VALIDATION_DIMENSIONS.map((dim) => (
                      <div key={dim.key} className="flex items-center gap-2">
                        <span className="w-8 shrink-0 text-[10px] text-muted">{dim.label}</span>
                        <div className="flex gap-1">
                          {RATING_OPTIONS.map((option) => (
                            <button
                              key={option}
                              onClick={() =>
                                setRatings((current) => ({ ...current, [dim.key]: option }))
                              }
                              className={`rounded-full px-2 py-0.5 text-[10px] ${
                                ratings[dim.key] === option
                                  ? "border-accent bg-accent/15 text-accent"
                                  : "border-edge text-muted hover:text-ink"
                              }`}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-faint">
                    反馈仅指导你编辑规则（改完保存后可再验证一次）；不会回写云端或素材库。
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      onClick={() => void discardValidation()}
                      disabled={busy}
                      className="app-modal-button px-3 py-1 text-[11px]"
                    >
                      丢弃
                    </button>
                    <button
                      onClick={() => void generateValidation()}
                      disabled={busy || validating || validationRounds >= 2}
                      className="app-modal-button px-3 py-1 text-[11px]"
                      title={validationRounds >= 2 ? "已达最多两次验证" : "未保存的规则编辑会先自动保存，再重新生成"}
                    >
                      {validating ? "生成中…" : `再验证一次（已用 ${validationRounds}/2）`}
                    </button>
                    <button
                      onClick={() => void adoptValidation()}
                      disabled={busy || validating}
                      className="app-modal-button is-primary px-3 py-1 text-[11px]"
                    >
                      采用此验证图（入库并关联）
                    </button>
                  </div>
                  {validating && (
                    <p className="pt-1 text-[11px] text-accent">
                      云端生成中，通常 1–2 分钟——请保持弹窗打开，期间按钮不可再点属正常。
                    </p>
                  )}
                  {validationError && (
                    <p className="mt-1 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
                      {validationError}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {VALIDATION_THEMES.map((preset) => (
                      <button
                        key={preset}
                        onClick={() => {
                          setTheme(preset);
                          setCustomTheme("");
                        }}
                        disabled={!isDraft || validating}
                        className={`rounded-full border px-2.5 py-1 text-[10px] ${
                          !customTheme.trim() && theme === preset
                            ? "border-accent bg-accent/15 text-accent"
                            : "border-edge text-muted hover:text-ink"
                        }`}
                      >
                        {preset}
                      </button>
                    ))}
                    <input
                      value={customTheme}
                      maxLength={120}
                      placeholder="或自定义中性主题"
                      onChange={(e) => setCustomTheme(e.target.value)}
                      className="app-form-input ml-1 w-44 px-2 py-0.5 text-[11px]"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void generateValidation()}
                      disabled={!isDraft || validating || validationRounds >= 2}
                      className="app-modal-button px-3 py-1 text-[11px]"
                    >
                      {validating && <span className="app-spinner" aria-hidden />}
                      {validating ? "生成中…" : "生成验证图"}
                    </button>
                    <span className="text-[10px] text-faint">
                      预计 {cloudEntitlement?.generation_services?.[0]?.credits ?? 1} 积分/张 · 已用 {validationRounds}/2 次
                    </span>
                  </div>
                  {validating && (
                    <p className="text-[11px] text-accent">
                      云端生成中，通常 1–2 分钟——请保持弹窗打开，期间按钮不可再点属正常。
                    </p>
                  )}
                  {validationError && (
                    <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
                      {validationError}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-4 border-t border-edge pt-3">
          <p className="mb-2 text-[10px] font-medium text-muted">该文件夹的历史版本（不随素材变动自动更新）</p>
          <ul className="space-y-1 text-[11px] text-faint">
            {history.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    item.status === "confirmed"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : item.status === "draft"
                        ? "bg-amber-500/15 text-amber-300"
                        : "bg-panel2 text-muted"
                  }`}
                >
                  v{item.version}{" "}
                  {item.status === "confirmed" ? "已确认" : item.status === "draft" ? "草稿" : "已归档"}
                </span>
                <span className="shrink-0 text-[10px]">
                  {item.extractor === "cloud_model" ? "云端" : "基线"}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.summary}</span>
                <span className="shrink-0">{formatTime(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ModalShell>
  );
}
