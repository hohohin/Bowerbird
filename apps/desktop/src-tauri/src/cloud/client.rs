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
            // 上游最长等待 140s；请求上传、Edge 冷启动、计费预授权/回滚与响应下载都在
            // reqwest 的总超时内。与真实 E2E 的 180s 包络对齐，避免客户端先于 Edge
            // 返回稳定的 upstream_timeout/rollback 结果而断开。
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
