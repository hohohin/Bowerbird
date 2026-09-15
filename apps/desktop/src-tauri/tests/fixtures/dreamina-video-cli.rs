//! Offline subprocess fixture for the Seedance adapter; never connects to a provider.
use std::{env, fs, path::PathBuf};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|i| args.get(i + 1));
    let root = env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let log = root.join("calls.txt");
    use std::io::Write;
    writeln!(fs::OpenOptions::new().append(true).create(true).open(log).unwrap(), "{}", args.join("|")).unwrap();
    if args.first().map(String::as_str) == Some("query_result") {
        match value("--submit_id").map(String::as_str) {
            Some("failed") => println!(r#"{{"gen_status":"fail","fail_reason":"VIP required"}}"#),
            Some("unknown") => println!(r#"{{"gen_status":"unexpected"}}"#),
            Some("pending") => println!(r#"{{"gen_status":"querying"}}"#),
            _ => {
                let dir = PathBuf::from(value("--download_dir").unwrap()).join("nested");
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join("clip.mp4"), b"offline video artifact").unwrap();
                fs::write(dir.join("poster.png"), b"not a video").unwrap();
                println!(r#"{{"gen_status":"success"}}"#);
            }
        }
    } else {
        assert_eq!(value("--model_version").map(String::as_str), Some("seedance2.5"));
        assert_eq!(value("--poll").map(String::as_str), Some("0"));
        println!(r#"{{"submit_id":"offline-video-submit","gen_status":"querying"}}"#);
    }
}
