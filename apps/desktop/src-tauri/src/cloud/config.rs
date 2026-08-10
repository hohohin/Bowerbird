use serde::{Deserialize, Serialize};

const FUNCTION_REGION: &str = "ap-northeast-1";

/// 桌面端可持有的公开云配置。机密 key 不属于这个结构。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudConfig {
    pub enabled: bool,
    pub supabase_url: Option<String>,
    pub supabase_publishable_key: Option<String>,
    pub mock: bool,
}

impl CloudConfig {
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn endpoint(&self, function: &str) -> Option<String> {
        if !self.enabled {
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

/// 读取 apps/cloud/.env(.local) 的公开 Supabase 配置，仅用于本机开发连接。
/// 返回 (url, publishable_key)。解析故意保持简单：只认 KEY=VALUE 行，忽略注释/空值。
pub fn read_public_supabase_config(path: &std::path::Path) -> (Option<String>, Option<String>) {
    let candidates = [
        path.to_path_buf(),
        path.with_file_name(".env.local"),
    ];
    let mut url: Option<String> = None;
    let mut key: Option<String> = None;
    for candidate in candidates {
        let Ok(content) = std::fs::read_to_string(&candidate) else { continue };
        for raw in content.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') || !line.contains('=') { continue }
            let Some((name, value)) = line.split_once('=') else { continue };
            let value = value.split('#').next().unwrap_or("").trim().trim_matches('"').trim_matches('\'').to_string();
            match name.trim() {
                "SUPABASE_URL" | "VITE_SUPABASE_URL" if url.is_none() && !value.is_empty() => url = Some(value),
                "SUPABASE_PUBLISHABLE_KEY" | "VITE_SUPABASE_PUBLISHABLE_KEY" | "SUPABASE_ANON_KEY" if key.is_none() && !value.is_empty() => key = Some(value),
                _ => {}
            }
        }
    }
    (url, key)
}

#[cfg(test)]
mod tests {
    use super::CloudConfig;

    #[test]
    fn disabled_config_has_no_endpoint() {
        let config = CloudConfig {
            enabled: false,
            supabase_url: Some("https://example.supabase.co".into()),
            supabase_publishable_key: None,
            mock: false,
        };
        assert_eq!(config.endpoint("generate-proxy"), None);
    }

    #[test]
    fn endpoint_normalizes_trailing_slash() {
        let config = CloudConfig {
            enabled: true,
            supabase_url: Some("https://example.supabase.co/".into()),
            supabase_publishable_key: None,
            mock: true,
        };
        assert_eq!(
            config.endpoint("generate-proxy").as_deref(),
            Some(
                "https://example.supabase.co/functions/v1/generate-proxy?forceFunctionRegion=ap-northeast-1"
            )
        );
    }

    #[test]
    fn read_public_supabase_config_from_env() {
        let dir = std::env::temp_dir().join(format!("bb-cloud-env-test-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".env");
        std::fs::write(&file, "SUPABASE_URL=https://example.supabase.co\nSUPABASE_PUBLISHABLE_KEY=sb_publishable_test\n").unwrap();
        let (url, key) = super::read_public_supabase_config(&file);
        assert_eq!(url.as_deref(), Some("https://example.supabase.co"));
        assert_eq!(key.as_deref(), Some("sb_publishable_test"));
        std::fs::remove_dir_all(dir).ok();
    }
}
