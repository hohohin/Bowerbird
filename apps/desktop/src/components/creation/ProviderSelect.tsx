import { useRef, useState } from "react";
import { generationProviderIssue } from "../../lib/generationAvailability";
import { api } from "../../lib/api";
import { notifyError } from "../../lib/notify";
import type { AuthSnapshot, CodexHealth, EntitlementSnapshot } from "../../lib/types";
import { canonicalProviderKey, dreaminaModelKey, dreaminaVersionForKey, genProviders, imageProviderLabel, isCloudProvider } from "../../lib/genProviders";
import { useStore } from "../../store";
import { ModelSelect, type ModelOption } from "./ModelSelect";
import { providerQuota, QUOTA_SOURCES } from "./ProviderQuota";

/** Model names are presentation only; selection keeps the original routing keys. */
export function ProviderSelect({ value, onChange, codexHealth, dreaminaHealth,
  cloudAuth = null, cloudEntitlement = null, defaultProvider = "", onSetDefaultProvider, menuClassName }: {
  value: string; onChange: (provider: string) => void;
  codexHealth: CodexHealth | null; dreaminaHealth: CodexHealth | null;
  cloudAuth?: AuthSnapshot | null; cloudEntitlement?: EntitlementSnapshot | null;
  defaultProvider?: string; onSetDefaultProvider?: (provider: string) => void; menuClassName?: string;
}) {
  const dreaminaVersion = useStore(state => state.settings?.dreamina_model_version ?? "5.0Pro");
  const settingsReady = useStore(state => state.settings !== null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const balance = cloudEntitlement ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup : 0;
  const options: ModelOption[] = genProviders(cloudEntitlement, dreaminaVersion).map(option => {
    const cloud = isCloudProvider(option.key);
    const dreamina = dreaminaVersionForKey(option.key) !== null;
    const issue = generationProviderIssue(dreamina ? "jimeng" : option.key, { cloudAuth, cloudEntitlement, dreaminaHealth, codexHealth });
    const reason = saving ? "正在保存模型选择，请稍候" : issue?.message
      ?? (dreamina && !settingsReady ? "模型设置尚未加载，请稍后重试" : undefined);
    return { ...option, source: cloud ? "cloud" : "personal", reason };
  });
  async function select(key: string, setDefault = false) {
    if (savingRef.current || options.find(option => option.key === key)?.reason) return;
    const version = dreaminaVersionForKey(key);
    if (version !== null && version !== dreaminaVersion) {
      const settings = useStore.getState().settings;
      if (!settings) return;
      savingRef.current = true;
      setSaving(true);
      try {
        await api.updateSettings({ ...settings, dreamina_model_version: version });
        // Keep other in-memory settings if they changed while this write waited.
        useStore.setState(state => ({ settings: { ...state.settings!, dreamina_model_version: version } }));
      } catch (error) {
        notifyError(error, "模型选择未保存，请重试。");
        return;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    }
    const provider = version === null ? key : "jimeng";
    if (setDefault) onSetDefaultProvider?.(provider);
    else onChange(provider);
  }
  const selectionKey = (key: string) => key === "jimeng" || key === "dreamina" ? dreaminaModelKey(dreaminaVersion) : canonicalProviderKey(key);
  const quota = providerQuota(value);
  return <ModelSelect value={selectionKey(value)} label={imageProviderLabel(value, cloudEntitlement, dreaminaVersion)} menuClassName={menuClassName}
    source={isCloudProvider(value) ? "cloud" : quota === "unknown" ? undefined : "personal"}
    quotaDetail={QUOTA_SOURCES[quota].detail} options={options} onChange={key => { void select(key); }}
    cloudBalance={cloudEntitlement ? balance : null} cloudLoggedIn={cloudAuth?.logged_in}
    defaultKey={selectionKey(defaultProvider)} onSetDefault={onSetDefaultProvider ? key => { void select(key, true); } : undefined} />;
}
