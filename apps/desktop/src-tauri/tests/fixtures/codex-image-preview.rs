//! Offline exec fixture. Keep stdout open until the test receives the preview.
use std::{fs, path::PathBuf, thread, time::Duration};

fn main() {
    let root = PathBuf::from(std::env::var_os("CODEX_HOME").unwrap());
    let id = "01234567-89ab-4012-8123-456789abcdef";
    let dir = root.join("generated_images").join(id);
    fs::create_dir_all(&dir).unwrap();
    println!(r#"{{"type":"thread.started","thread_id":"{id}"}}"#);
    fs::copy(root.join("fixture.png"), dir.join("exec-abcdefab-cdef-4012-8123-456789abcdef.png")).unwrap();
    for _ in 0..300 {
        if root.join("finish").exists() { return; }
        thread::sleep(Duration::from_millis(50));
    }
    std::process::exit(1);
}
