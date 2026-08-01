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
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_analyze_on_ingest: false,
            auto_analyze_prompt: DEFAULT_AUTO_ANALYZE_PROMPT.to_string(),
            library_root: None,
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
        let settings = if path.exists() {
            let json = std::fs::read_to_string(&path)?;
            serde_json::from_str(&json).unwrap_or_default()
        } else {
            AppSettings::default()
        };
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
