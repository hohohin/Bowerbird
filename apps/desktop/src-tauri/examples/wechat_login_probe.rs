//! Read-only transport probe using the desktop's actual CloudClient and build config.
//! No application startup, user database, keyring, browser, or login-code exchange.
#![allow(dead_code)]

#[path = "../src/cloud/client.rs"]
mod client;
#[path = "../src/cloud/config.rs"]
pub mod config;
#[path = "../src/error.rs"]
mod error;
mod cloud {
    pub use crate::config;
}

fn qr_response(status: u16, payload: &serde_json::Value) -> Result<String, String> {
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}; login service returned an error"));
    }
    let valid_qr_url = payload["qrconnect_url"]
        .as_str()
        .and_then(|value| reqwest::Url::parse(value).ok())
        .is_some_and(|url| url.scheme() == "https" && url.host_str() == Some("open.weixin.qq.com"));
    if !valid_qr_url {
        return Err(format!("HTTP {status}; invalid QR response"));
    }
    Ok(format!("HTTP {status}; WeChat QR URL received"))
}

async fn probe(
    http: &reqwest::Client,
    endpoint: &str,
    public_key: Option<&str>,
) -> Result<String, String> {
    let mut request = http.get(endpoint);
    if let Some(key) = public_key {
        request = request.header("apikey", key);
    }
    let response = request
        // Bound a diagnostic run; the normal application keeps its existing timeout.
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| client::request_error("WeChat login GET failed", error).to_string())?;
    let status = response.status().as_u16();
    if public_key.is_none() {
        // Any HTTP response proves the connection reached an HTTP-speaking endpoint.
        return Ok(format!("HTTP {status}; website response received"));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| client::request_error("WeChat response read failed", error).to_string())?;
    qr_response(status, &payload)
}

#[cfg(windows)]
async fn windows_probe(endpoint: &str, public_key: &str) -> Result<String, String> {
    let system_root = std::env::var_os("SystemRoot").ok_or("SystemRoot missing")?;
    let curl = std::path::PathBuf::from(system_root).join("System32/curl.exe");
    let mut command = tokio::process::Command::new(curl);
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = command
        // Disable per-user curl config and keep certificate validation enabled.
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--http1.1",
            "--connect-timeout",
            "10",
            "--max-time",
            "20",
        ])
        .args([
            "--header",
            &format!("apikey: {public_key}"),
            "--write-out",
            "\n%{http_code}",
            endpoint,
        ])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("Windows curl unavailable: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .replace(endpoint, "[login endpoint]")
            .replace(public_key, "[public key]");
        return Err(format!(
            "Windows curl exit {:?}: {}",
            output.status.code(),
            detail.trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let (body, status) = text.rsplit_once('\n').ok_or("Missing curl HTTP status")?;
    let status = status
        .trim()
        .parse()
        .map_err(|_| "Invalid curl HTTP status")?;
    let payload =
        serde_json::from_str(body).map_err(|_| format!("HTTP {status}; non-JSON response"))?;
    qr_response(status, &payload)
}

#[cfg(not(windows))]
async fn windows_probe(_: &str, _: &str) -> Result<String, String> {
    Err("Windows curl comparison is only available on Windows".into())
}

async fn comparisons() -> Result<String, String> {
    let config = config::CloudConfig::official();
    let gateway = std::env::args().any(|arg| arg == "--account-gateway");
    let login_endpoint = if gateway { config.account_endpoint("wechat-login") } else { config.endpoint("wechat-login") };
    let endpoint = format!(
        "{}&state=dt_{}",
        login_endpoint.ok_or("Official cloud configuration missing")?,
        ulid::Ulid::new()
    );
    let public_key = config.supabase_publishable_key.clone().unwrap();
    let client = client::CloudClient::new(config).map_err(|error| error.to_string())?;
    let tls12 = reqwest::Client::builder()
        .max_tls_version(reqwest::tls::Version::TLS_1_2)
        .build()
        .map_err(|error| client::request_error("TLS 1.2 client build failed", error).to_string())?;
    let (app, tls12, windows, website) = tokio::join!(
        probe(client.http(), &endpoint, Some(&public_key)),
        probe(&tls12, &endpoint, Some(&public_key)),
        windows_probe(&endpoint, &public_key),
        probe(client.http(), "https://bowerbird.cn/", None),
    );
    let mut report = format!("Login route: {}\n\n", if gateway { "official account gateway" } else { "direct Supabase (legacy comparison)" });
    for (name, result) in [
        ("A. App default / login", app),
        ("B. App TLS 1.2 maximum / login", tls12),
        (
            "C. Windows curl / login (different TLS and proxy handling)",
            windows,
        ),
        ("D. App default / official website", website),
    ] {
        report.push_str(&format!(
            "{name}\n{}\n\n",
            match result {
                Ok(message) => format!("PASS: {message}"),
                Err(message) => format!("FAIL: {message}"),
            }
        ));
    }
    report.push_str("A/B changes only the offered TLS version. A/C changes client and proxy behavior; it does not isolate TLS alone.\nNo login was performed. No proxy, certificate, or system settings were changed.\n");
    Ok(report)
}

#[tokio::main]
async fn main() {
    println!("Running four read-only comparisons (each limited to 20 seconds)...");
    let result = comparisons().await;
    let report = format!(
        "Bowerbird WeChat login diagnostic v2\nVersion: {}\nOS: {} / {}\nUTC: {}\nClient: desktop CloudClient, 20s diagnostic timeout\n\n{}\n",
        env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH,
        chrono::Utc::now().to_rfc3339(),
        match &result { Ok(message) => message.clone(), Err(message) => format!("Diagnostic setup failed: {message}") }
    );
    println!("{report}");
    let path = std::env::current_exe()
        .unwrap()
        .with_file_name("wechat-login-diagnostic.txt");
    match std::fs::write(&path, &report) {
        Ok(()) => println!("Report: {}", path.display()),
        Err(error) => eprintln!("Could not save report: {error}"),
    }
    if !std::env::args().any(|arg| arg == "--no-wait") {
        println!("Press Enter to close.");
        let _ = std::io::stdin().read_line(&mut String::new());
    }
    if result.is_err() {
        std::process::exit(1);
    }
}
