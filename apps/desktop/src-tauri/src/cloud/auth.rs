use std::sync::{Arc, RwLock};

use base64::Engine;
use chrono::{DateTime, Utc};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::cloud::CloudClient;
use crate::error::{AppError, AppResult};

const KEYRING_SERVICE: &str = "com.bowerbird.desktop";
const KEYRING_USER: &str = "supabase-refresh-token";
const CALLBACK_PREFIX: &str = "bowerbird://auth/callback";

#[derive(Debug, Clone, Serialize)]
pub struct AuthSnapshot {
    pub cloud_available: bool,
    pub logged_in: bool,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub access_expires_at: Option<DateTime<Utc>>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    user: Option<AuthUser>,
}

#[derive(Debug, Clone, Deserialize)]
struct AuthUser {
    id: String,
    email: Option<String>,
}

#[derive(Debug, Clone)]
struct Session {
    access_token: String,
    user_id: Option<String>,
    email: Option<String>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct PendingPkce {
    state: String,
    verifier: String,
}

fn auth_error_detail(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    ["message", "msg", "error_description"]
        .into_iter()
        .find_map(|key| value.get(key)?.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn retry_seconds(retry_after: Option<&str>, detail: Option<&str>) -> Option<u64> {
    retry_after
        .and_then(|value| value.trim().parse().ok())
        .or_else(|| {
            detail?
                .split(|character: char| !character.is_ascii_digit())
                .find_map(|part| part.parse().ok())
        })
}

#[derive(Clone)]
pub struct AuthClient {
    inner: Arc<AuthInner>,
}

struct AuthInner {
    cloud: CloudClient,
    session: RwLock<Option<Session>>,
    pending: RwLock<Option<PendingPkce>>,
}

impl AuthClient {
    pub fn new(cloud: CloudClient) -> Self {
        Self {
            inner: Arc::new(AuthInner {
                cloud,
                session: RwLock::new(None),
                pending: RwLock::new(None),
            }),
        }
    }

    pub fn snapshot(&self) -> AuthSnapshot {
        let session = self.inner.session.read().unwrap();
        let cloud_available = self.inner.cloud.config().is_available();
        match session.as_ref() {
            Some(value) => AuthSnapshot {
                cloud_available,
                logged_in: true,
                user_id: value.user_id.clone(),
                email: value.email.clone(),
                access_expires_at: Some(value.expires_at),
                reason: None,
            },
            None => AuthSnapshot {
                cloud_available,
                logged_in: false,
                user_id: None,
                email: None,
                access_expires_at: None,
                reason: Some(if cloud_available {
                    "未登录 Bowerbird 账号".into()
                } else {
                    "当前版本未配置 Bowerbird Cloud".into()
                }),
            },
        }
    }

    /// 请求 Magic Link。返回值只用于 UI 提示；真正授权链接由 Supabase 邮件发送。
    pub async fn start_email_login(&self, email: &str) -> AppResult<()> {
        let email = email.trim();
        if !email.contains('@') || email.len() > 320 {
            return Err(AppError::Cloud("请输入有效邮箱".into()));
        }
        let config = self.inner.cloud.config();
        let base = config
            .supabase_url
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::Cloud("Supabase URL 未配置".into()))?;
        let anon = config
            .supabase_publishable_key
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::Cloud("Supabase publishable key 未配置".into()))?;

        let verifier = format!("{}{}", Ulid::new(), Ulid::new());
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let state = Ulid::new().to_string();
        *self.inner.pending.write().unwrap() = Some(PendingPkce {
            state: state.clone(),
            verifier,
        });

        let callback = format!("{CALLBACK_PREFIX}?state={state}");
        let mut otp_url =
            reqwest::Url::parse(&format!("{}/auth/v1/otp", base.trim_end_matches('/')))
                .map_err(|_| AppError::Cloud("Supabase URL 无效".into()))?;
        otp_url
            .query_pairs_mut()
            .append_pair("redirect_to", &callback);
        let response = self.inner.cloud
            .http()
            .post(otp_url)
            .header("apikey", anon)
            .json(&serde_json::json!({
                "email": email,
                "create_user": true,
                "code_challenge_method": "s256",
                "code_challenge": challenge,
            }))
            .send()
            .await
            .map_err(|error| AppError::Cloud(format!("发送登录邮件失败: {error}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let body = response.text().await.unwrap_or_default();
            let detail = auth_error_detail(&body);
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let message = match retry_seconds(retry_after.as_deref(), detail.as_deref()) {
                    Some(seconds) => format!("登录邮件发送过于频繁，请 {seconds} 秒后重试"),
                    None => "登录邮件发送已触发 Supabase 限流；内置邮件服务最多 2 封/小时，请等待额度恢复或配置自定义 SMTP".into(),
                };
                return Err(AppError::Cloud(message));
            }
            return Err(AppError::Cloud(format!(
                "发送登录邮件失败（HTTP {status}{}）",
                detail.map(|value| format!("：{value}")).unwrap_or_default()
            )));
        }
        Ok(())
    }

    pub async fn handle_callback(&self, callback: &str) -> AppResult<AuthSnapshot> {
        let parsed = reqwest::Url::parse(callback)
            .map_err(|_| AppError::Cloud("登录回调 URL 无效".into()))?;
        if parsed.scheme() != "bowerbird"
            || parsed.host_str() != Some("auth")
            || parsed.path() != "/callback"
        {
            return Err(AppError::Cloud("拒绝非 Bowerbird 登录回调".into()));
        }
        let params: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        let code = params
            .get("code")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Cloud("登录回调缺少 code".into()))?;
        let callback_state = params
            .get("state")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Cloud("登录回调缺少 state".into()))?;
        let pending = self.inner.pending
            .write()
            .unwrap()
            .take()
            .ok_or_else(|| AppError::Cloud("登录请求已过期，请重新发起".into()))?;
        if pending.state != *callback_state {
            return Err(AppError::Cloud("登录回调 state 不匹配".into()));
        }
        let token = self.exchange_code(code, &pending.verifier).await?;
        self.store_session(token)?;
        Ok(self.snapshot())
    }

    pub async fn restore(&self) -> AppResult<AuthSnapshot> {
        let refresh_token = match Self::keyring_entry()?.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(self.snapshot()),
            Err(error) => return Err(AppError::Cloud(format!("读取系统凭据失败: {error}"))),
        };
        let token = self.refresh_with(&refresh_token).await?;
        self.store_session(token)?;
        Ok(self.snapshot())
    }

    pub async fn access_token(&self) -> AppResult<String> {
        let should_refresh = self.inner.session
            .read()
            .unwrap()
            .as_ref()
            .map(|session| session.expires_at <= Utc::now() + chrono::Duration::seconds(60))
            .unwrap_or(true);
        if should_refresh {
            self.restore().await?;
        }
        self.inner.session
            .read()
            .unwrap()
            .as_ref()
            .map(|session| session.access_token.clone())
            .ok_or_else(|| AppError::Cloud("请先登录 Bowerbird 账号".into()))
    }

    pub fn logout(&self) -> AppResult<AuthSnapshot> {
        *self.inner.session.write().unwrap() = None;
        *self.inner.pending.write().unwrap() = None;
        match Self::keyring_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(self.snapshot()),
            Err(error) => Err(AppError::Cloud(format!("清除系统凭据失败: {error}"))),
        }
    }

    async fn exchange_code(&self, code: &str, verifier: &str) -> AppResult<TokenResponse> {
        self.token_request(
            "pkce",
            serde_json::json!({ "auth_code": code, "code_verifier": verifier }),
        )
        .await
    }

    async fn refresh_with(&self, refresh_token: &str) -> AppResult<TokenResponse> {
        self.token_request(
            "refresh_token",
            serde_json::json!({ "refresh_token": refresh_token }),
        )
        .await
    }

    async fn token_request(
        &self,
        grant: &str,
        body: serde_json::Value,
    ) -> AppResult<TokenResponse> {
        let config = self.inner.cloud.config();
        let base = config
            .supabase_url
            .as_deref()
            .ok_or_else(|| AppError::Cloud("Supabase URL 未配置".into()))?;
        let anon = config
            .supabase_publishable_key
            .as_deref()
            .ok_or_else(|| AppError::Cloud("Supabase publishable key 未配置".into()))?;
        let response = self.inner.cloud
            .http()
            .post(format!(
                "{}/auth/v1/token?grant_type={grant}",
                base.trim_end_matches('/')
            ))
            .header("apikey", anon)
            .json(&body)
            .send()
            .await
            .map_err(|error| AppError::Cloud(format!("刷新登录失败: {error}")))?;
        if !response.status().is_success() {
            return Err(AppError::Cloud("登录已失效，请重新登录".into()));
        }
        response
            .json()
            .await
            .map_err(|error| AppError::Cloud(format!("解析登录响应失败: {error}")))
    }

    fn store_session(&self, token: TokenResponse) -> AppResult<()> {
        Self::keyring_entry()?
            .set_password(&token.refresh_token)
            .map_err(|error| AppError::Cloud(format!("写入系统凭据失败: {error}")))?;
        *self.inner.session.write().unwrap() = Some(Session {
            access_token: token.access_token,
            user_id: token.user.as_ref().map(|user| user.id.clone()),
            email: token.user.and_then(|user| user.email),
            expires_at: Utc::now() + chrono::Duration::seconds(token.expires_in.max(60)),
        });
        Ok(())
    }

    fn keyring_entry() -> AppResult<Entry> {
        Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|error| AppError::Cloud(format!("打开系统凭据库失败: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::{auth_error_detail, retry_seconds, AuthClient, PendingPkce};
    use crate::cloud::{config::CloudConfig, CloudClient};

    fn client() -> AuthClient {
        AuthClient::new(
            CloudClient::new(CloudConfig {
                supabase_url: Some("https://example.supabase.co".into()),
                supabase_publishable_key: Some("sb_publishable_test".into()),
            })
            .unwrap(),
        )
    }

    #[test]
    fn parses_auth_rate_limit_wait() {
        let detail = auth_error_detail(
            r#"{"code":"over_email_send_rate_limit","message":"For security purposes, you can only request this after 47 seconds."}"#,
        );
        assert_eq!(detail.as_deref(), Some("For security purposes, you can only request this after 47 seconds."));
        assert_eq!(retry_seconds(None, detail.as_deref()), Some(47));
        assert_eq!(retry_seconds(Some("12"), detail.as_deref()), Some(12));
    }

    #[tokio::test]
    async fn callback_rejects_wrong_scheme_before_network() {
        let auth = client();
        *auth.inner.pending.write().unwrap() = Some(PendingPkce {
            state: "state".into(),
            verifier: "verifier".into(),
        });
        let error = auth
            .handle_callback("https://auth/callback?code=x&state=state")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("非 Bowerbird"));
    }

    #[tokio::test]
    async fn callback_rejects_mismatched_state_before_network() {
        let auth = client();
        *auth.inner.pending.write().unwrap() = Some(PendingPkce {
            state: "expected".into(),
            verifier: "verifier".into(),
        });
        let error = auth
            .handle_callback("bowerbird://auth/callback?code=x&state=wrong")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("state 不匹配"));
    }
}
