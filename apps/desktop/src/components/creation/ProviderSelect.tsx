import { generationProviderIssue } from "../../lib/generationAvailability";
import type { AuthSnapshot, CodexHealth, EntitlementSnapshot } from "../../lib/types";
import { ComfyEnvironmentControl } from "../ComfyVideoCard";
import { H3_IMAGE, canonicalProviderKey, dreaminaWebModel, genProviders, imageProviderLabel, isCloudProvider } from "../../lib/genProviders";
import { useStore } from "../../store";
import { ModelSelect, type ModelOption } from "./ModelSelect";
import { providerQuota, QUOTA_SOURCES } from "./ProviderQuota";

/** Model names are presentation only; selection keeps the original routing keys. */
export function ProviderSelect({ value, onChange, codexHealth, dreaminaHealth,
  cloudAuth = null, cloudEntitlement = null, defaultProvider = "", onSetDefaultProvider, menuClassName, hasReferences = false, environmentInHeader = false }: {
  value: string; onChange: (provider: string) => void;
  codexHealth: CodexHealth | null; dreaminaHealth: CodexHealth | null;
  cloudAuth?: AuthSnapshot | null; cloudEntitlement?: EntitlementSnapshot | null;
  hasReferences?: boolean; environmentInHeader?: boolean; defaultProvider?: string; onSetDefaultProvider?: (provider: string) => void; menuClassName?: string;
}) {
  const dreaminaVersion = useStore(state => state.settings?.dreamina_model_version ?? "5.0Pro");
  const balance = cloudEntitlement ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup : 0;
  const options: ModelOption[] = genProviders(cloudEntitlement).map(option => {
    const cloud = isCloudProvider(option.key);
    const group = dreaminaWebModel(option.key) ? "即梦" : cloud && /^seedream\b/i.test(option.label) ? "Seedream" : undefined;
    const reason = generationProviderIssue(option.key, { cloudAuth, cloudEntitlement, dreaminaHealth, codexHealth })?.message;
    return { ...option, group, source: cloud ? "cloud" : option.key === H3_IMAGE ? "local" : "personal", reason };
  });
  // Legacy CLI jobs retain their original execution route until a new model is chosen.
  const quota = providerQuota(value);
  const select = <ModelSelect value={canonicalProviderKey(value)} label={imageProviderLabel(value, cloudEntitlement, dreaminaVersion)} menuClassName={menuClassName}
    source={value === H3_IMAGE ? "local" : isCloudProvider(value) ? "cloud" : quota === "unknown" ? undefined : "personal"}
    quotaDetail={QUOTA_SOURCES[quota].detail} options={options} onChange={onChange}
    cloudBalance={cloudEntitlement ? balance : null} cloudLoggedIn={cloudAuth?.logged_in}
    defaultKey={canonicalProviderKey(defaultProvider)} onSetDefault={onSetDefaultProvider} />;
  if (value !== H3_IMAGE || environmentInHeader) return select;
  return <div className="h3-image-model-controls">{select}
    <ComfyEnvironmentControl key={cloudAuth?.user_id} node={{}} imageMode={hasReferences ? "edit" : "image"} disabled={false} onChange={() => {}} /></div>;
}
