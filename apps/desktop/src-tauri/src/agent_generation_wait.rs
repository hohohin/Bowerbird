//! Read-only, headless wait used by Codex card tools. No Tauri, auth or model startup.
use std::path::Path;
use std::time::{Duration, Instant};
use serde_json::Value;

const FLAG: &str = "--agent-wait-generation";

pub fn agent_generation_wait_worker() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).and_then(|arg| arg.to_str()) != Some(FLAG) { return None; }
    let result = if args.len() == 4 {
        wait(Path::new(&args[2]), &args[3].to_string_lossy(), Duration::from_secs(1800), Duration::from_millis(250))
    } else { Err("用法：--agent-wait-generation 请求目录 生图调用UUID".into()) };
    Some(match result {
        Ok(response) => { println!("{response}"); 0 }
        Err(error) => { eprintln!("{error}"); 1 }
    })
}

pub(crate) fn instruction(root: &Path) -> Result<String, std::io::Error> {
    let binary = std::env::current_exe()?;
    let root = std::fs::canonicalize(root)?;
    // The host shell differs, but both accept single-quoted literal paths.
    #[cfg(windows)]
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "''"));
    #[cfg(not(windows))]
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    let prefix = if cfg!(windows) { "& " } else { "" };
    Ok(format!("提交后只启动一次等待命令：{prefix}{} {FLAG} {} <本次生图调用UUID>（用实际 id 替换占位符）。此命令只读等待匹配响应并输出 JSON，不会再次生图；不要自己用 sleep/test/读文件循环查询。把命令工具及后续等待工具的等待时间设为其允许的最大值；如工具返回仍在运行，只继续等待同一工具进程，不重启命令。超时或中断保留原调用 id，不能重提交生图。命令输出中，", quote(&binary), quote(&root)))
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if file.metadata().map_err(|error| error.to_string())?.len() > 128_000 {
        return Err("生图桥文件过大".into());
    }
    serde_json::from_reader(file).map(Some).map_err(|error| format!("生图桥文件无效：{error}"))
}

fn wait(root: &Path, call_id: &str, timeout: Duration, interval: Duration) -> Result<Value, String> {
    uuid::Uuid::parse_str(call_id).map_err(|_| "生图调用 UUID 无效")?;
    let request_id = root.file_name().and_then(|name| name.to_str()).ok_or("请求目录无效")?;
    let request = root.join("generation-requests").join(format!("{request_id}.json"));
    let response = root.join("generation-responses").join(format!("{request_id}.json"));
    let started = Instant::now();
    loop {
        // Stop even if an old response remains. This worker never writes or re-submits.
        if root.join("completion.json").exists() { return Err("Agent 请求已结束或停止".into()); }
        let current = read_json(&request)?.ok_or("生图请求不存在；请先提交请求文件")?;
        if current["id"].as_str() != Some(call_id) { return Err("生图调用身份已改变，停止等待".into()); }
        if let Some(value) = read_json(&response)? {
            if value["generation"]["id"].as_str() == Some(call_id) {
                // ratio is optional in the request and serialized as null in replies.
                if ["id", "prompt", "images", "ratio"].iter().any(|key| value["generation"][*key] != current[*key])
                    || !value["response"].is_object() {
                    return Err("生图响应与请求不一致".into());
                }
                return Ok(value);
            }
        }
        if started.elapsed() >= timeout { return Err("等待生图响应超时；保留原调用 id，不要重复生图".into()); }
        std::thread::sleep(interval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_wait_ignores_old_response_and_returns_matching_success_or_error() {
        let root = std::env::temp_dir().join(format!("agent wait ' 测试 {}", uuid::Uuid::new_v4()));
        for folder in ["generation-requests", "generation-responses"] { std::fs::create_dir_all(root.join(folder)).unwrap(); }
        let id = uuid::Uuid::new_v4().to_string();
        let name = root.file_name().unwrap().to_string_lossy();
        let request_path = root.join("generation-requests").join(format!("{name}.json"));
        let response_path = root.join("generation-responses").join(format!("{name}.json"));
        let request = json!({"id":id,"prompt":"test","images":[],"ratio":null});
        std::fs::write(&request_path, request.to_string()).unwrap();
        for response in [json!({"images":["/image.png"]}), json!({"error":"provider failed"})] {
            std::fs::write(&response_path, json!({"generation":{"id":"old"},"response":{}}).to_string()).unwrap();
            let expected = json!({"generation":request,"response":response});
            let path = response_path.clone(); let value = expected.clone();
            let writer = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(30));
                let temp = path.with_extension("tmp");
                std::fs::write(&temp, value.to_string()).unwrap();
                #[cfg(windows)]
                std::fs::remove_file(&path).unwrap();
                std::fs::rename(temp, path).unwrap();
            });
            assert_eq!(wait(&root, &id, Duration::from_secs(2), Duration::from_millis(5)).unwrap(), expected);
            writer.join().unwrap();
        }
        std::fs::remove_file(&response_path).unwrap();
        assert!(wait(&root, &id, Duration::ZERO, Duration::ZERO).unwrap_err().contains("超时"));
        assert!(wait(&root, &uuid::Uuid::new_v4().to_string(), Duration::ZERO, Duration::ZERO).unwrap_err().contains("身份"));
        let mut changed = request.clone(); changed["prompt"] = json!("changed");
        std::fs::write(&response_path, json!({"generation":changed,"response":{}}).to_string()).unwrap();
        assert!(wait(&root, &id, Duration::ZERO, Duration::ZERO).unwrap_err().contains("不一致"));
        let mut no_ratio = request.clone(); no_ratio.as_object_mut().unwrap().remove("ratio");
        std::fs::write(&request_path, no_ratio.to_string()).unwrap();
        std::fs::write(&response_path, json!({"generation":request,"response":{"images":["/image.png"]}}).to_string()).unwrap();
        assert!(wait(&root, &id, Duration::ZERO, Duration::ZERO).is_ok());
        std::fs::remove_file(&response_path).unwrap();
        let cancel_path = root.join("completion.json");
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            std::fs::write(cancel_path, "{}").unwrap();
        });
        assert!(wait(&root, &id, Duration::from_secs(2), Duration::from_millis(5)).unwrap_err().contains("停止"));
        cancel.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
