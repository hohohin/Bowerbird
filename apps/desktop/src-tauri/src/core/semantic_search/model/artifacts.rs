use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::core::local_classification::vector::{download_with_io, verify};

use super::MODEL_ID;

// Pin both the HF staff conversion and the upstream Google checkpoint. See
// the attribution bundled with the downloaded model for the provenance.
const REPOSITORY: &str = "https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/resolve/ba1f3b0843f24bc5417d38e19c37b287d719b2f4";
const GOOGLE: &str = "https://huggingface.co/google/siglip2-base-patch16-224/resolve/75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2";
const READY: &str = "model-version";
const CORRUPT_STAMP: &str = "corrupt";
const ARCHIVE: &str = "onnxruntime-1.28.0.whl";
const NOTICES: &[(&str, &[u8])] = &[
    ("Apache-2.0.txt", include_bytes!("Apache-2.0.txt")),
    ("SigLIP2-NOTICE.txt", include_bytes!("SigLIP2-NOTICE.txt")),
];

pub(super) struct Artifact {
    pub(super) name: &'static str,
    pub(super) bytes: u64,
    pub(super) sha256: &'static str,
}

pub(super) const TEXT: Artifact = Artifact {
    name: "text_model.onnx",
    bytes: 1_129_469_657,
    sha256: "baf12d941beabafafb14f7b4adb38dc15be18681b964a84410ec53d9d65e6293",
};
pub(super) const VISION: Artifact = Artifact {
    name: "vision_model.onnx",
    bytes: 371_807_752,
    sha256: "c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad",
};
pub(super) const TOKENIZER: Artifact = Artifact {
    name: "tokenizer.json",
    bytes: 34_363_039,
    sha256: "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322",
};

struct Member {
    source: &'static str,
    output: Artifact,
}

struct Runtime {
    url: &'static str,
    archive: Artifact,
    native: Member,
    additional: &'static [Member],
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const RUNTIME: Option<Runtime> = Some(Runtime {
    url: "https://files.pythonhosted.org/packages/56/f1/51225c202edba4dfc94e1ea03f3d78f1aaf307da75fd792c0ce1946b2514/onnxruntime-1.28.0-cp313-cp313-win_amd64.whl",
    archive: Artifact { name: ARCHIVE, bytes: 13_755_033, sha256: "1a1a19175464665c9b8d50bc916f216cc0b569110045b7bbca8f9f290b186f58" },
    native: Member { source: "onnxruntime/capi/onnxruntime.dll", output: Artifact { name: "onnxruntime.dll", bytes: 17_766_712, sha256: "e23e1d0cef90ba2f10f48056fb8276b11c7fc714d1295aa4423c5ecd7a77a013" } },
    additional: &[
        Member { source: "onnxruntime/capi/onnxruntime_providers_shared.dll", output: Artifact { name: "onnxruntime_providers_shared.dll", bytes: 21_816, sha256: "ff7b6f864cd9e67e13f3b6c6709af97283ef95abe254babac3a81acbcb2781b1" } },
        Member { source: "onnxruntime/LICENSE", output: Artifact { name: "LICENSE", bytes: 1_094, sha256: "c250d6278f0b47a6439fb7592b08b58a55eb9f535aa49a1db63211c3f982b674" } },
        Member { source: "onnxruntime/ThirdPartyNotices.txt", output: Artifact { name: "ThirdPartyNotices.txt", bytes: 331_175, sha256: "fb0af774b4d7cffc5b9d046f2aaeade2f37df2f80abf8033c95dfffcc77a8866" } },
    ],
});

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const RUNTIME: Option<Runtime> = Some(Runtime {
    url: "https://files.pythonhosted.org/packages/9c/12/3807e2b17d9eb71d3cb78ed2ba76869b05c637c9b9d6112e636098b0c97a/onnxruntime-1.28.0-cp313-cp313-macosx_14_0_arm64.whl",
    archive: Artifact { name: ARCHIVE, bytes: 19_141_759, sha256: "31410f544674f534c2f27348af52ef81682ca9c8719154bf4d48f0ef23823b1e" },
    native: Member { source: "onnxruntime/capi/libonnxruntime.1.28.0.dylib", output: Artifact { name: "libonnxruntime.1.28.0.dylib", bytes: 30_509_592, sha256: "bb37d233002cf57b52ae315e3f00904d0e6d6261da27809372ee0e27ec9046fd" } },
    additional: &[
        Member { source: "onnxruntime/LICENSE", output: Artifact { name: "LICENSE", bytes: 1_073, sha256: "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c" } },
        Member { source: "onnxruntime/ThirdPartyNotices.txt", output: Artifact { name: "ThirdPartyNotices.txt", bytes: 325_054, sha256: "0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2" } },
    ],
});

#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64")
)))]
const RUNTIME: Option<Runtime> = None;

fn runtime() -> Option<&'static Runtime> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let supported = SUPPORTED.get_or_init(|| {
            std::process::Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok())
                .is_some_and(|major| major >= 14)
        });
        if !supported {
            return None;
        }
    }
    RUNTIME.as_ref()
}

pub(in crate::core::semantic_search) fn supported() -> bool {
    runtime().is_some()
}

pub(in crate::core::semantic_search) fn download_bytes() -> u64 {
    runtime().map_or(0, |runtime| {
        TEXT.bytes + VISION.bytes + TOKENIZER.bytes + runtime.archive.bytes
    })
}

pub(in crate::core::semantic_search) fn installed_bytes() -> u64 {
    runtime().map_or(0, |runtime| {
        let runtime_bytes: u64 = members(runtime).map(|item| item.output.bytes).sum();
        let notice_bytes: u64 = NOTICES.iter().map(|(_, text)| text.len() as u64).sum();
        TEXT.bytes
            + VISION.bytes
            + TOKENIZER.bytes
            + runtime_bytes
            + notice_bytes
            + MODEL_ID.len() as u64
    })
}

fn has_size(path: &Path, size: u64) -> bool {
    fs::metadata(path).is_ok_and(|file| file.is_file() && file.len() == size)
}

fn members(runtime: &Runtime) -> impl Iterator<Item = &Member> {
    std::iter::once(&runtime.native).chain(runtime.additional)
}

pub(in crate::core::semantic_search) fn installed(root: &Path) -> bool {
    let Some(runtime) = runtime() else {
        return false;
    };
    has_size(&root.join(READY), MODEL_ID.len() as u64)
        && fs::read_to_string(root.join(READY)).is_ok_and(|stamp| stamp == MODEL_ID)
        && [TEXT, VISION, TOKENIZER]
            .iter()
            .all(|item| has_size(&root.join(item.name), item.bytes))
        && members(runtime).all(|item| {
            has_size(
                &root.join("runtime").join(item.output.name),
                item.output.bytes,
            )
        })
        && NOTICES.iter().all(|(name, expected)| {
            let path = root.join(name);
            has_size(&path, expected.len() as u64)
                && fs::read(&path).is_ok_and(|text| text == *expected)
        })
}

pub(in crate::core::semantic_search) fn known_corrupt(root: &Path) -> bool {
    let stamp = root.join(READY);
    has_size(&stamp, CORRUPT_STAMP.len() as u64)
        && fs::read_to_string(stamp).is_ok_and(|text| text == CORRUPT_STAMP)
}

/// Invalidate only readiness. Existing inference sessions may still own open
/// model files, which repair will replace after those sessions are closed.
pub(in crate::core::semantic_search) fn invalidate_ready(root: &Path) -> Result<(), String> {
    let ready = root.join(READY);
    if atomic_write(ready.clone(), CORRUPT_STAMP.as_bytes()).is_ok() {
        return Ok(());
    }
    // Removing the short marker still prevents startup from trusting the old
    // package if a full disk cannot publish the explicit corruption marker.
    remove_if_present(&ready)
}

pub(in crate::core::semantic_search) fn uninstall(root: &Path) -> Result<(), String> {
    // The process retains the ORT DLL for its lifetime and can reuse it when
    // either local image feature needs a session again.
    for name in [READY, TEXT.name, VISION.name, TOKENIZER.name, ARCHIVE] {
        remove_if_present(&root.join(name))?;
        remove_if_present(&root.join(format!("{name}.part")))?;
    }
    for (name, _) in NOTICES {
        remove_if_present(&root.join(name))?;
    }
    Ok(())
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除语义搜索模型文件：{error}")),
    }
}

pub(super) fn verified_file(root: &Path, item: &Artifact) -> Result<PathBuf, String> {
    let path = root.join(item.name);
    if !has_size(&path, item.bytes) || verify(&path, item.sha256).is_err() {
        return Err(format!(
            "语义搜索文件 {} 校验失败，请重新下载模型。",
            item.name
        ));
    }
    Ok(path)
}

pub(super) fn verified_runtime(root: &Path) -> Result<PathBuf, String> {
    let runtime = runtime().ok_or("此平台暂不支持语义搜索。")?;
    let root = root.join("runtime");
    for member in runtime.additional {
        verified_file(&root, &member.output)?;
    }
    verified_file(&root, &runtime.native.output)
}

pub(super) fn storage_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => {
            tracing::warn!(%error, "semantic model disk space exhausted");
            "disk_full".into()
        }
        _ => error.to_string(),
    }
}

fn archive_error(error: zip::result::ZipError) -> String {
    match error {
        zip::result::ZipError::Io(error) => storage_error(error),
        _ => error.to_string(),
    }
}

pub(in crate::core::semantic_search) async fn install(
    root: &Path,
    cancel: &AtomicBool,
    progress: impl Fn(&str, u64, u64),
) -> Result<(), String> {
    let runtime = runtime().ok_or("此平台暂不支持语义搜索。")?;
    tokio::fs::create_dir_all(root)
        .await
        .map_err(storage_error)?;
    let artifacts = [
        (format!("{REPOSITORY}/onnx/{}", TEXT.name), TEXT),
        (format!("{REPOSITORY}/onnx/{}", VISION.name), VISION),
        (format!("{GOOGLE}/{}", TOKENIZER.name), TOKENIZER),
    ];
    let total = download_bytes();
    let mut done = 0;
    for (url, item) in artifacts {
        if cancel.load(Ordering::Relaxed) {
            return Err("已停止下载语义搜索模型。".into());
        }
        let advance = |name: &str, bytes, _| progress(name, done + bytes, total);
        if item.name == TEXT.name {
            super::ranged_download::download_text(root, &url, &item, cancel, &advance).await?;
        } else {
            download_with_io(
                root,
                &[&url],
                (item.name, item.sha256, item.bytes),
                cancel,
                &advance,
                storage_error,
            )
            .await?;
        }
        done += item.bytes;
    }
    let folder = root.join("runtime");
    if !members(runtime)
        .all(|item| verify(&folder.join(item.output.name), item.output.sha256).is_ok())
    {
        let item = &runtime.archive;
        let advance = |name: &str, bytes, _| progress(name, done + bytes, total);
        download_with_io(
            root,
            &[runtime.url],
            (item.name, item.sha256, item.bytes),
            cancel,
            &advance,
            storage_error,
        )
        .await?;
        let archive = root.join(ARCHIVE);
        tokio::task::spawn_blocking(move || extract_runtime(&archive, &folder, runtime))
            .await
            .map_err(|error| error.to_string())??;
        tokio::fs::remove_file(root.join(ARCHIVE))
            .await
            .map_err(storage_error)?;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("已停止下载语义搜索模型。".into());
    }
    for (name, text) in NOTICES {
        atomic_write(root.join(name), text)?;
    }
    atomic_write(root.join(READY), MODEL_ID.as_bytes())?;
    progress(READY, total, total);
    Ok(())
}

fn extract_runtime(source: &Path, destination: &Path, runtime: &Runtime) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(storage_error)?;
    let file = File::open(source).map_err(storage_error)?;
    let mut archive = zip::ZipArchive::new(file).map_err(archive_error)?;
    for item in members(runtime) {
        let path = destination.join(item.output.name);
        if verify(&path, item.output.sha256).is_ok() {
            continue;
        }
        let mut entry = archive.by_name(item.source).map_err(archive_error)?;
        if entry.size() != item.output.bytes {
            return Err("语义搜索运行组件的解压尺寸不正确。".into());
        }
        let mut temporary = tempfile::NamedTempFile::new_in(destination).map_err(storage_error)?;
        io::copy(&mut entry, &mut temporary).map_err(storage_error)?;
        temporary.as_file().sync_all().map_err(storage_error)?;
        verify(temporary.path(), item.output.sha256)?;
        temporary
            .persist(path)
            .map_err(|error| storage_error(error.error))?;
    }
    Ok(())
}

fn atomic_write(path: PathBuf, value: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("模型目录不存在。")?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(storage_error)?;
    file.write_all(value).map_err(storage_error)?;
    file.as_file().sync_all().map_err(storage_error)?;
    file.persist(path)
        .map_err(|error| storage_error(error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_full_and_quota_are_preserved_without_relabeling_network_errors() {
        assert_eq!(
            storage_error(io::ErrorKind::StorageFull.into()),
            "disk_full"
        );
        assert_eq!(
            storage_error(io::ErrorKind::QuotaExceeded.into()),
            "disk_full"
        );
        assert_eq!(
            archive_error(zip::result::ZipError::Io(io::ErrorKind::StorageFull.into())),
            "disk_full"
        );
        assert_ne!(
            storage_error(io::ErrorKind::ConnectionReset.into()),
            "disk_full"
        );
        #[cfg(windows)]
        for code in [39, 112, 1295] {
            assert_eq!(
                storage_error(io::Error::from_raw_os_error(code)),
                "disk_full"
            );
        }
        #[cfg(target_os = "macos")]
        for code in [28, 69] {
            assert_eq!(
                storage_error(io::Error::from_raw_os_error(code)),
                "disk_full"
            );
        }
    }

    #[test]
    fn hash_detects_same_size_corruption() {
        let root = tempfile::tempdir().unwrap();
        let artifact = Artifact {
            name: "fixture.onnx",
            bytes: 6,
            sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
        };
        let file = root.path().join(artifact.name);
        fs::write(&file, b"abcdef").unwrap();
        assert_eq!(verified_file(root.path(), &artifact).unwrap(), file);
        fs::write(&file, b"bacdef").unwrap();
        assert!(verified_file(root.path(), &artifact).is_err());
    }

    #[test]
    fn uninstall_preserves_the_loaded_runtime_and_other_files() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("runtime");
        fs::create_dir(&runtime).unwrap();
        for name in [
            READY,
            TEXT.name,
            VISION.name,
            TOKENIZER.name,
            "text_model.onnx.part",
        ] {
            fs::write(root.path().join(name), b"fixture").unwrap();
        }
        fs::write(runtime.join("native"), b"runtime").unwrap();
        fs::write(root.path().join("existing"), b"unrelated").unwrap();
        uninstall(root.path()).unwrap();
        uninstall(root.path()).unwrap();
        assert!(runtime.join("native").exists());
        assert!(root.path().join("existing").exists());
        assert!(!root.path().join(TEXT.name).exists());
        assert!(!root.path().join("text_model.onnx.part").exists());
    }
}
