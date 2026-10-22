import { CircleHelp, Coins, Monitor, UserRound } from "lucide-react";
import { isCloudProvider } from "../../lib/genProviders";
import "./ProviderQuota.css";

export type QuotaSource = "bowerbird" | "chatgpt" | "jimeng" | "local" | "unknown";

export const QUOTA_SOURCES = {
  bowerbird: { label: "Bowerbird 积分", detail: "使用 Bowerbird 账号积分，包含赠送、订阅和充值积分。", Icon: Coins },
  chatgpt: { label: "自有 ChatGPT 额度", detail: "使用你登录的 ChatGPT 账号额度，不扣 Bowerbird 积分。", Icon: UserRound },
  jimeng: { label: "自有即梦额度", detail: "使用你登录的即梦账号积分或会员额度，不扣 Bowerbird 积分。", Icon: UserRound },
  local: { label: "本机算力 · 不扣额度", detail: "在本机运行模型，不扣 Bowerbird 积分或第三方账号额度。", Icon: Monitor },
  unknown: { label: "额度来源待确认", detail: "当前引擎的额度来源未识别，请确认引擎后再生成。", Icon: CircleHelp },
} as const;

export function providerQuota(provider: string): QuotaSource {
  if (isCloudProvider(provider)) return "bowerbird";
  if (provider === "codex") return "chatgpt";
  if (provider === "jimeng" || provider === "dreamina") return "jimeng";
  return "unknown";
}

export function ProviderQuota({ source, badge = false }: { source: QuotaSource; badge?: boolean }) {
  const { label, detail, Icon } = QUOTA_SOURCES[source];
  return <span className={`provider-quota${badge ? " provider-quota-badge" : ""}`} data-quota={source} title={detail}>
    <Icon size={12} aria-hidden="true" /><span>{label}</span>
  </span>;
}
