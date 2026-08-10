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

    pub fn allows_generation_provider(&self, provider: Option<&str>) -> bool {
        match provider.unwrap_or("codex") {
            "bowerbird-cloud" => self.can_use_cloud,
            _ => self.can_use_byo,
        }
    }

    pub fn understand_provider(&self, allow_cloud: bool) -> Option<&'static str> {
        if self.can_use_byo {
            Some("codex")
        } else if allow_cloud && self.can_use_cloud {
            Some("bowerbird-cloud")
        } else {
            None
        }
    }

    pub fn can_start_job(&self, running_count: usize) -> bool {
        running_count < self.max_parallel_jobs
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

    #[test]
    fn generation_provider_gate_distinguishes_cloud_and_byo() {
        let free = FeaturePolicy::free();
        let pro = FeaturePolicy::for_tier("pro");
        assert!(free.allows_generation_provider(Some("bowerbird-cloud")));
        assert!(!free.allows_generation_provider(Some("codex")));
        assert!(!free.allows_generation_provider(Some("jimeng")));
        assert!(pro.allows_generation_provider(Some("codex")));
        assert!(pro.allows_generation_provider(Some("jimeng")));
    }

    #[test]
    fn understand_route_and_parallel_limit_follow_policy() {
        let free = FeaturePolicy::free();
        let pro = FeaturePolicy::for_tier("pro");
        assert_eq!(free.understand_provider(true), Some("bowerbird-cloud"));
        assert_eq!(free.understand_provider(false), None);
        assert_eq!(pro.understand_provider(false), Some("codex"));
        assert!(free.can_start_job(0));
        assert!(!free.can_start_job(1));
        assert!(pro.can_start_job(3));
        assert!(!pro.can_start_job(4));
    }
}
