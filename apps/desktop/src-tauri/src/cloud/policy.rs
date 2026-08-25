use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeaturePolicy {
    pub can_use_byo: bool,
    pub can_use_cloud: bool,
    pub max_parallel_jobs: usize,
    pub understand_daily_limit: Option<u32>,
    pub can_use_priority_queue: bool,
    pub can_hd_export: bool,
    #[serde(default = "default_can_use_agent_runs")]
    pub can_use_agent_runs: bool,
    #[serde(default = "default_max_parallel_agent_runs")]
    pub max_parallel_agent_runs: usize,
    #[serde(default = "default_allowed_agent_skills")]
    pub allowed_agent_skills: Vec<String>,
    #[serde(default = "default_agent_budget_options")]
    pub agent_budget_options: Vec<String>,
}

fn default_can_use_agent_runs() -> bool {
    true
}

fn default_max_parallel_agent_runs() -> usize {
    1
}

fn default_allowed_agent_skills() -> Vec<String> {
    vec!["bowerbird-controlled-image-edit".into()]
}

fn default_agent_budget_options() -> Vec<String> {
    vec!["controlled-min".into(), "controlled-standard".into()]
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
                can_use_agent_runs: true,
                max_parallel_agent_runs: 4,
                allowed_agent_skills: default_allowed_agent_skills(),
                agent_budget_options: default_agent_budget_options(),
            },
            "pro" => Self {
                can_use_byo: true,
                can_use_cloud: true,
                max_parallel_jobs: 4,
                understand_daily_limit: None,
                can_use_priority_queue: false,
                can_hd_export: false,
                can_use_agent_runs: true,
                max_parallel_agent_runs: 2,
                allowed_agent_skills: default_allowed_agent_skills(),
                agent_budget_options: default_agent_budget_options(),
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
            can_use_agent_runs: true,
            max_parallel_agent_runs: 1,
            allowed_agent_skills: default_allowed_agent_skills(),
            agent_budget_options: default_agent_budget_options(),
        }
    }

    pub fn allows_generation_provider(&self, provider: Option<&str>) -> bool {
        match provider.unwrap_or("codex") {
            // Cloud 生图三档变体（bowerbird-cloud / -standard / -lite）同受 can_use_cloud 门控。
            p if p.starts_with("bowerbird-cloud") => self.can_use_cloud,
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

    pub fn allows_agent_run(&self, skill_id: &str) -> bool {
        self.can_use_agent_runs
            && self.max_parallel_agent_runs > 0
            && !self.agent_budget_options.is_empty()
            && self
                .allowed_agent_skills
                .iter()
                .any(|allowed| allowed == skill_id)
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
        assert!(policy.allows_agent_run("bowerbird-controlled-image-edit"));
    }

    #[test]
    fn pro_and_studio_unlock_only_existing_features() {
        let pro = FeaturePolicy::for_tier("pro");
        let studio = FeaturePolicy::for_tier("studio");
        assert!(pro.can_use_byo);
        assert!(studio.can_use_priority_queue);
        assert!(!pro.can_hd_export);
        assert!(!studio.can_hd_export);
        assert_eq!(pro.max_parallel_agent_runs, 2);
        assert_eq!(studio.max_parallel_agent_runs, 4);
    }

    #[test]
    fn generation_provider_gate_distinguishes_cloud_and_byo() {
        let free = FeaturePolicy::free();
        let pro = FeaturePolicy::for_tier("pro");
        assert!(free.allows_generation_provider(Some("bowerbird-cloud")));
        assert!(free.allows_generation_provider(Some("bowerbird-cloud-standard")));
        assert!(free.allows_generation_provider(Some("bowerbird-cloud-lite")));
        assert!(!free.allows_generation_provider(Some("codex")));
        assert!(!free.allows_generation_provider(Some("jimeng")));
        assert!(pro.allows_generation_provider(Some("codex")));
        assert!(pro.allows_generation_provider(Some("jimeng")));
        assert!(pro.allows_generation_provider(Some("bowerbird-cloud-lite")));
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

    #[test]
    fn agent_gate_requires_flag_skill_budget_and_capacity() {
        let mut policy = FeaturePolicy::free();
        assert!(policy.allows_agent_run("bowerbird-controlled-image-edit"));
        assert!(!policy.allows_agent_run("unlisted-skill"));
        policy.can_use_agent_runs = false;
        assert!(!policy.allows_agent_run("bowerbird-controlled-image-edit"));
        policy.can_use_agent_runs = true;
        policy.agent_budget_options.clear();
        assert!(!policy.allows_agent_run("bowerbird-controlled-image-edit"));
    }

    #[test]
    fn legacy_cached_policy_gets_compatible_agent_defaults() {
        let policy: FeaturePolicy = serde_json::from_value(serde_json::json!({
            "can_use_byo": false,
            "can_use_cloud": true,
            "max_parallel_jobs": 1,
            "understand_daily_limit": 10,
            "can_use_priority_queue": false,
            "can_hd_export": false
        }))
        .unwrap();
        assert!(policy.allows_agent_run("bowerbird-controlled-image-edit"));
        assert_eq!(policy.max_parallel_agent_runs, 1);
    }
}
