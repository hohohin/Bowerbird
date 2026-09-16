//! 应用设置持久化：存为 JSON 文件（不在 SQLite 里），启动时读取，写入时全量覆盖。
//! - 默认值在 AppSettings::default() 里定义。
//! - 多线程读通过 RwLock；Tauri command 直接操作 State<SettingsState>。

use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// 自动命名与基础描述模板；分类由独立本地模型处理。
pub const DEFAULT_AUTO_ANALYZE_PROMPT: &str = "请描述这张图片并取名。严格按照以下格式回复：\
 第一行只回复命名本身，不要有标点符号；\
 第二行起回复图片的描述。不需要输出分类标签。";

fn default_auto_analyze_prompt() -> String {
    DEFAULT_AUTO_ANALYZE_PROMPT.to_string()
}

/// 即梦 dreamina CLI 默认模型版本（`--model_version`）。CLI 原生默认 5.0，
/// Bowerbird 改用 5.0Pro 起步（AI-PROVIDERS.md 开放问题 3 的决策反转）。
pub const DEFAULT_DREAMINA_MODEL_VERSION: &str = "5.0Pro";

fn default_dreamina_model_version() -> String {
    DEFAULT_DREAMINA_MODEL_VERSION.to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppTheme {
    #[default]
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// 应用外观。新配置及未设置主题的旧配置默认日间；保留已保存的主题选择。
    #[serde(default)]
    pub theme: AppTheme,

    /// 入库时自动反推 + 自动重命名
    #[serde(default)]
    pub auto_analyze_on_ingest: bool,

    /// 自动命名与基础描述的提示词。
    #[serde(default = "default_auto_analyze_prompt")]
    pub auto_analyze_prompt: String,

    /// 自定义素材库根目录（images/thumbnails/library.db 所在地）；None = 应用数据目录。
    /// 由「迁移素材库位置」写入；仅存指向，文件体量很小，可留在 C 盘。
    #[serde(default)]
    pub library_root: Option<String>,

    /// 入库自动理解是否允许把新图片临时发送到 Bowerbird Cloud。默认 false，必须显式开启。
    #[serde(default)]
    pub cloud_auto_understand: bool,

    /// 创作板打开时，引入参考素材是否需要 Shift+左键（防误触）。默认 false = 直接左键引入。
    #[serde(default)]
    pub board_shift_pick: bool,

    /// 全局素材视图中隐藏已加入任一项目的素材（瀑布流只显示未入项目的素材）。默认 false。
    #[serde(default)]
    pub hide_project_assets: bool,

    /// 在画板图片和视频下方显示素材名称；旧设置默认隐藏。
    #[serde(default)]
    pub canvas_show_asset_names: bool,

    /// 生成成功时的应用内弹窗与提示音，可分别关闭；旧配置默认开启。
    #[serde(default = "default_true")]
    pub generation_completion_popup: bool,
    #[serde(default = "default_true")]
    pub generation_completion_sound: bool,

    /// 首启预置示例图是否已注入完成。true = 不再重灌（配合 count_assets==0 双 gate）。
    #[serde(default)]
    pub samples_seeded: bool,

    /// 即梦 dreamina CLI 出图所用模型版本（text2image: 3.0~5.0Pro；image2image 仅 4.0+）。
    /// 每次生成前经 resolve_gen_provider 读取，改设置即热生效（无需重启）。
    #[serde(default = "default_dreamina_model_version")]
    pub dreamina_model_version: String,

    // —— 开发者选项（设置 · 开发者选项，仅测试账号可见）：对话框 Agent 模式开关。
    //    默认只开正式 Agent；关闭的模式不在创作板 / 会话编辑坞对话框渲染。
    /// 「Agent」：正式 Bowerbird Agent（云端 Run：意图分析 → 计划审批 → 执行）。默认开启。
    #[serde(default = "default_true")]
    pub agent_mode_enabled: bool,
    /// 「Agent A」（dev 方案A：子句挑选）开关，默认关闭。
    #[serde(default)]
    pub agent_a_mode_enabled: bool,
    /// 「Agent B」（dev 方案B：skill 审查修复）开关，默认关闭。
    #[serde(default)]
    pub agent_b_mode_enabled: bool,
    /// 「Agent Z」（dev：投递 Claude Code 终端）开关，默认关闭。
    #[serde(default)]
    pub agent_z_mode_enabled: bool,
    /// 「Agent G」（dev：投递 codex 终端）开关，默认关闭。
    #[serde(default)]
    pub agent_g_mode_enabled: bool,
    /// 「Agent DS」（dev：DeepSeek 对话 harness）开关，默认关闭。
    #[serde(default)]
    pub agent_ds_mode_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: AppTheme::Light,
            auto_analyze_on_ingest: false,
            auto_analyze_prompt: DEFAULT_AUTO_ANALYZE_PROMPT.to_string(),
            library_root: None,
            cloud_auto_understand: false,
            board_shift_pick: false,
            hide_project_assets: false,
            canvas_show_asset_names: false,
            generation_completion_popup: true,
            generation_completion_sound: true,
            samples_seeded: false,
            dreamina_model_version: DEFAULT_DREAMINA_MODEL_VERSION.to_string(),
            agent_mode_enabled: true,
            agent_a_mode_enabled: false,
            agent_b_mode_enabled: false,
            agent_z_mode_enabled: false,
            agent_g_mode_enabled: false,
            agent_ds_mode_enabled: false,
        }
    }
}

/// Tauri 管理的设置状态：内存读写 + 文件持久化。
pub struct SettingsState {
    settings: RwLock<AppSettings>,
    path: PathBuf,
}

impl SettingsState {
    /// 从 settings.json 加载；文件不存在则用默认值。
    pub fn init(path: PathBuf) -> AppResult<Self> {
        let (settings, had_legacy_cloud_fields) = if path.exists() {
            let json = std::fs::read_to_string(&path)?;
            let value: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
            let had_legacy = value.as_object().is_some_and(|object| {
                [
                    "cloud_enabled",
                    "cloud_supabase_url",
                    "cloud_supabase_publishable_key",
                    "cloud_supabase_anon_key",
                    "cloud_mock",
                ]
                .iter()
                .any(|key| object.contains_key(*key))
            });
            (
                serde_json::from_value(value).unwrap_or_default(),
                had_legacy,
            )
        } else {
            (AppSettings::default(), false)
        };
        if had_legacy_cloud_fields {
            std::fs::write(&path, serde_json::to_string_pretty(&settings)?)?;
        }
        Ok(Self {
            settings: RwLock::new(settings),
            path,
        })
    }

    /// 获取当前设置快照。
    pub fn get(&self) -> AppSettings {
        self.settings.read().unwrap().clone()
    }

    /// 全量覆盖设置并持久化到文件。
    pub fn update(&self, new_settings: AppSettings) -> AppResult<()> {
        {
            let mut s = self.settings.write().unwrap();
            *s = new_settings;
            let json = serde_json::to_string_pretty(&*s)?;
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&self.path, &json)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, AppTheme, SettingsState};

    #[test]
    fn canvas_names_default_hidden_and_persist_choice() {
        let old: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(!old.canvas_show_asset_names);
        let dir = std::env::temp_dir().join(format!("bb-canvas-names-{}", ulid::Ulid::new()));
        let path = dir.join("settings.json");
        let state = SettingsState::init(path.clone()).unwrap();
        assert!(!state.get().canvas_show_asset_names);
        for visible in [true, false] {
            let mut settings = state.get();
            settings.canvas_show_asset_names = visible;
            state.update(settings).unwrap();
            assert_eq!(SettingsState::init(path.clone()).unwrap().get().canvas_show_asset_names, visible);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn generation_reminders_default_on_and_preserve_opt_out_on_disk() {
        let old: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(old.generation_completion_popup);
        assert!(old.generation_completion_sound);
        let dir = std::env::temp_dir().join(format!("bb-reminders-{}", ulid::Ulid::new()));
        let path = dir.join("settings.json");
        let state = SettingsState::init(path.clone()).unwrap();
        let mut settings = state.get();
        settings.generation_completion_popup = false;
        settings.generation_completion_sound = false;
        state.update(settings).unwrap();
        let restored = SettingsState::init(path).unwrap().get();
        assert!(!restored.generation_completion_popup);
        assert!(!restored.generation_completion_sound);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn old_settings_default_to_light_theme() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"auto_analyze_on_ingest":true}"#).unwrap();
        assert_eq!(settings.theme, AppTheme::Light);
        assert_eq!(AppSettings::default().theme, AppTheme::Light);
    }

    #[test]
    fn saved_dark_theme_round_trips() {
        let mut settings = AppSettings::default();
        settings.theme = AppTheme::Dark;
        let json = serde_json::to_string(&settings).unwrap();
        assert_eq!(
            serde_json::from_str::<AppSettings>(&json).unwrap().theme,
            AppTheme::Dark
        );
    }

    #[test]
    fn old_settings_ignores_legacy_cloud_connection_fields() {
        let settings: AppSettings = serde_json::from_str(
            r#"{"auto_analyze_on_ingest":true,"auto_analyze_prompt":"test","library_root":null,"cloud_enabled":false,"cloud_supabase_url":"https://other.invalid","cloud_supabase_publishable_key":"old","cloud_mock":true,"cloud_auto_understand":true}"#,
        )
        .unwrap();

        assert!(settings.cloud_auto_understand);
        assert_eq!(settings.auto_analyze_prompt, "test");
    }

    #[test]
    fn old_settings_without_dreamina_model_default_to_pro() {
        let settings: AppSettings =
            serde_json::from_str(r#"{"auto_analyze_on_ingest":true}"#).unwrap();
        assert_eq!(settings.dreamina_model_version, "5.0Pro");
    }

    #[test]
    fn old_settings_default_to_official_agent_mode_only() {
        // 旧 settings.json 无 agent 模式字段 → 默认只开正式 Agent，dev 模式全关。
        let settings: AppSettings =
            serde_json::from_str(r#"{"auto_analyze_on_ingest":true}"#).unwrap();
        assert!(settings.agent_mode_enabled);
        assert!(!settings.agent_a_mode_enabled);
        assert!(!settings.agent_b_mode_enabled);
        assert!(!settings.agent_z_mode_enabled);
        assert!(!settings.agent_g_mode_enabled);
        assert!(!settings.agent_ds_mode_enabled);
    }

    #[test]
    fn init_removes_legacy_cloud_connection_fields_from_disk() {
        let dir = std::env::temp_dir().join(format!("bb-settings-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            r#"{"cloud_enabled":false,"cloud_mock":true,"cloud_auto_understand":true}"#,
        )
        .unwrap();

        let state = SettingsState::init(path.clone()).unwrap();
        assert!(state.get().cloud_auto_understand);
        let rewritten = std::fs::read_to_string(&path).unwrap();
        assert!(!rewritten.contains("cloud_enabled"));
        assert!(!rewritten.contains("cloud_mock"));
        std::fs::remove_dir_all(dir).ok();
    }
}
