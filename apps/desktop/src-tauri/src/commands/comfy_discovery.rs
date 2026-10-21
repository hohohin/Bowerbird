//! Read-only discovery of existing Desktop, standalone and portable installations.
use std::{fs, path::{Path, PathBuf}};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Installation {
    pub path: PathBuf, pub name: String, pub endpoint: String, pub can_start: bool,
    pub models_found: usize,
    #[serde(skip)] pub python: Option<PathBuf>,
    #[serde(skip)] pub main: PathBuf,
    #[serde(skip)] pub model_configs: Vec<PathBuf>,
    #[serde(skip)] pub launch_args: Vec<String>,
}
pub(super) fn desktop_config_dirs() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(path) = std::env::var_os("APPDATA") { roots.push(PathBuf::from(path)); }
    #[cfg(target_os = "macos")]
    if let Some(path) = std::env::var_os("HOME") { roots.push(PathBuf::from(path).join("Library/Application Support")); }
    roots.into_iter().flat_map(|root| [root.join("Comfy Desktop"), root.join("ComfyUI")]).collect()
}
fn read_json(path: &Path) -> Value {
    // Config files only: never scan browser caches, workflows or user prompts.
    if !fs::metadata(path).is_ok_and(|m| m.len() <= 2 * 1024 * 1024) { return Value::Null; }
    fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}
fn children(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path).into_iter().flatten().filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink())).take(64).map(|e| e.path()).collect()
}
fn inspect(root: &Path, model_dirs: &[PathBuf], model_configs: Vec<PathBuf>, names: &[&str]) -> Option<Installation> {
    let main = [root.join("main.py"), root.join("ComfyUI/main.py")].into_iter()
        .find(|p| p.is_file() && p.parent().unwrap().join("folder_paths.py").is_file())?;
    // Desktop keeps current dependencies in the source venv; standalone-env is only its base interpreter.
    let source = main.parent()?;
    let python = [source.join(".venv/Scripts/python.exe"), source.join(".venv/bin/python"),
        root.join(".venv/Scripts/python.exe"), root.join(".venv/bin/python"),
        root.join("standalone-env/python.exe"), root.join("python_embeded/python.exe"), root.join("standalone-env/bin/python")]
        .into_iter().find(|p| p.is_file());
    let mut dirs = model_dirs.to_vec(); dirs.push(main.parent()?.join("models"));
    let found = names.iter().filter(|name| dirs.iter().any(|dir| {
        // Files can be in Desktop's shared category folders. Bounded traversal avoids whole-disk scans.
        fn contains(dir: &Path, name: &str, depth: u8, budget: &mut usize) -> bool {
            if *budget == 0 { return false; } *budget -= 1;
            if fs::metadata(dir.join(name)).is_ok_and(|m| m.is_file() && m.len() > 0) { return true; }
            depth > 0 && children(dir).iter().any(|p| contains(p, name, depth - 1, budget))
        }
        contains(dir, name, 3, &mut 512)
    })).count();
    Some(Installation { path: root.to_path_buf(), name: root.file_name()?.to_string_lossy().into(), endpoint: "http://127.0.0.1:8188".into(),
        can_start: python.is_some(), python, main, model_configs, launch_args: Vec::new(), models_found: found })
}
pub(super) fn discover(config_dirs: &[PathBuf], selected: Option<&Path>, names: &[&str]) -> Vec<Installation> {
    let mut found = Vec::new();
    for config in config_dirs {
        let settings = read_json(&config.join("settings.json"));
        let model_dirs: Vec<PathBuf> = settings["modelsDirs"].as_array().into_iter().flatten().filter_map(Value::as_str).map(PathBuf::from).collect();
        let data = read_json(&config.join("installations.json"));
        let mut entries: Vec<&Value> = data.as_array().into_iter().flatten().collect();
        entries.sort_by_key(|v| std::cmp::Reverse(v["lastLaunchedAt"].as_u64().unwrap_or(0)));
        for entry in entries.into_iter().take(64) {
            if entry["sourceId"] == "cloud" { continue; }
            let Some(path) = entry["installPath"].as_str().map(PathBuf::from) else { continue; };
            let mut configs = vec![config.join("shared_model_paths.yaml")];
            if let Some(id) = entry["id"].as_str().filter(|id| !id.contains(['/', '\\']) && !id.contains("..")) {
                let per_instance = config.join("instance-model-paths").join(format!("{id}.yaml"));
                if per_instance.is_file() { configs = vec![per_instance]; }
            }
            configs.retain(|p| p.is_file());
            if let Some(mut instance) = inspect(&path, &model_dirs, configs, names) {
                if let Some(name) = entry["name"].as_str() { instance.name = name.into(); }
                let args: Vec<&str> = entry["launchArgs"].as_str().unwrap_or("").split_whitespace().collect();
                // Preserve known resource/performance options, never shell strings or arbitrary script arguments.
                for (index, arg) in args.iter().enumerate() {
                    if ["--use-sage-attention", "--lowvram", "--normalvram", "--highvram", "--disable-smart-memory", "--cache-none"].contains(arg) {
                        instance.launch_args.push((*arg).into());
                    } else if ["--reserve-vram", "--cache-ram"].contains(arg) {
                        if let Some(value) = args.get(index + 1).filter(|v| v.parse::<f64>().is_ok_and(|n| n.is_finite() && n >= 0.0)) {
                            instance.launch_args.extend([(*arg).into(), (*value).into()]);
                        }
                    }
                }
                let port = entry["port"].as_u64().and_then(|v| u16::try_from(v).ok())
                    .or_else(|| args.windows(2).find(|p| p[0] == "--port").and_then(|p| p[1].parse::<u16>().ok()))
                    .or_else(|| args.iter().find_map(|p| p.strip_prefix("--port=").and_then(|v| v.parse::<u16>().ok())));
                if let Some(port) = port.filter(|p| *p > 0) { instance.endpoint = format!("http://127.0.0.1:{port}"); }
                found.push(instance);
            }
        }
        // Older official Desktop stores its selected base directory in config.json.
        if let Some(base) = read_json(&config.join("config.json"))["basePath"].as_str() {
            if let Some(instance) = inspect(Path::new(base), &model_dirs, vec![], names) { found.push(instance); }
        }
    }
    if let Some(selected) = selected {
        let selected = selected.canonicalize().unwrap_or_else(|_| selected.to_path_buf());
        let same = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        // Accept Desktop's parent, instance folder, source folder or executable folder.
        let matching: Vec<_> = found.iter().filter(|i| same(&i.path).starts_with(&selected) || same(&i.main).starts_with(&selected)
            || selected == same(i.main.parent().unwrap())).cloned().collect();
        if !matching.is_empty() { return matching; }
        let mut candidates = vec![selected.clone(), selected.join("ComfyUI_windows_portable")];
        if let Some(parent) = selected.parent() { candidates.push(parent.to_path_buf()); }
        candidates.extend(children(&selected.join("ComfyUI-Installs")));
        let mut located: Vec<_> = candidates.iter().filter_map(|candidate| inspect(candidate, &[], vec![], names)).collect();
        located.sort_by_key(|i| !i.can_start);
        if !located.is_empty() { return vec![located.remove(0)]; }
        // The Desktop application directory itself does not contain the Python installation.
        if ["Comfy Desktop.exe", "ComfyUI.exe"].iter().any(|name| selected.join(name).is_file()) { return found; }
        return Vec::new();
    }
    let mut seen = std::collections::HashSet::new();
    found.retain(|item| seen.insert(item.path.clone()));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn h3_discovery_desktop_shared_models_selected_parent_and_custom_port() {
        let root = std::env::temp_dir().join(format!("h3-discovery-{}", uuid::Uuid::new_v4()));
        let config = root.join("config"); let instance = root.join("Comfy-Desktop/ComfyUI-Installs/ComfyUI"); let models = root.join("shared/models");
        for dir in [&config, &instance.join("ComfyUI"), &instance.join("standalone-env"), &models.join("loras")] { fs::create_dir_all(dir).unwrap(); }
        for path in [instance.join("ComfyUI/main.py"), instance.join("ComfyUI/folder_paths.py"), instance.join("standalone-env/python.exe")] { fs::write(path, "fixture").unwrap(); }
        fs::write(models.join("loras/model.safetensors"), "model").unwrap();
        fs::write(config.join("shared_model_paths.yaml"), "fixture").unwrap();
        fs::write(config.join("settings.json"), serde_json::to_vec(&serde_json::json!({"modelsDirs":[models]})).unwrap()).unwrap();
        fs::write(config.join("installations.json"), serde_json::to_vec(&serde_json::json!([
            {"sourceId":"cloud","remoteUrl":"https://cloud.comfy.org"},
            {"name":"Existing H3","installPath":instance,"launchArgs":"--port 8199","lastLaunchedAt":10}
        ])).unwrap()).unwrap();
        for selection in [None, Some(root.join("Comfy-Desktop")), Some(instance.clone()), Some(instance.join("ComfyUI"))] {
            let found = discover(&[config.clone()], selection.as_deref(), &["model.safetensors"]);
            assert_eq!(found.len(), 1); assert_eq!(found[0].models_found, 1); assert!(found[0].can_start);
            assert_eq!(found[0].endpoint, "http://127.0.0.1:8199"); assert_eq!(found[0].model_configs.len(), 1);
        }
        assert!(discover(&[config], Some(&root.join("unrelated")), &[]).is_empty());
        assert!(!instance.join("Bowerbird-ComfyUI").exists());
    }
    #[test]
    fn h3_discovery_prefers_source_venv_over_desktop_base_python() {
        let root = std::env::temp_dir().join(format!("h3-desktop-venv-{}", uuid::Uuid::new_v4()));
        let source = root.join("ComfyUI");
        for dir in [source.join(".venv/Scripts"), root.join("standalone-env"), root.join(".venv/Scripts")] {
            fs::create_dir_all(dir).unwrap();
        }
        for path in [source.join("main.py"), source.join("folder_paths.py"), source.join(".venv/Scripts/python.exe"),
            root.join("standalone-env/python.exe"), root.join(".venv/Scripts/python.exe")] { fs::write(path, "fixture").unwrap(); }
        for selected in [&root, &source] {
            let found = discover(&[], Some(selected), &[]);
            assert_eq!(found[0].python.as_ref().unwrap().canonicalize().unwrap(), source.join(".venv/Scripts/python.exe").canonicalize().unwrap());
            assert!(found[0].can_start);
        }
        // Unix Desktop uses the same source-local venv convention.
        fs::remove_file(source.join(".venv/Scripts/python.exe")).unwrap();
        fs::create_dir_all(source.join(".venv/bin")).unwrap();
        fs::write(source.join(".venv/bin/python"), "fixture").unwrap();
        assert_eq!(discover(&[], Some(&root), &[])[0].python.as_ref().unwrap().canonicalize().unwrap(), source.join(".venv/bin/python").canonicalize().unwrap());
    }
    #[test]
    fn h3_discovery_portable_and_missing_python_are_distinct_from_missing_install() {
        let root = std::env::temp_dir().join(format!("h3-portable-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("ComfyUI")).unwrap();
        fs::write(root.join("ComfyUI/main.py"), "fixture").unwrap(); fs::write(root.join("ComfyUI/folder_paths.py"), "fixture").unwrap();
        let found = discover(&[], Some(&root), &[]); assert_eq!(found.len(), 1); assert!(!found[0].can_start);
        fs::create_dir_all(root.join("python_embeded")).unwrap(); fs::write(root.join("python_embeded/python.exe"), "fixture").unwrap();
        assert!(discover(&[], Some(&root), &[])[0].can_start);
    }
    #[test]
    #[ignore = "Read-only check of the current user's actual Desktop registry; no HTTP or process launch"]
    fn h3_discovery_local_desktop_read_only() {
        let names = super::super::comfy_video::model_names();
        let found = discover(&desktop_config_dirs(), None, &names);
        assert!(!found.is_empty(), "No Desktop installations registered");
        for item in &found { println!("{} | {} | models {}/{} | python {}", item.name, item.path.display(), item.models_found, names.len(), item.can_start); }
        assert!(found.iter().any(|i| i.models_found == names.len() && i.can_start));
    }
}
