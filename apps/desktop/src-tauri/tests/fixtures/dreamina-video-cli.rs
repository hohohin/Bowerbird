//! Offline subprocess fixture for the Seedance adapter; never connects to a provider.
use std::{env, fs, path::PathBuf};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|i| args.get(i + 1));
    let root = env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let log = root.join("calls.txt");
    use std::io::Write;
    writeln!(fs::OpenOptions::new().append(true).create(true).open(log).unwrap(), "{}", args.join("|")).unwrap();
    let timeout = || {
        eprintln!("do request: Post \"https://jimeng.jianying.com/mweb/v1/get_history_by_ids?agent_detect=unknown&aid=513695&cli_version=a857341-dirty&from=dreamina_cli\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)");
        std::process::exit(1);
    };
    if args.first().map(String::as_str) == Some("query_result") {
        let id = value("--submit_id").unwrap();
        if id == "transient" || id == "offline-video-submit" {
            let counter = root.join(format!("{id}.count"));
            let count = fs::read_to_string(&counter).unwrap_or_default().parse::<usize>().unwrap_or(0) + 1;
            fs::write(counter, count.to_string()).unwrap();
            if (id == "offline-video-submit" && count == 1)
                || (id == "transient" && matches!(count, 1..=3 | 5..=7)) {
                timeout();
            }
            if id == "transient" && count == 4 {
                println!(r#"{{"gen_status":"querying"}}"#);
                return;
            }
        }
        match value("--submit_id").map(String::as_str) {
            Some("timeout") => timeout(),
            Some("unauthorized") => {
                eprintln!("unauthorized: please login");
                std::process::exit(1);
            }
            Some("remote-timeout") => {
                println!(r#"{{"gen_status":"fail","fail_reason":"context deadline exceeded"}}"#);
                std::process::exit(1);
            }
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
        if value("--prompt").map(String::as_str) == Some("submit timeout") {
            timeout();
        }
        assert_eq!(value("--model_version").map(String::as_str), Some("seedance2.5"));
        assert_eq!(value("--poll").map(String::as_str), Some("0"));
        println!(r#"{{"submit_id":"offline-video-submit","gen_status":"querying"}}"#);
    }
}
