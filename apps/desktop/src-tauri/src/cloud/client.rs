use std::time::Duration;

use crate::cloud::config::CloudConfig;
use crate::error::AppError;

/// Preserve transport causes without exposing login state or authorization URLs.
pub(crate) fn request_error(context: &str, error: reqwest::Error) -> AppError {
    use std::error::Error;

    let kind = if error.is_timeout() {
        "请求超时"
    } else if error.is_connect() {
        "连接未建立"
    } else {
        "请求未完成"
    };
    let error = error.without_url();
    let mut detail = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    AppError::Cloud(format!("{context}（{kind}）: {detail}"))
}

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

#[cfg(test)]
mod tests {
    use super::request_error;
    use std::error::Error;
    use std::time::Duration;

    #[tokio::test]
    async fn connection_error_preserves_cause_without_login_url() {
        // Reserve a local TCP port without listening; connection must be refused.
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let url = format!(
            "http://{}/wechat-login?state=dt_private&code=private_code",
            socket.local_addr().unwrap()
        );
        let error = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap_err();
        assert!(error.is_connect());
        let mut cause: &dyn Error = &error;
        while let Some(next) = cause.source() {
            cause = next;
        }
        let root = cause.to_string();
        let message = request_error("连接微信登录服务失败", error).to_string();
        assert!(message.contains("连接未建立"));
        assert!(message.contains(&root));
        assert!(!message.contains("dt_private"));
        assert!(!message.contains("private_code"));
        assert!(!message.contains("http://"));
    }

    #[tokio::test]
    async fn response_timeout_preserves_timeout_classification() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let request = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!(
                "http://{}/?state=dt_private",
                listener.local_addr().unwrap()
            ))
            .timeout(Duration::from_millis(150))
            .send();
        let server = async {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            drop(stream);
        };
        let (response, _) = tokio::join!(request, server);
        let error = response.unwrap_err();
        assert!(error.is_timeout());
        let message = request_error("连接微信登录服务失败", error).to_string();
        assert!(message.contains("请求超时"));
        assert!(!message.contains("dt_private"));
    }
}
