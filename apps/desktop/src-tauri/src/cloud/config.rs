use serde::{Deserialize, Serialize};

const FUNCTION_REGION: &str = "ap-northeast-1";

#[derive(Deserialize)]
struct Routes { functions: Vec<String>, storage: Vec<StorageRoute> }
#[derive(Deserialize)]
struct StorageRoute { bucket: String, method: String, pattern: String }
fn routes() -> &'static Routes {
    static ROUTES: std::sync::OnceLock<Routes> = std::sync::OnceLock::new();
    ROUTES.get_or_init(|| serde_json::from_str(include_str!("../../../../../website/cloud-routes.json"))
        .expect("bundled Cloud route contract must be valid"))
}

/// 桌面端可持有的公开云配置。机密 key 不属于这个结构。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudConfig {
    pub supabase_url: Option<String>,
    pub supabase_publishable_key: Option<String>,
    #[serde(default)]
    pub account_api_url: Option<String>,
}

impl CloudConfig {
    /// 官方公开连接配置在构建时写入应用；用户设置不能覆盖。
    pub fn official() -> Self {
        Self {
            supabase_url: option_env!("BOWERBIRD_SUPABASE_URL").map(str::to_string),
            supabase_publishable_key: option_env!("BOWERBIRD_SUPABASE_PUBLISHABLE_KEY")
                .map(str::to_string),
            account_api_url: Some("https://bowerbird.cn/api/account".into()),
        }
    }

    pub fn is_available(&self) -> bool {
        self.supabase_url
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            && self
                .supabase_publishable_key
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    }

    pub fn auth_base_url(&self) -> Option<&str> {
        self.account_api_url.as_deref().or(self.supabase_url.as_deref())
    }

    pub fn account_endpoint(&self, function: &str) -> Option<String> {
        if !self.is_available()
            || !matches!(function, "wechat-login" | "entitlement" | "redeem-code" | "comfy-download" | "create-checkout" | "checkout-status")
        {
            return None;
        }
        let base = self.auth_base_url()?.trim().trim_end_matches('/');
        Some(format!("{base}/functions/v1/{function}?forceFunctionRegion={FUNCTION_REGION}"))
    }

    pub fn endpoint(&self, function: &str) -> Option<String> {
        if !self.is_available() || !routes().functions.iter().any(|name| name == function) {
            return None;
        }
        if self.account_api_url.is_some() {
            let mut url = self.generation_gateway()?;
            url.set_path(&format!("/api/cloud/functions/v1/{function}"));
            url.set_query(Some(&format!("forceFunctionRegion={FUNCTION_REGION}")));
            return Some(url.into());
        }
        let base = self.supabase_url.as_deref()?.trim().trim_end_matches('/');
        if base.is_empty() {
            return None;
        }
        Some(format!(
            "{base}/functions/v1/{function}?forceFunctionRegion={FUNCTION_REGION}"
        ))
    }

    fn generation_gateway(&self) -> Option<reqwest::Url> {
        let mut url = reqwest::Url::parse(self.account_api_url.as_deref()?).ok()?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        url.set_query(None);
        url.set_fragment(None);
        Some(url)
    }

    /// RLS-bound lookup only; no general REST/table proxy is exposed.
    pub fn understand_lookup_endpoint(&self) -> Option<String> {
        if !self.is_available() { return None; }
        if self.account_api_url.is_some() {
            let mut target = self.generation_gateway()?;
            target.set_path("/api/cloud/rest/v1/understand_jobs");
            return Some(target.into());
        }
        Some(format!("{}/rest/v1/understand_jobs", self.supabase_url.as_deref()?.trim_end_matches('/')))
    }

    pub fn agent_transfer_url(&self, signed_url: &str, upload: bool) -> Option<String> {
        self.storage_transfer_url(signed_url, "agent-temp", upload)
    }

    /// Only signed generation objects from our configured Cloud may use the gateway.
    /// Keep the signature query byte-for-byte; the gateway does not mint credentials.
    pub fn generation_transfer_url(&self, signed_url: &str, upload: bool) -> Option<String> {
        self.storage_transfer_url(signed_url, "generation-temp", upload)
    }

    fn storage_transfer_url(&self, signed_url: &str, bucket: &str, upload: bool) -> Option<String> {
        let source = reqwest::Url::parse(signed_url).ok()?;
        let upstream = reqwest::Url::parse(self.supabase_url.as_deref()?).ok()?;
        let mode = if upload { "upload/sign" } else { "sign" };
        let prefix = format!("/storage/v1/object/{mode}/{bucket}/");
        let object = source.path().strip_prefix(&prefix)?;
        if source.scheme() != "https" || source.origin() != upstream.origin()
            || !source.username().is_empty() || source.password().is_some()
            || source.fragment().is_some()
            || signed_url.contains("/../") || signed_url.contains("/./")
            || regex::Regex::new(r"(?i)%2e|%2f|%5c|\\").unwrap().is_match(signed_url.split('?').next()?)
            || !routes().storage.iter().any(|route| route.bucket == bucket
                && route.method == if upload { "PUT" } else { "GET" }
                && regex::Regex::new(&route.pattern).expect("valid storage pattern").is_match(object))
        {
            return None;
        }
        let query: Vec<_> = source.query_pairs().collect();
        if query.iter().filter(|(key, _)| key == "token").count() != 1
            || query.iter().any(|(key, value)| key == "token" && value.is_empty())
            || query.iter().any(|(key, value)| key != "token" && (upload || key != "download" || !value.is_empty()))
            || query.iter().filter(|(key, _)| key == "download").count() > 1 {
            return None;
        }
        if self.account_api_url.is_none() {
            return Some(source.into());
        }
        let mut target = self.generation_gateway()?;
        target.set_path(&format!("/api/cloud{}", source.path()));
        target.set_query(source.query());
        Some(target.into())
    }
}

#[cfg(test)]
mod tests {
    use super::CloudConfig;

    #[test]
    fn incomplete_config_is_unavailable() {
        let config = CloudConfig {
            supabase_url: Some("https://example.supabase.co".into()),
            supabase_publishable_key: None,
            account_api_url: None,
        };
        assert!(!config.is_available());
        assert_eq!(config.endpoint("generate-proxy"), None);
    }

    #[test]
    fn endpoint_normalizes_trailing_slash() {
        let config = CloudConfig {
            supabase_url: Some("https://example.supabase.co/".into()),
            supabase_publishable_key: Some("sb_publishable_test".into()),
            account_api_url: None,
        };
        assert!(config.is_available());
        assert_eq!(
            config.endpoint("generate-proxy").as_deref(),
            Some(
                "https://example.supabase.co/functions/v1/generate-proxy?forceFunctionRegion=ap-northeast-1"
            )
        );
    }

    #[test]
    fn all_registered_functions_use_gateway_and_unknown_routes_fail_closed() {
        let config = CloudConfig {
            supabase_url: Some("https://example.supabase.co".into()),
            supabase_publishable_key: Some("sb_publishable_test".into()),
            account_api_url: Some("https://bowerbird.cn/api/account/".into()),
        };
        for function in ["wechat-login", "entitlement", "redeem-code", "create-checkout", "checkout-status"] {
            assert_eq!(config.account_endpoint(function).unwrap(), format!(
                "https://bowerbird.cn/api/account/functions/v1/{function}?forceFunctionRegion=ap-northeast-1"
            ));
        }
        assert_eq!(config.account_endpoint("generate-proxy"), None);
        assert_eq!(config.endpoint("generate-proxy").unwrap(), "https://bowerbird.cn/api/cloud/functions/v1/generate-proxy?forceFunctionRegion=ap-northeast-1");
        assert_eq!(config.endpoint("chat-proxy").unwrap(), "https://bowerbird.cn/api/cloud/functions/v1/chat-proxy?forceFunctionRegion=ap-northeast-1");
        assert_eq!(config.endpoint("agent-run").unwrap(), "https://bowerbird.cn/api/cloud/functions/v1/agent-run?forceFunctionRegion=ap-northeast-1");
        for function in &super::routes().functions {
            assert!(config.endpoint(function).unwrap().starts_with("https://bowerbird.cn/api/cloud/"));
        }
        assert_eq!(config.endpoint("agent-worker"), None);
        assert_eq!(config.endpoint("future-function"), None);
        assert!(config.understand_lookup_endpoint().unwrap().starts_with("https://bowerbird.cn/api/cloud/"));
        assert_eq!(config.auth_base_url(), Some("https://bowerbird.cn/api/account/"));
        let direct = CloudConfig { account_api_url: None, ..config };
        assert_eq!(direct.auth_base_url(), Some("https://example.supabase.co"));
        assert!(direct.account_endpoint("wechat-login").unwrap().starts_with("https://example.supabase.co/"));
    }

    #[test]
    fn signed_agent_manifest_uses_gateway_without_changing_signature() {
        let config = CloudConfig { supabase_url: Some("https://example.supabase.co".into()),
            supabase_publishable_key: Some("public".into()), account_api_url: Some("https://bowerbird.cn/api/account".into()) };
        let source = "https://example.supabase.co/storage/v1/object/upload/sign/agent-temp/runs/11111111-2222-4333-8444-555555555555/inputs/request.json?token=a%2Bb.c%2Fd";
        assert_eq!(config.agent_transfer_url(source, true).unwrap(), source.replace("https://example.supabase.co", "https://bowerbird.cn/api/cloud"));
        let direct = CloudConfig { account_api_url: None, ..config.clone() };
        assert_eq!(direct.agent_transfer_url(source, true).unwrap(), source);
        for bad in [source.replace("https:", "http:"), source.replace("example.supabase.co", "evil.test"),
            source.replace("example.supabase.co", "user@example.supabase.co"), source.replace("request.json", "other.json"),
            source.replace("agent-temp", "other-bucket"), source.replace("11111111-2222-4333-8444-555555555555", "bad-id"),
            source.replace("?token=a%2Bb.c%2Fd", ""), format!("{source}&token=second"), format!("{source}#fragment")] {
            assert_eq!(config.agent_transfer_url(&bad, true), None, "{bad}");
        }
    }

    #[test]
    fn agent_media_and_download_flags_follow_the_same_closed_contract() {
        let config = CloudConfig { supabase_url: Some("https://example.supabase.co".into()),
            supabase_publishable_key: Some("public".into()), account_api_url: Some("https://bowerbird.cn/api/account".into()) };
        let root = "https://example.supabase.co/storage/v1/object";
        let id = "11111111-2222-4333-8444-555555555555";
        for (upload, object) in [(true, "inputs/reference-1"), (true, "inputs/reference-8"),
            (true, "artifacts/result.png"), (false, "artifacts/result-slice-0001.webp")] {
            let mode = if upload { "upload/sign" } else { "sign" };
            let source = format!("{root}/{mode}/agent-temp/runs/{id}/{object}?token=a%2Bb.c%2Fd{}", if upload { "" } else { "&download=" });
            assert_eq!(config.agent_transfer_url(&source, upload).unwrap(), source.replace("https://example.supabase.co", "https://bowerbird.cn/api/cloud"));
            for bad in [format!("{source}&token="), source.replace("/runs/", "/%2e%2e/runs/"), source.replace("/runs/", "/../runs/")] {
                assert!(config.agent_transfer_url(&bad, upload).is_none());
            }
        }
        for object in ["inputs/reference-9", "checkpoints/private.json", "artifacts/private.json"] {
            assert!(config.agent_transfer_url(&format!("{root}/upload/sign/agent-temp/runs/{id}/{object}?token=signed"), true).is_none());
        }
    }

    #[test]
    fn signed_generation_transfers_preserve_tokens_and_reject_untrusted_origins() {
        let config = CloudConfig {
            supabase_url: Some("https://example.supabase.co".into()),
            supabase_publishable_key: Some("public".into()),
            account_api_url: Some("https://bowerbird.cn/api/account".into()),
        };
        for (upload, path) in [
            (false, "sign/generation-temp/jobs/11111111-2222-4333-8444-555555555555/outputs/result.mp4"),
            (false, "sign/generation-temp/jobs/11111111-2222-4333-8444-555555555555/outputs/result.png"),
            (false, "sign/generation-temp/jobs/11111111-2222-4333-8444-555555555555/outputs/result.json"),
            (true, "upload/sign/generation-temp/jobs/11111111-2222-4333-8444-555555555555/inputs/video-0.mov"),
        ] {
            let source = format!("https://example.supabase.co/storage/v1/object/{path}?token=a%2Bb.c%2Fd");
            assert_eq!(config.generation_transfer_url(&source, upload).unwrap(), source.replace("https://example.supabase.co", "https://bowerbird.cn/api/cloud"));
            let direct = CloudConfig { account_api_url: None, ..config.clone() };
            assert_eq!(direct.generation_transfer_url(&source, upload), Some(source));
        }
        let source = "https://example.supabase.co/storage/v1/object/sign/generation-temp/jobs/11111111-2222-4333-8444-555555555555/outputs/result.png?token=signed";
        for bad in [
            source.replace("https:", "http:"),
            source.replace("example.supabase.co", "example.supabase.co.evil.test"),
            source.replace("example.supabase.co", "user@example.supabase.co"),
            source.replace("generation-temp", "other-bucket"),
            source.replace("?token=signed", ""),
            format!("{source}&token=second"),
            format!("{source}&url=https://evil.test"),
            format!("{source}#fragment"),
        ] {
            assert_eq!(config.generation_transfer_url(&bad, false), None, "{bad}");
        }
        assert_eq!(config.generation_transfer_url(source, true), None);
    }
}
