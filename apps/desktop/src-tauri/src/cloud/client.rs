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
            // 单次 Cloud create/get 与签名产物下载的总保护。图片生成本身已由 VPS
            // 持久任务承接，不再把这个 HTTP client timeout 当作方舟生成 deadline。
            .timeout(Duration::from_secs(180))
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
