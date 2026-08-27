use std::collections::HashMap;
use std::path::{Path, PathBuf};

const URL_NAMES: [&str; 3] = [
    "BOWERBIRD_SUPABASE_URL",
    "SUPABASE_URL",
    "VITE_SUPABASE_URL",
];
const KEY_NAMES: [&str; 4] = [
    "BOWERBIRD_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
];
// Entitlement 验签公钥（Ed25519 原始 32 字节 base64）：可选，缺省 = 该构建不启用
// 离线宽限验签（在线权益不受影响）。与 Edge Secret ENTITLEMENT_SIGNING_KEY 成对轮换。
const PUBKEY_NAMES: [&str; 1] = ["BOWERBIRD_ENTITLEMENT_PUBKEY"];

fn parse_env_file(path: &Path) -> HashMap<String, String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    content
        .lines()
        .filter_map(|raw| {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (name, value) = line.split_once('=')?;
            let value = value
                .split('#')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches('"')
                .trim_matches('\'');
            (!value.is_empty()).then(|| (name.trim().to_string(), value.to_string()))
        })
        .collect()
}

fn public_value(names: &[&str], files: &[HashMap<String, String>]) -> Option<String> {
    names
        .iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            files
                .iter()
                .find_map(|file| names.iter().find_map(|name| file.get(*name).cloned()))
        })
        .filter(|value| !value.contains('\r') && !value.contains('\n'))
}

fn main() {
    for name in URL_NAMES.into_iter().chain(KEY_NAMES).chain(PUBKEY_NAMES) {
        println!("cargo:rerun-if-env-changed={name}");
    }

    let cloud_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../cloud");
    let env = cloud_dir.join(".env");
    let env_local = cloud_dir.join(".env.local");
    println!("cargo:rerun-if-changed={}", env.display());
    println!("cargo:rerun-if-changed={}", env_local.display());

    // Process env wins. For repository-local development/builds, .env.local overrides .env.
    let files = [parse_env_file(&env_local), parse_env_file(&env)];
    let url = public_value(&URL_NAMES, &files);
    let key = public_value(&KEY_NAMES, &files);
    match (url, key) {
        (Some(url), Some(key)) => {
            println!("cargo:rustc-env=BOWERBIRD_SUPABASE_URL={url}");
            println!("cargo:rustc-env=BOWERBIRD_SUPABASE_PUBLISHABLE_KEY={key}");
        }
        (None, None) => println!(
            "cargo:warning=Bowerbird Cloud public config is missing; this build will report Cloud unavailable"
        ),
        _ => panic!("Bowerbird Cloud public URL and publishable key must be configured together"),
    }

    // Entitlement 验签公钥：可选注入。缺失只影响离线宽限验签（回落在线可信）。
    if let Some(pubkey) = public_value(&PUBKEY_NAMES, &files) {
        println!("cargo:rustc-env=BOWERBIRD_ENTITLEMENT_PUBKEY={pubkey}");
    }

    tauri_build::build()
}
