use serde::{Deserialize, Serialize};

const FUNCTION_REGION: &str = "ap-northeast-1";

/// 桌面端可持有的公开云配置。机密 key 不属于这个结构。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudConfig {
    pub supabase_url: Option<String>,
    pub supabase_publishable_key: Option<String>,
}

impl CloudConfig {
    /// 官方公开连接配置在构建时写入应用；用户设置不能覆盖。
    pub fn official() -> Self {
        Self {
            supabase_url: option_env!("BOWERBIRD_SUPABASE_URL").map(str::to_string),
            supabase_publishable_key: option_env!("BOWERBIRD_SUPABASE_PUBLISHABLE_KEY")
                .map(str::to_string),
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
        };
        assert!(!config.is_available());
        assert_eq!(config.endpoint("generate-proxy"), None);
    }

    #[test]
    fn endpoint_normalizes_trailing_slash() {
        let config = CloudConfig {
            supabase_url: Some("https://example.supabase.co/".into()),
            supabase_publishable_key: Some("sb_publishable_test".into()),
        };
        assert!(config.is_available());
        assert_eq!(
            config.endpoint("generate-proxy").as_deref(),
            Some(
                "https://example.supabase.co/functions/v1/generate-proxy?forceFunctionRegion=ap-northeast-1"
            )
        );
    }
}
