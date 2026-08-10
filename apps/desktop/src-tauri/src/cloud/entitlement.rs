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

pub struct EntitlementService {
    cloud: CloudClient,
    cache_path: PathBuf,
    snapshot: RwLock<Option<EntitlementSnapshot>>,
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
        }
    }

    pub fn current(&self, now: DateTime<Utc>) -> EntitlementSnapshot {
        let cached = self.snapshot.read().unwrap().clone();
        match cached {
            Some(mut value) => {
                let state = Self::evaluate(&value, now);
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
        let token = auth.access_token().await?;
        let endpoint = self
            .cloud
            .config()
            .endpoint("entitlement")
            .ok_or_else(|| AppError::Cloud("Bowerbird Cloud 未启用或端点未配置".into()))?;
        let response = self
            .cloud
            .http()
            .get(endpoint)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| AppError::Cloud(format!("同步权益失败: {error}")))?;
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
        snapshot.offline_state = Some(Self::evaluate(&snapshot, Utc::now()));
        self.persist(&snapshot)?;
        *self.snapshot.write().unwrap() = Some(snapshot.clone());
        Ok(snapshot)
    }

    pub fn clear(&self) -> AppResult<()> {
        *self.snapshot.write().unwrap() = None;
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
    use super::{CreditBalance, EntitlementService, EntitlementSnapshot, OfflineState};
    use crate::cloud::policy::FeaturePolicy;
    use chrono::{Duration, Utc};

    fn signed(now: chrono::DateTime<Utc>) -> EntitlementSnapshot {
        EntitlementSnapshot {
            user_id: "user".into(),
            tier: "pro".into(),
            balances: CreditBalance::default(),
            policy: FeaturePolicy::for_tier("pro"),
            recent_transactions: vec![],
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
}
