use std::path::PathBuf;
use std::sync::RwLock;

use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::Verifier as _;
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
    #[serde(default)]
    pub meta: Option<CreditTransactionMeta>,
    pub created_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreditTransactionMeta {
    pub entity_type: String,
    pub run_id: String,
    pub skill_id: String,
    pub final_status: String,
    pub actual_credits: i32,
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
    /// 测试账号标记（raw_app_meta_data.bowerbird_test，与 A8-T1 小流量门控同源）：
    /// 只决定桌面「设置 · 开发者选项」可见性，不参与付费门控，也不进签名载荷。
    #[serde(default)]
    pub is_test_account: bool,
    #[serde(default = "Utc::now")]
    pub last_trusted_server_time: DateTime<Utc>,
    #[serde(skip)]
    pub offline_state: Option<OfflineState>,
    /// 签名是否已通过内置公钥的 Ed25519 验签（加载/同步时计算，不持久化；
    /// 离线宽限只信任 signature_version>=1 且此标记为真的快照）。
    #[serde(skip)]
    pub signature_valid: bool,
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
        // 缓存可能在两次启动之间被篡改：v1 快照加载时必须重新验签。
        let snapshot = std::fs::read_to_string(&cache_path)
            .ok()
            .and_then(|json| serde_json::from_str::<EntitlementSnapshot>(&json).ok())
            .map(|mut value| {
                value.signature_valid = Self::verify_signature(&value);
                if value.signature_version >= 1 && !value.signature_valid {
                    tracing::warn!(
                        "cached entitlement signature failed verification; offline paid rights disabled"
                    );
                }
                value
            });
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
        // v1 响应必须通过内置公钥验签才可作为离线可信凭证；验签失败（或本构建未
        // 内置公钥）时降级为 v0 在线可信，与历史 unsigned 行为一致，不中断在线使用。
        snapshot.signature_valid = Self::verify_signature(&snapshot);
        if snapshot.signature_version >= 1 && !snapshot.signature_valid {
            tracing::warn!(
                "entitlement signature verification failed; snapshot stays online-trusted only"
            );
            snapshot.signature_version = 0;
            snapshot.signature = None;
        }
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
        // Offline paid rights require a snapshot whose signature passed Ed25519 verification
        // against the built-in public key; mere presence of a signature string is not trust.
        if snapshot.signature_version <= 0 || !snapshot.signature_valid {
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

    /// 内置 Ed25519 验签公钥（base64 原始 32 字节，构建期由 build.rs 注入）。
    /// 未注入的构建不启用离线宽限验签；在线权益不受影响。
    fn builtin_verifying_key() -> Option<ed25519_dalek::VerifyingKey> {
        let encoded = option_env!("BOWERBIRD_ENTITLEMENT_PUBKEY")?.trim();
        if encoded.is_empty() {
            return None;
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()?;
        let bytes: [u8; 32] = decoded.try_into().ok()?;
        ed25519_dalek::VerifyingKey::from_bytes(&bytes).ok()
    }

    fn verify_signature(snapshot: &EntitlementSnapshot) -> bool {
        match Self::builtin_verifying_key() {
            Some(key) => Self::verify_signature_with(&key, snapshot),
            None => false,
        }
    }

    fn verify_signature_with(
        key: &ed25519_dalek::VerifyingKey,
        snapshot: &EntitlementSnapshot,
    ) -> bool {
        let Some(encoded) = snapshot.signature.as_deref() else {
            return false;
        };
        let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            return false;
        };
        let Ok(signature) = ed25519_dalek::Signature::from_slice(&raw) else {
            return false;
        };
        key.verify(Self::signing_payload(snapshot).as_bytes(), &signature)
            .is_ok()
    }

    /// 与 Edge `_shared/entitlement-signing.ts` 逐字节一致的规范化签名载荷：
    /// 键排序 + 无空白 JSON；时间字段按 toISOString 的毫秒精度格式化。
    fn signing_payload(snapshot: &EntitlementSnapshot) -> String {
        let value = serde_json::json!({
            "v": 1,
            "user_id": snapshot.user_id,
            "tier": snapshot.tier,
            "balances": {
                "daily": snapshot.balances.daily,
                "sub": snapshot.balances.sub,
                "topup": snapshot.balances.topup,
            },
            "policy": serde_json::to_value(&snapshot.policy).unwrap_or(serde_json::Value::Null),
            "generation_services": snapshot
                .generation_services
                .iter()
                .map(|service| serde_json::json!({
                    "service": service.service,
                    "label": service.label,
                    "credits": service.credits,
                }))
                .collect::<Vec<_>>(),
            "prompt_configs": snapshot
                .prompt_configs
                .iter()
                .map(|config| serde_json::json!({
                    "key": config.key,
                    "value": config.value,
                    "version": config.version,
                }))
                .collect::<Vec<_>>(),
            "issued_at": format_iso_ms(snapshot.issued_at),
            "refresh_after": format_iso_ms(snapshot.refresh_after),
            "grace_until": format_iso_ms(snapshot.grace_until),
            "entitlement_version": snapshot.entitlement_version,
        });
        canonical_json(&value)
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
            is_test_account: false,
            last_trusted_server_time: now,
            offline_state: Some(state),
            signature_valid: false,
        }
    }
}

/// 键递归排序、无空白的规范化 JSON 序列化（与 Edge canonicalJson 逐字节一致）。
fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(*key).unwrap_or_default(),
                        canonical_json(&map[*key])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        serde_json::Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", body.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// toISOString 等价的毫秒精度 RFC3339（Z 后缀），保证两侧时间字段字节一致。
fn format_iso_ms(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_json, CreditBalance, EntitlementService, EntitlementSnapshot, GenerationService,
        OfflineState, PromptConfig,
    };
    use crate::cloud::policy::FeaturePolicy;
    use base64::Engine as _;
    use chrono::{Duration, TimeZone, Utc};

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
            is_test_account: false,
            last_trusted_server_time: now,
            offline_state: None,
            signature_valid: true,
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
        value.signature_valid = false;
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
    fn signature_presence_without_verification_is_not_trusted() {
        // 防回归：仅存在签名字符串（旧 evaluate 行为）不再授予离线权益，
        // 必须经过内置公钥验签（signature_valid）。
        let now = Utc::now();
        let mut value = signed(now);
        value.signature_valid = false;
        assert_eq!(
            EntitlementService::evaluate(&value, now),
            OfflineState::Invalid
        );
    }

    #[test]
    fn unsigned_snapshot_is_online_only_until_refresh() {
        let now = Utc::now();
        let mut value = signed(now);
        value.signature_version = 0;
        value.signature = None;
        value.signature_valid = false;
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

    #[test]
    fn snapshot_deserializes_test_account_marker() {
        let now = Utc::now();
        let mut marked = signed(now);
        marked.is_test_account = true;
        let parsed: EntitlementSnapshot =
            serde_json::from_str(&serde_json::to_string(&marked).unwrap()).unwrap();
        assert!(parsed.is_test_account);
        // 旧快照无该字段 → false；且不进签名载荷（vector 载荷已锁定无此键）。
        let legacy = signed(now);
        let parsed: EntitlementSnapshot =
            serde_json::from_str(&serde_json::to_string(&legacy).unwrap()).unwrap();
        assert!(!parsed.is_test_account);
        assert!(!EntitlementService::signing_payload(&marked).contains("is_test_account"));
    }

    // ===== 跨语言签名向量（与 _shared/entitlement-signing_test.ts 同源同值）=====

    const VECTOR_PUBKEY: &str = "B2OHhR/upisHvHFZtRtUlsshBWdgPrZlE+f834lf7Yg=";
    const VECTOR_SIGNATURE: &str =
        "FpKmT6I4a1UC6VVXMzgKiWUVjP99FEva91aq+O7iFUQOD4RSWeSECP8Rx+vNdaUgD3WwxkA7NuHocrGReTenBg==";
    const VECTOR_PAYLOAD: &str = r#"{"balances":{"daily":12,"sub":340,"topup":0},"entitlement_version":2,"generation_services":[{"credits":5,"label":"Pro 高质量","service":"image_pro"},{"credits":1,"label":"Lite 极速","service":"image_lite"}],"grace_until":"2026-09-03T08:00:00.000Z","issued_at":"2026-08-27T08:00:00.000Z","policy":{"agent_budget_options":["controlled-min","controlled-standard"],"allowed_agent_skills":["bowerbird-controlled-image-edit"],"can_hd_export":false,"can_use_agent_runs":true,"can_use_byo":true,"can_use_cloud":true,"can_use_priority_queue":false,"can_use_visual_profiles":true,"max_parallel_agent_runs":2,"max_parallel_jobs":4,"understand_daily_limit":null},"prompt_configs":[{"key":"understand_autoname","value":"给这张图取名\n第二行描述","version":3}],"refresh_after":"2026-08-27T14:00:00.000Z","tier":"pro","user_id":"11111111-2222-3333-4444-555555555555","v":1}"#;

    fn vector_snapshot() -> EntitlementSnapshot {
        let time = |s: &str| {
            chrono::DateTime::parse_from_rfc3339(s)
                .unwrap()
                .with_timezone(&Utc)
        };
        EntitlementSnapshot {
            user_id: "11111111-2222-3333-4444-555555555555".into(),
            tier: "pro".into(),
            balances: CreditBalance {
                daily: 12,
                sub: 340,
                topup: 0,
            },
            policy: FeaturePolicy::for_tier("pro"),
            recent_transactions: vec![],
            generation_services: vec![
                GenerationService {
                    service: "image_pro".into(),
                    label: "Pro 高质量".into(),
                    credits: 5,
                },
                GenerationService {
                    service: "image_lite".into(),
                    label: "Lite 极速".into(),
                    credits: 1,
                },
            ],
            prompt_configs: vec![PromptConfig {
                key: "understand_autoname".into(),
                value: "给这张图取名\n第二行描述".into(),
                version: 3,
            }],
            issued_at: time("2026-08-27T08:00:00.000Z"),
            refresh_after: time("2026-08-27T14:00:00.000Z"),
            grace_until: time("2026-09-03T08:00:00.000Z"),
            entitlement_version: 2,
            signature_version: 1,
            signature: Some(VECTOR_SIGNATURE.into()),
            is_test_account: false,
            last_trusted_server_time: time("2026-08-27T08:00:00.000Z"),
            offline_state: None,
            signature_valid: false,
        }
    }

    fn vector_key() -> ed25519_dalek::VerifyingKey {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(VECTOR_PUBKEY)
            .unwrap();
        ed25519_dalek::VerifyingKey::from_bytes(&raw.try_into().unwrap()).unwrap()
    }

    #[test]
    fn signing_payload_matches_edge_canonical_vector() {
        assert_eq!(
            EntitlementService::signing_payload(&vector_snapshot()),
            VECTOR_PAYLOAD
        );
    }

    #[test]
    fn vector_signature_verifies_and_tampering_fails() {
        let key = vector_key();
        let mut snapshot = vector_snapshot();
        assert!(EntitlementService::verify_signature_with(&key, &snapshot));
        // 篡改任一门控字段（tier）→ 验签失败。
        snapshot.tier = "studio".into();
        assert!(!EntitlementService::verify_signature_with(&key, &snapshot));
        // 篡改时间字段同样失效。
        let mut tampered = vector_snapshot();
        tampered.grace_until = tampered.grace_until + Duration::days(30);
        assert!(!EntitlementService::verify_signature_with(&key, &tampered));
        // 无签名 / 非法 base64 / 非法签名长度均安全失败。
        let mut none = vector_snapshot();
        none.signature = None;
        assert!(!EntitlementService::verify_signature_with(&key, &none));
        let mut garbage = vector_snapshot();
        garbage.signature = Some("not-base64!!".into());
        assert!(!EntitlementService::verify_signature_with(&key, &garbage));
    }

    #[test]
    fn canonical_json_sorts_keys_and_matches_scalar_forms() {
        let value = serde_json::json!({"b": {"d": 1, "a": null}, "a": [true, "x"]});
        assert_eq!(
            canonical_json(&value),
            r#"{"a":[true,"x"],"b":{"a":null,"d":1}}"#
        );
        // 中文不转义（与 JS JSON.stringify 一致）。
        assert_eq!(
            canonical_json(&serde_json::json!({"中": "文"})),
            "{\"中\":\"文\"}"
        );
    }
}
