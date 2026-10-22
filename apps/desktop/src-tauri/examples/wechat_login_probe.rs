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

async fn probe() -> Result<String, String> {
    let config = config::CloudConfig::official();
    let endpoint = config
        .endpoint("wechat-login")
        .ok_or("Official cloud configuration missing")?;
    let public_key = config.supabase_publishable_key.clone().unwrap();
    let client = client::CloudClient::new(config).map_err(|error| error.to_string())?;
    let response = client
        .http()
        .get(endpoint)
        .query(&[("state", format!("dt_{}", ulid::Ulid::new()))])
        .header("apikey", public_key)
        // Bound a diagnostic run; the normal application keeps its existing timeout.
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| client::request_error("WeChat login GET failed", error).to_string())?;
    let status = response.status();
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| client::request_error("WeChat response read failed", error).to_string())?;
    if !status.is_success() {
        // Only report the service's error code; never dump a response or credentials.
        return Err(format!(
            "HTTP {status}; service error: {}",
            payload["error"]["code"].as_str().unwrap_or("unknown")
        ));
    }
    let valid_qr_url = payload["qrconnect_url"]
        .as_str()
        .and_then(|value| reqwest::Url::parse(value).ok())
        .is_some_and(|url| url.scheme() == "https" && url.host_str() == Some("open.weixin.qq.com"));
    if !valid_qr_url {
        return Err(format!("HTTP {status}; invalid QR response"));
    }
    Ok(format!(
        "HTTP {status}; WeChat QR URL received. No login was performed."
    ))
}

#[tokio::main]
async fn main() {
    let result = probe().await;
    let report = format!(
        "Bowerbird WeChat login diagnostic\nVersion: {}\nOS: {} / {}\nUTC: {}\nClient: desktop CloudClient, 20s diagnostic timeout\n\n{}\n",
        env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH,
        chrono::Utc::now().to_rfc3339(),
        match &result { Ok(message) => format!("PASS: {message}"), Err(message) => format!("FAIL: {message}") }
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
