use super::*;

fn fixture(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("bowerbird-media-{}-{label}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn install(root: &Path, tool: Tool, versioned: bool) -> PathBuf {
    let names = tool.names();
    let name = if versioned {
        names.last().unwrap()
    } else {
        &names[0]
    };
    let path = root.join(name);
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    let binary = BINARY.get_or_init(|| {
        let build = fixture("fixture build");
        let source = build.join("fixture.rs");
        std::fs::write(&source, include_str!("tools_test_fixture.rs")).unwrap();
        let binary = build.join(format!("fixture{}", std::env::consts::EXE_SUFFIX));
        let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let output = command(Path::new(&rustc))
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        binary
    });
    std::fs::copy(binary, &path).unwrap();
    path
}

#[test]
fn existing_installation_in_path_with_spaces_is_executable() {
    let root = fixture("installed tools with spaces");
    install(&root, Tool::Ffmpeg, false);
    install(&root, Tool::Ffprobe, false);
    let mut dirs = Vec::new();
    add_path(&mut dirs, &std::env::join_paths([&root]).unwrap());
    for tool in [Tool::Ffmpeg, Tool::Ffprobe] {
        let path = select(tool, None, &dirs).unwrap();
        assert!(path.is_absolute());
        assert_eq!(
            path.parent().unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );
    }
}

#[test]
fn missing_ffprobe_does_not_hide_usable_ffmpeg() {
    let root = fixture("only ffmpeg");
    install(&root, Tool::Ffmpeg, false);
    assert!(select(Tool::Ffmpeg, None, &[root.clone()]).is_ok());
    let error = select(Tool::Ffprobe, None, &[root])
        .unwrap_err()
        .to_string();
    assert!(error.contains("应用未找到 ffprobe"));
    assert!(!error.contains("请安装"));
}

#[test]
fn existing_but_non_executable_probe_reports_start_error_and_path() {
    let root = fixture("invalid executable");
    let path = root.join(&Tool::Ffprobe.names()[0]);
    std::fs::write(&path, b"not an executable").unwrap();
    let error = select(Tool::Ffprobe, None, &[root])
        .unwrap_err()
        .to_string();
    assert!(error.contains("已定位但无法启动"), "{error}");
    assert!(error.contains(path.file_name().unwrap().to_str().unwrap()));
}

#[test]
fn failed_version_exit_is_distinct_from_missing_binary() {
    let root = fixture("bad-exit");
    install(&root, Tool::Ffprobe, false);
    let error = select(Tool::Ffprobe, None, &[root])
        .unwrap_err()
        .to_string();
    assert!(error.contains("已定位但运行失败"), "{error}");
}

#[test]
fn successful_exit_with_wrong_version_is_rejected() {
    let root = fixture("wrong-version");
    install(&root, Tool::Ffprobe, false);
    let error = select(Tool::Ffprobe, None, &[root])
        .unwrap_err()
        .to_string();
    assert!(error.contains("无法识别的版本信息"), "{error}");
}

#[test]
fn broken_explicit_path_never_silently_falls_back() {
    let root = fixture("explicit");
    install(&root, Tool::Ffprobe, false);
    let error = select(Tool::Ffprobe, Some(root.join("missing.exe")), &[root])
        .unwrap_err()
        .to_string();
    assert!(error.contains("missing.exe"));
    assert!(error.contains("路径不存在"));
}

#[test]
fn broken_path_candidate_can_fall_back_to_an_existing_installation() {
    let bad = fixture("fallback bad");
    std::fs::write(bad.join(&Tool::Ffprobe.names()[0]), b"invalid").unwrap();
    let good = fixture("fallback good");
    let expected = install(&good, Tool::Ffprobe, false);
    assert_eq!(
        select(Tool::Ffprobe, None, &[bad, good]).unwrap(),
        std::fs::canonicalize(expected).unwrap()
    );
}

#[test]
fn path_entries_are_deduplicated_and_relative_entries_are_ignored() {
    let root = fixture("path");
    let path = std::env::join_paths([
        Path::new(""),
        Path::new("relative"),
        root.as_path(),
        root.as_path(),
    ])
    .unwrap();
    let mut dirs = Vec::new();
    add_path(&mut dirs, &path);
    assert_eq!(dirs, vec![root]);
}

#[test]
#[cfg(target_os = "windows")]
fn versioned_sidecars_work_without_plain_executable_names() {
    let root = fixture("sidecar");
    for tool in [Tool::Ffmpeg, Tool::Ffprobe] {
        let expected = install(&root, tool, true);
        assert_eq!(
            select(tool, None, &[root.clone()]).unwrap(),
            std::fs::canonicalize(expected).unwrap()
        );
    }
}

#[test]
#[cfg(target_os = "windows")]
fn winget_installation_is_found_without_path_or_link_and_scan_is_bounded() {
    let root = fixture("winget Packages");
    let bin = root.join("Gyan.FFmpeg_Microsoft.Winget.Source_test/ffmpeg-8.0-full_build/bin");
    std::fs::create_dir_all(&bin).unwrap();
    install(&bin, Tool::Ffprobe, false);
    // An unrelated project or deeper nested layout is never a candidate.
    let unrelated = root.join("Other.Project/ffmpeg-8.0/bin");
    std::fs::create_dir_all(&unrelated).unwrap();
    let mut dirs = Vec::new();
    winget_dirs(&root, &mut dirs);
    assert!(!dirs.contains(&unrelated));
    assert_eq!(
        select(Tool::Ffprobe, None, &dirs).unwrap(),
        std::fs::canonicalize(bin.join("ffprobe.exe")).unwrap()
    );
}

#[test]
fn saved_path_candidate_resolves_with_empty_process_path_input() {
    let root = fixture("registered PATH");
    install(&root, Tool::Ffprobe, false);
    let mut dirs = Vec::new();
    add_path(&mut dirs, std::ffi::OsStr::new(""));
    add_path(&mut dirs, &std::env::join_paths([&root]).unwrap());
    assert!(select(Tool::Ffprobe, None, &dirs).is_ok());
}
