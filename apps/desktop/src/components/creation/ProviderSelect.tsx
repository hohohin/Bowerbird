import type { AuthSnapshot, CodexHealth, EntitlementSnapshot } from "../../lib/types";
import { canUseByo } from "../../lib/entitlement";
import { canonicalProviderKey, genProviders, imageProviderLabel, isCloudProvider } from "../../lib/genProviders";
import { useStore } from "../../store";
import { ModelSelect, type ModelOption } from "./ModelSelect";
import { providerQuota, QUOTA_SOURCES } from "./ProviderQuota";

/** Model names are presentation only; selection keeps the original routing keys. */
export function ProviderSelect({ value, onChange, codexHealth, dreaminaHealth, cloudAvailable = false,
  cloudAuth = null, cloudEntitlement = null, defaultProvider = "", onSetDefaultProvider }: {
  value: string; onChange: (provider: string) => void;
  codexHealth: CodexHealth | null; dreaminaHealth: CodexHealth | null;
  cloudAvailable?: boolean; cloudAuth?: AuthSnapshot | null; cloudEntitlement?: EntitlementSnapshot | null;
  defaultProvider?: string; onSetDefaultProvider?: (provider: string) => void;
}) {
  const dreaminaVersion = useStore(state => state.settings?.dreamina_model_version ?? "5.0Pro");
  const balance = cloudEntitlement ? cloudEntitlement.balances.daily + cloudEntitlement.balances.sub + cloudEntitlement.balances.topup : 0;
  const options: ModelOption[] = genProviders(cloudEntitlement, dreaminaVersion).map(option => {
    const cloud = isCloudProvider(option.key);
    const health = option.key === "jimeng" ? dreaminaHealth : codexHealth;
    const reason = cloud
      ? !cloudAvailable ? "当前版本未配置 Bowerbird Cloud"
        : !cloudAuth?.logged_in ? "请先登录 Bowerbird 账号" : balance <= 0 ? "积分不足" : undefined
      : !canUseByo(cloudEntitlement) ? "升级 Pro 解锁自有订阅"
        : !health?.ok ? health?.reason || "请先登录对应账号并检查引擎" : undefined;
    return { ...option, source: cloud ? "cloud" : "personal", reason };
  });
  const quota = providerQuota(value);
  return <ModelSelect value={canonicalProviderKey(value)} label={imageProviderLabel(value, cloudEntitlement, dreaminaVersion)}
    source={isCloudProvider(value) ? "cloud" : quota === "unknown" ? undefined : "personal"}
    quotaDetail={QUOTA_SOURCES[quota].detail} options={options} onChange={onChange}
    cloudBalance={cloudEntitlement ? balance : null} cloudLoggedIn={cloudAuth?.logged_in}
    defaultKey={canonicalProviderKey(defaultProvider)} onSetDefault={onSetDefaultProvider} />;
}
