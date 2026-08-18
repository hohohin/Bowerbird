use std::path::PathBuf;
use std::sync::RwLock;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::cloud::{policy::FeaturePolicy, AuthClient, CloudClient};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreditBalance {
    pub daily: i32,
    pub sub: i32,
    pub topup: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreditTransaction {
    pub kind: String,
    pub amount: i32,
    pub service: Option<String>,
    pub created_at: chrono::DateTime<Utc>,
}

/// 云端动态生图档位（service_costs 带 label 的 image_* 行）：桌面下拉据此渲染，
/// 云端上新档位无需再发桌面包。空列表 = 云端未提供，前端用内置兜底。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GenerationService {
    pub service: String,
    pub label: String,
    pub credits: i32,
}

/// 远程 prompt 配置（Supabase prompt_configs 表 enabled 行，随权益快照下发）：
/// 桌面内置 agent 指令（如生成图命名）可云端热改，无需发版。
/// 缺 key / 离线 → 桌面用内置默认（约定：内置默认永远保留，远程只是覆盖）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptConfig {
    pub key: String,
    pub value: String,
    pub version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OfflineState {
    Fresh,
    Grace,
    Expired,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntitlementSnapshot {
    pub user_id: String,
    pub tier: String,
    pub balances: CreditBalance,
    pub policy: FeaturePolicy,
    #[serde(default)]
    pub recent_transactions: Vec<CreditTransaction>,
    #[serde(default)]
    pub generation_services: Vec<GenerationService>,
    #[serde(default)]
    pub prompt_configs: Vec<PromptConfig>,
    pub issued_at: DateTime<Utc>,
    pub refresh_after: DateTime<Utc>,
    pub grace_until: DateTime<Utc>,
    pub entitlement_version: i32,
    pub signature_version: i32,
    pub signature: Option<String>,
    #[serde(default = "Utc::now")]
    pub last_trusted_server_time: DateTime<Utc>,
    #[serde(skip)]
    pub offline_state: Option<OfflineState>,
}

impl EntitlementSnapshot {
    /// 按 key 取远程 prompt；值 trim 后为空视为未配置（调用方回落内置默认）。
    pub fn prompt_config(&self, key: &str) -> Option<&str> {
        self.prompt_configs
            .iter()
            .find(|c| c.key == key)
            .map(|c| c.value.trim())
            .filter(|v| !v.is_empty())
    }
}

pub struct EntitlementService {
    cloud: CloudClient,
    cache_path: PathBuf,
    snapshot: RwLock<Option<EntitlementSnapshot>>,
    online_trusted: RwLock<bool>,
}

impl EntitlementService {
    pub fn new(cloud: CloudClient, cache_path: PathBuf) -> Self {
        let snapshot = std::fs::read_to_string(&cache_path)
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok());
        Self {
            cloud,
            cache_path,
            snapshot: RwLock::new(snapshot),
            online_trusted: RwLock::new(false),
        }
    }

    pub fn current(&self, now: DateTime<Utc>) -> EntitlementSnapshot {
        let cached = self.snapshot.read().unwrap().clone();
        match cached {
            Some(mut value) => {
                let state = if *self.online_trusted.read().unwrap() && value.signature_version <= 0
                {
                    Self::evaluate_online(&value, now)
                } else {
                    Self::evaluate(&value, now)
                };
                if matches!(state, OfflineState::Expired | OfflineState::Invalid) {
                    value.tier = "free".into();
                    value.policy = FeaturePolicy::free();
                }
                value.offline_state = Some(state);
                value
            }
            None => Self::free_snapshot(now, OfflineState::Invalid),
        }
    }

    pub async fn sync(&self, auth: &AuthClient) -> AppResult<EntitlementSnapshot> {
        let endpoint = self
            .cloud
            .config()
            .endpoint("entitlement")
            .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
        let response = auth
            .send_authorized(self.cloud.http().get(endpoint), "同步权益失败")
            .await?;
        if !response.status().is_success() {
            return Err(AppError::Cloud(format!(
                "同步权益失败（HTTP {}）",
                response.status()
            )));
        }
        let mut snapshot: EntitlementSnapshot = response
            .json()
            .await
            .map_err(|error| AppError::Cloud(format!("解析权益响应失败: {error}")))?;
        // signature_version=0 intentionally cannot grant offline paid rights. It remains useful for
        // online UI while P3 signing is not configured.
        snapshot.last_trusted_server_time = snapshot.issued_at;
        snapshot.offline_state = Some(if snapshot.signature_version <= 0 {
            Self::evaluate_online(&snapshot, Utc::now())
        } else {
            Self::evaluate(&snapshot, Utc::now())
        });
        self.persist(&snapshot)?;
        *self.snapshot.write().unwrap() = Some(snapshot.clone());
        *self.online_trusted.write().unwrap() = true;
        Ok(snapshot)
    }

    /// 优先使用仍有效的本地权益；无可信缓存时在线同步一次。
    pub async fn current_or_sync(&self, auth: &AuthClient) -> EntitlementSnapshot {
        let current = self.current(Utc::now());
        if matches!(
            current.offline_state,
            Some(OfflineState::Fresh | OfflineState::Grace)
        ) {
            return current;
        }
        if !auth.snapshot().logged_in {
            return current;
        }
        self.sync(auth).await.unwrap_or(current)
    }

    pub fn clear(&self) -> AppResult<()> {
        *self.snapshot.write().unwrap() = None;
        *self.online_trusted.write().unwrap() = false;
        match std::fs::remove_file(&self.cache_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn evaluate(snapshot: &EntitlementSnapshot, now: DateTime<Utc>) -> OfflineState {
        // A server response without a verifiable signature is online-only and may never unlock
        // cached Pro/Studio rights after restart.
        if snapshot.signature_version <= 0 || snapshot.signature.as_deref().unwrap_or("").is_empty()
        {
            return OfflineState::Invalid;
        }
        if now + Duration::minutes(5) < snapshot.last_trusted_server_time {
            return OfflineState::Invalid;
        }
        if now <= snapshot.refresh_after {
            OfflineState::Fresh
        } else if now <= snapshot.grace_until {
            OfflineState::Grace
        } else {
            OfflineState::Expired
        }
    }

    fn evaluate_online(snapshot: &EntitlementSnapshot, now: DateTime<Utc>) -> OfflineState {
        if now + Duration::minutes(5) < snapshot.last_trusted_server_time {
            return OfflineState::Invalid;
        }
        if now <= snapshot.refresh_after {
            OfflineState::Fresh
        } else {
            OfflineState::Invalid
        }
    }

    fn persist(&self, snapshot: &EntitlementSnapshot) -> AppResult<()> {
        if let Some(parent) = self.cache_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(snapshot)?;
        std::fs::write(&self.cache_path, json)?;
        Ok(())
    }

    fn free_snapshot(now: DateTime<Utc>, state: OfflineState) -> EntitlementSnapshot {
        EntitlementSnapshot {
            user_id: String::new(),
            tier: "free".into(),
            balances: CreditBalance::default(),
            policy: FeaturePolicy::free(),
            recent_transactions: vec![],
            generation_services: vec![],
            prompt_configs: vec![],
            issued_at: now,
            refresh_after: now,
            grace_until: now,
            entitlement_version: 0,
            signature_version: 0,
            signature: None,
            last_trusted_server_time: now,
            offline_state: Some(state),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CreditBalance, EntitlementService, EntitlementSnapshot, OfflineState, PromptConfig};
    use crate::cloud::policy::FeaturePolicy;
    use chrono::{Duration, Utc};

    fn signed(now: chrono::DateTime<Utc>) -> EntitlementSnapshot {
        EntitlementSnapshot {
            user_id: "user".into(),
            tier: "pro".into(),
            balances: CreditBalance::default(),
            policy: FeaturePolicy::for_tier("pro"),
            recent_transactions: vec![],
            generation_services: vec![],
            prompt_configs: vec![],
            issued_at: now,
            refresh_after: now + Duration::hours(6),
            grace_until: now + Duration::days(7),
            entitlement_version: 1,
            signature_version: 1,
            signature: Some("test-signature".into()),
            last_trusted_server_time: now,
            offline_state: None,
        }
    }

    #[test]
    fn signed_snapshot_moves_fresh_grace_expired() {
        let now = Utc::now();
        let value = signed(now);
        assert_eq!(
            EntitlementService::evaluate(&value, now),
            OfflineState::Fresh
        );
        assert_eq!(
            EntitlementService::evaluate(&value, now + Duration::days(1)),
            OfflineState::Grace
        );
        assert_eq!(
            EntitlementService::evaluate(&value, now + Duration::days(8)),
            OfflineState::Expired
        );
    }

    #[test]
    fn unsigned_and_clock_rollback_are_invalid() {
        let now = Utc::now();
        let mut value = signed(now);
        value.signature_version = 0;
        value.signature = None;
        assert_eq!(
            EntitlementService::evaluate(&value, now),
            OfflineState::Invalid
        );
        let value = signed(now);
        assert_eq!(
            EntitlementService::evaluate(&value, now - Duration::hours(1)),
            OfflineState::Invalid
        );
    }

    #[test]
    fn unsigned_snapshot_is_online_only_until_refresh() {
        let now = Utc::now();
        let mut value = signed(now);
        value.signature_version = 0;
        value.signature = None;
        assert_eq!(
            EntitlementService::evaluate_online(&value, now),
            OfflineState::Fresh
        );
        assert_eq!(
            EntitlementService::evaluate_online(&value, now + Duration::hours(7)),
            OfflineState::Invalid
        );
    }

    #[test]
    fn prompt_config_lookup_falls_back_on_missing_or_blank() {
        let now = Utc::now();
        let mut value = signed(now);
        value.prompt_configs = vec![
            PromptConfig {
                key: "understand_autoname".into(),
                value: "云端命名指令".into(),
                version: 2,
            },
            PromptConfig {
                key: "blank".into(),
                value: "  ".into(),
                version: 1,
            },
        ];
        assert_eq!(
            value.prompt_config("understand_autoname"),
            Some("云端命名指令")
        );
        // 空 key / 空白值 → None，调用方回落内置默认。
        assert_eq!(value.prompt_config("blank"), None);
        assert_eq!(value.prompt_config("missing"), None);
    }

    #[test]
    fn snapshot_deserializes_without_prompt_configs_field() {
        // 旧缓存文件没有 prompt_configs 字段 → serde(default) 兜住，仍可用。
        let now = Utc::now();
        let json = serde_json::to_string(&signed(now)).unwrap();
        let parsed: EntitlementSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.prompt_config("understand_autoname"), None);
    }
}
