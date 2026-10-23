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
        let base = self.supabase_url.as_deref()?.trim().trim_end_matches('/');
        if base.is_empty() {
            return None;
        }
        Some(format!(
            "{base}/functions/v1/{function}?forceFunctionRegion={FUNCTION_REGION}"
        ))
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
    fn account_gateway_does_not_reroute_generation_or_storage() {
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
        assert!(config.endpoint("generate-proxy").unwrap().starts_with("https://example.supabase.co/"));
        assert_eq!(config.auth_base_url(), Some("https://bowerbird.cn/api/account/"));
        let direct = CloudConfig { account_api_url: None, ..config };
        assert_eq!(direct.auth_base_url(), Some("https://example.supabase.co"));
        assert!(direct.account_endpoint("wechat-login").unwrap().starts_with("https://example.supabase.co/"));
    }
}
