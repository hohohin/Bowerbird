use serde::{Deserialize, Serialize};

const FUNCTION_REGION: &str = "ap-northeast-1";

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
            || !matches!(function, "wechat-login" | "entitlement" | "redeem-code" | "comfy-download")
        {
            return None;
        }
        let base = self.auth_base_url()?.trim().trim_end_matches('/');
        Some(format!("{base}/functions/v1/{function}?forceFunctionRegion={FUNCTION_REGION}"))
    }

    pub fn endpoint(&self, function: &str) -> Option<String> {
        if !self.is_available() {
            return None;
        }
        if function == "generate-proxy" && self.account_api_url.is_some() {
            let mut url = self.generation_gateway()?;
            url.set_path("/api/cloud/functions/v1/generate-proxy");
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

    /// Only signed generation objects from our configured Cloud may use the gateway.
    /// Keep the signature query byte-for-byte; the gateway does not mint credentials.
    pub fn generation_transfer_url(&self, signed_url: &str, upload: bool) -> Option<String> {
        let source = reqwest::Url::parse(signed_url).ok()?;
        let upstream = reqwest::Url::parse(self.supabase_url.as_deref()?).ok()?;
        let prefix = if upload {
            "/storage/v1/object/upload/sign/generation-temp/jobs/"
        } else {
            "/storage/v1/object/sign/generation-temp/jobs/"
        };
        if source.scheme() != "https" || source.origin() != upstream.origin()
            || !source.username().is_empty() || source.password().is_some()
            || source.fragment().is_some() || !source.path().starts_with(prefix)
        {
            return None;
        }
        let query: Vec<_> = source.query_pairs().collect();
        if query.len() != 1 || query[0].0 != "token" || query[0].1.is_empty() {
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
    fn generation_uses_separate_gateway_without_rerouting_other_functions() {
        let config = CloudConfig {
            supabase_url: Some("https://example.supabase.co".into()),
            supabase_publishable_key: Some("sb_publishable_test".into()),
            account_api_url: Some("https://bowerbird.cn/api/account/".into()),
        };
        for function in ["wechat-login", "entitlement", "redeem-code"] {
            assert_eq!(config.account_endpoint(function).unwrap(), format!(
                "https://bowerbird.cn/api/account/functions/v1/{function}?forceFunctionRegion=ap-northeast-1"
            ));
        }
        assert_eq!(config.account_endpoint("generate-proxy"), None);
        assert_eq!(config.endpoint("generate-proxy").unwrap(), "https://bowerbird.cn/api/cloud/functions/v1/generate-proxy?forceFunctionRegion=ap-northeast-1");
        assert!(config.endpoint("understand-proxy").unwrap().starts_with("https://example.supabase.co/"));
        assert_eq!(config.auth_base_url(), Some("https://bowerbird.cn/api/account/"));
        let direct = CloudConfig { account_api_url: None, ..config };
        assert_eq!(direct.auth_base_url(), Some("https://example.supabase.co"));
        assert!(direct.account_endpoint("wechat-login").unwrap().starts_with("https://example.supabase.co/"));
    }

    #[test]
    fn signed_generation_transfers_preserve_tokens_and_reject_untrusted_origins() {
        let config = CloudConfig {
            supabase_url: Some("https://example.supabase.co".into()),
            supabase_publishable_key: Some("public".into()),
            account_api_url: Some("https://bowerbird.cn/api/account".into()),
        };
        for (upload, path) in [
            (false, "sign/generation-temp/jobs/id/outputs/result.mp4"),
            (false, "sign/generation-temp/jobs/id/outputs/result.png"),
            (false, "sign/generation-temp/jobs/id/outputs/result.json"),
            (true, "upload/sign/generation-temp/jobs/id/inputs/video-0.mov"),
        ] {
            let source = format!("https://example.supabase.co/storage/v1/object/{path}?token=a%2Bb.c%2Fd");
            assert_eq!(config.generation_transfer_url(&source, upload).unwrap(), source.replace("https://example.supabase.co", "https://bowerbird.cn/api/cloud"));
            let direct = CloudConfig { account_api_url: None, ..config.clone() };
            assert_eq!(direct.generation_transfer_url(&source, upload), Some(source));
        }
        let source = "https://example.supabase.co/storage/v1/object/sign/generation-temp/jobs/id/outputs/result.png?token=signed";
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
