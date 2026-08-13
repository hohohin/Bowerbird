//! 预设图释放命令：把随包的预设图复制到用户文档目录，供新手引导「导入文件夹」选中。

use tauri::{AppHandle, Manager};

use crate::core::preset::PRESET_SPECS;
use crate::core::samples;
use crate::error::AppError;

/// 把 resources/samples/ 下的预设图复制到 document_dir/Bowerbird/初始引导/，返回该目录路径。
/// 幂等（文件不存在或大小不同才覆盖）；dev 图未放则跳过不崩。供新手引导 pickFolder 默认打开。
#[tauri::command]
pub async fn release_preset_pack(app: AppHandle) -> Result<String, AppError> {
    let src_dir = samples::resolve_samples_dir(&app)
        .ok_or_else(|| AppError::Other("预设图资源目录未找到".into()))?;
    let doc = app
        .path()
        .document_dir()
        .map_err(|e| AppError::Other(format!("无法解析文档目录: {e}")))?;
    let target = doc.join("Bowerbird").join("初始引导");
    std::fs::create_dir_all(&target)?;
    for spec in PRESET_SPECS {
        let from = src_dir.join(spec.filename);
        if !from.exists() {
            continue;
        }
        let to = target.join(spec.filename);
        let need = match std::fs::metadata(&to) {
            Ok(m) => m.len() != std::fs::metadata(&from).ok().map(|x| x.len()).unwrap_or(0),
            Err(_) => true,
        };
        if need {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(target.to_string_lossy().to_string())
}
