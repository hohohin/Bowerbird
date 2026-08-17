//! 应用设置持久化：存为 JSON 文件（不在 SQLite 里），启动时读取，写入时全量覆盖。
//! - 默认值在 AppSettings::default() 里定义。
//! - 多线程读通过 RwLock；Tauri command 直接操作 State<SettingsState>。

use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// 自动反推提示词的默认模板。`{vocab}` 在运行时替换为受控类别词表。
pub const DEFAULT_AUTO_ANALYZE_PROMPT: &str = "请描述这张图片并取名。严格按照以下格式回复：\
 第一行只回复命名本身，不要有标点符号；\
 第二行起回复图片的描述；\
 最后一行单独用 [[CAT: 类别1, 类别2]] 标注主类（最多 2 个，必须从词表里选，只回类别名）。\
 词表：{vocab}。";

fn default_auto_analyze_prompt() -> String {
    DEFAULT_AUTO_ANALYZE_PROMPT.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// 入库时自动反推 + 自动重命名
    #[serde(default)]
    pub auto_analyze_on_ingest: bool,

    /// 自动反推的提示词（可用 {vocab} 占位符，运行时替换为受控类别词表）
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

    /// 首启预置示例图是否已注入完成。true = 不再重灌（配合 count_assets==0 双 gate）。
    #[serde(default)]
    pub samples_seeded: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_analyze_on_ingest: false,
            auto_analyze_prompt: DEFAULT_AUTO_ANALYZE_PROMPT.to_string(),
            library_root: None,
            cloud_auto_understand: false,
            board_shift_pick: false,
            hide_project_assets: false,
            samples_seeded: false,
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
    use super::{AppSettings, SettingsState};

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
