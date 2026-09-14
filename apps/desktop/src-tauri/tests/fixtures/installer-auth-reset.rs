// NSIS hook fixture: filesystem only, no account or keyring calls.
fn main() {
    assert_eq!(std::env::args().nth(1).as_deref(), Some("--reset-install-auth"));
    let root = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let profile = root.join("profile");
    assert!(profile.join("installation-auth-reset.pending").exists());
    if root.join("fail-reset").exists() { std::process::exit(1); }
    let count = std::fs::read_to_string(root.join("reset-count")).ok()
        .and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    std::fs::write(root.join("reset-count"), (count + 1).to_string()).unwrap();
    std::fs::remove_file(profile.join("installation-auth-reset.pending")).unwrap();
}
