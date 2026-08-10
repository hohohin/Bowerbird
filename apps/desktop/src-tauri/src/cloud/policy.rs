use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeaturePolicy {
    pub can_use_byo: bool,
    pub can_use_cloud: bool,
    pub max_parallel_jobs: usize,
    pub understand_daily_limit: Option<u32>,
    pub can_use_priority_queue: bool,
    pub can_hd_export: bool,
}

impl FeaturePolicy {
    pub fn for_tier(tier: &str) -> Self {
        match tier {
            "studio" => Self {
                can_use_byo: true,
                can_use_cloud: true,
                max_parallel_jobs: 8,
                understand_daily_limit: None,
                can_use_priority_queue: true,
                can_hd_export: false,
            },
            "pro" => Self {
                can_use_byo: true,
                can_use_cloud: true,
                max_parallel_jobs: 4,
                understand_daily_limit: None,
                can_use_priority_queue: false,
                can_hd_export: false,
            },
            _ => Self::free(),
        }
    }

    pub fn free() -> Self {
        Self {
            can_use_byo: false,
            can_use_cloud: true,
            max_parallel_jobs: 1,
            understand_daily_limit: Some(10),
            can_use_priority_queue: false,
            can_hd_export: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::FeaturePolicy;

    #[test]
    fn free_never_unlocks_byo() {
        let policy = FeaturePolicy::for_tier("free");
        assert!(!policy.can_use_byo);
        assert_eq!(policy.max_parallel_jobs, 1);
        assert_eq!(policy.understand_daily_limit, Some(10));
    }

    #[test]
    fn pro_and_studio_unlock_only_existing_features() {
        let pro = FeaturePolicy::for_tier("pro");
        let studio = FeaturePolicy::for_tier("studio");
        assert!(pro.can_use_byo);
        assert!(studio.can_use_priority_queue);
        assert!(!pro.can_hd_export);
        assert!(!studio.can_hd_export);
    }
}
