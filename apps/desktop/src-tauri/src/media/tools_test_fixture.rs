fn main() {
    let exe = std::env::current_exe().unwrap();
    let path = exe.to_string_lossy();
    if path.contains("bad-exit") {
        std::process::exit(3);
    }
    if path.contains("wrong-version") {
        println!("unrelated tool");
        return;
    }
    let name = if exe
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("ffprobe")
    {
        "ffprobe"
    } else {
        "ffmpeg"
    };
    assert_eq!(std::env::args().nth(1).as_deref(), Some("-version"));
    println!("{name} version test-fixture");
}
