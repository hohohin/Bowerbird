use std::time::Duration;

use crate::cloud::config::CloudConfig;
use crate::error::AppError;

/// 共享云 HTTP client。构造本身不联网；只有显式业务调用才会发请求。
pub struct CloudClient {
    config: CloudConfig,
    http: reqwest::Client,
}

impl Clone for CloudClient {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            http: self.http.clone(),
        }
    }
}

impl CloudClient {
    pub fn new(config: CloudConfig) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| AppError::Other(format!("构建云 HTTP client 失败: {error}")))?;
        Ok(Self { config, http })
    }

    pub fn disabled() -> Result<Self, AppError> {
        Self::new(CloudConfig::disabled())
    }

    pub fn config(&self) -> &CloudConfig {
        &self.config
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
}
