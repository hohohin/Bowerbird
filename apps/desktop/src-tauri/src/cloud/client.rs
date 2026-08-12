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
            // Vision 主动在 110s 终止、Edge 在 120s 兜底；额外时间用于计费回滚和返回具体错误。
            .timeout(Duration::from_secs(145))
            .build()
            .map_err(|error| AppError::Other(format!("构建云 HTTP client 失败: {error}")))?;
        Ok(Self { config, http })
    }

    pub fn config(&self) -> &CloudConfig {
        &self.config
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
}
