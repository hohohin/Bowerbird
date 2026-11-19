//! Read-only GPU detection and NVIDIA's public driver catalog. Never executes installers.
use serde::{Serialize, Deserialize};
use serde_json::{json, Value};
use std::time::Duration;

const DRIVER_SITE: &str = "https://www.nvidia.cn/drivers/";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu { pub name: String, pub driver: Option<String>, pub memory_mib: Option<u64> }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub gpus: Vec<Gpu>, pub driver_required: bool, pub issue: Option<String>,
    #[serde(skip)] os_id: Option<u32>,
}
#[derive(Clone, Serialize)]
pub struct DriverDownload { pub url: String, pub message: String }

fn modern(driver: &str) -> bool {
    driver.split('.').next().and_then(|v| v.parse::<u32>().ok()).is_some_and(|v| v >= 580)
}
fn parse_smi(text: &str) -> Vec<Gpu> {
    text.lines().filter_map(|line| {
        let fields: Vec<_> = line.split(',').map(str::trim).collect();
        if fields.len() != 3 || fields[0].is_empty() { return None; }
        Some(Gpu { name: fields[0].into(), driver: fields[1].split('.').all(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit())).then(|| fields[1].into()), memory_mib: fields[2].parse().ok() })
    }).collect()
}
fn classify(gpus: Vec<Gpu>, os_id: Option<u32>) -> Hardware {
    let driver_required = !gpus.is_empty() && !gpus.iter().any(|gpu| gpu.driver.as_deref().is_some_and(modern));
    let issue = if gpus.is_empty() { Some("未能识别 NVIDIA 显卡，此安装包暂不可安装。请在 Windows 设备管理器确认显卡已启用且驱动正常；仅有 AMD／Intel 显卡不适用此 NVIDIA 安装包。".into()) }
        else if driver_required { Some("此 ComfyUI 安装包需要 NVIDIA 580 或更新驱动，可点击下方按钮下载对应驱动，安装后返回应用重新检测".into()) }
        else { None };
    Hardware { gpus, driver_required, issue, os_id }
}
async fn output(name: &str, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new(name);
    command.args(args).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let result = tokio::time::timeout(Duration::from_secs(10), command.output()).await.ok()?.ok()?;
    result.status.success().then(|| String::from_utf8_lossy(&result.stdout).trim_start_matches('\u{feff}').trim().to_owned())
}
pub async fn detect() -> Hardware {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Hardware { gpus: vec![], driver_required: false, os_id: None, issue: Some("一键安装目前支持 Windows x64 + NVIDIA；其他系统请连接已有 ComfyUI".into()) };
    }
    let (smi, system) = tokio::join!(
        output("nvidia-smi", &["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"]),
        output("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $os=Get-CimInstance Win32_OperatingSystem; $gpu=@(Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -match 'VEN_10DE' } | ForEach-Object { $_.Name }); @{build=$os.BuildNumber;version=$os.Version;productType=$os.ProductType;gpus=$gpu} | ConvertTo-Json -Compress"])
    );
    let system: Value = system.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(Value::Null);
    let mut gpus = smi.as_deref().map(parse_smi).unwrap_or_default();
    if gpus.is_empty() {
        gpus = system["gpus"].as_array().into_iter().flatten().filter_map(|v| v.as_str())
            .map(|name| Gpu { name: name.into(), driver: None, memory_mib: None }).collect();
    }
    let os_id = if system["productType"].as_u64() == Some(1) && system["version"].as_str().is_some_and(|v| v.starts_with("10.")) {
        system["build"].as_str().and_then(|v| v.parse::<u32>().ok()).map(|build| if build >= 22000 { 135 } else { 57 })
    } else { None };
    classify(gpus, os_id)
}
fn normalized(name: &str) -> String {
    let name = name.trim().to_ascii_lowercase();
    name.strip_prefix("nvidia ").unwrap_or(&name).split_whitespace().collect::<Vec<_>>().join(" ")
}
fn product(catalog: &Value, name: &str, os: u32) -> Option<(u64,u64)> {
    let rows = catalog["ProductNames"].as_object()?;
    let mut matches = rows.values().filter(|row| row["OperatingSystemID"].as_u64() == Some(os as u64)
        && row["ProductNameMeta"].as_str().and_then(|v| v.split(" | ").nth(1)).is_some_and(|v| normalized(v) == normalized(name)));
    let row = matches.next()?;
    let result = (row["ProductSeriesID"].as_u64()?,row["ProductFamilyID"].as_u64()?);
    // Ambiguous names must never silently select a different board or notebook driver.
    if matches.any(|row| (row["ProductSeriesID"].as_u64(),row["ProductFamilyID"].as_u64()) != (Some(result.0),Some(result.1))) { return None; }
    Some(result)
}
fn download_result(response: &Value) -> Option<DriverDownload> {
    let info = &response["IDS"][0]["downloadInfo"];
    let version = info["Version"].as_str()?;
    if info["Success"] != "1" || info["IsBeta"] != "0" || !modern(version) { return None; }
    let url = reqwest::Url::parse(info["DownloadURL"].as_str()?).ok()?;
    if url.scheme() != "https" || !matches!(url.host_str(), Some("cn.download.nvidia.com" | "us.download.nvidia.com" | "international.download.nvidia.com"))
        || !url.username().is_empty() || url.password().is_some() || url.port().is_some() || url.query().is_some() || url.fragment().is_some()
        || !url.path().starts_with("/Windows/") || !url.path().ends_with(".exe") { return None; }
    Some(DriverDownload { url: url.into(), message: format!("已匹配 NVIDIA 驱动 {version}，将通过浏览器下载。下载后运行 NVIDIA 安装程序，按提示重启电脑，再返回本卡片继续安装环境。") })
}
async fn get(http: &reqwest::Client, url: reqwest::Url) -> Result<Value, reqwest::Error> {
    http.get(url).send().await?.error_for_status()?.json().await
}
pub async fn lookup(hardware: &Hardware) -> DriverDownload {
    let fallback = || DriverDownload { url: DRIVER_SITE.into(), message: "未能自动匹配驱动，将打开 NVIDIA 官方下载页。请按上方显卡型号选择驱动；完成安装并按提示重启后，返回本卡片继续。".into() };
    let Some(gpu) = hardware.gpus.first() else { return fallback(); };
    let Some(os) = hardware.os_id else { return fallback(); };
    // Different GPUs may require different driver branches; leave selection to NVIDIA.
    if hardware.gpus.iter().any(|v| normalized(&v.name) != normalized(&gpu.name)) { return fallback(); }
    let Ok(http) = reqwest::Client::builder().no_proxy().https_only(true).redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Bowerbird/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(20)).build() else { return fallback(); };
    let mut url = reqwest::Url::parse("https://gfwsl.geforce.cn/nvidia_web_services/controller.php").unwrap();
    let payload = json!({"pt":"0","pst":"0","d2":"0","d4":"0","d5":"0","driverType":"all","sa":"1"}).to_string();
    url.query_pairs_mut().append_key_only(&payload);
    let query = format!("com.nvidia.services.Drivers.getMenuArrayProductOperatingSystemMetaData/{}",url.query().unwrap());
    url.set_query(Some(&query));
    let Ok(catalog) = get(&http,url).await else { return fallback(); };
    let Some((series,family)) = product(&catalog,&gpu.name,os) else { return fallback(); };
    for studio in ["1","0"] {
        let mut url = reqwest::Url::parse("https://gfwsl.geforce.cn/services_toolkit/services/com/nvidia/services/AjaxDriverService.php").unwrap();
        url.query_pairs_mut().extend_pairs([("func","DriverManualLookup"),("psid",&series.to_string()),("pfid",&family.to_string()),("osID",&os.to_string()),
            ("languageCode","2052"),("beta","0"),("dltype","1"),("dch","1"),("upCRD",studio),("sort1","1"),("numberOfResults","1")]);
        if let Ok(response) = get(&http,url).await {
            if let Some(download) = download_result(&response) { return download; }
        }
    }
    fallback()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn h3_gpu_driver_detection_and_exact_product_match() {
        let gpus=parse_smi("NVIDIA GeForce RTX 3060, 576.80, 12288\nNVIDIA GeForce RTX 3060, 576.80, N/A");
        assert_eq!(gpus.len(),2);assert_eq!(gpus[0].memory_mib,Some(12288));assert!(classify(gpus,Some(135)).driver_required);
        assert!(!classify(parse_smi("NVIDIA GeForce RTX 3060, 581.80, 12288"),Some(135)).driver_required);
        assert!(!classify(vec![],Some(135)).driver_required);
        assert!(classify(vec![Gpu{name:"NVIDIA GeForce RTX 3060".into(),driver:None,memory_mib:None}],Some(135)).driver_required);
        let catalog=json!({"ProductNames":{"0":{"ProductNameMeta":"RTX 30 | GeForce RTX 3060 | Windows 11","OperatingSystemID":135,"ProductSeriesID":120,"ProductFamilyID":942}}});
        assert_eq!(product(&catalog,"NVIDIA GeForce RTX 3060",135),Some((120,942)));
        assert_eq!(product(&catalog,"NVIDIA GeForce RTX 3060 Laptop GPU",135),None);
        assert_eq!(product(&catalog,"NVIDIA GeForce RTX 3060 Ti",135),None);
        assert_eq!(product(&catalog,"NVIDIA GeForce RTX 3060",57),None);
    }
    #[test]
    fn h3_driver_download_rejects_beta_old_and_untrusted_urls() {
        let mut info=json!({"Success":"1","IsBeta":"0","Version":"581.80","DownloadURL":"https://cn.download.nvidia.com/Windows/581.80/driver.exe"});
        let check=|info: &Value| download_result(&json!({"IDS":[{"downloadInfo":info}]}));
        assert!(check(&info).is_some());
        for url in ["http://cn.download.nvidia.com/Windows/driver.exe","https://cn.download.nvidia.com.evil.test/Windows/driver.exe","https://user@cn.download.nvidia.com/Windows/driver.exe","https://cn.download.nvidia.com/Windows/driver.exe?next=bad"] { info["DownloadURL"]=json!(url);assert!(check(&info).is_none()); }
        info["DownloadURL"]=json!("https://cn.download.nvidia.com/Windows/581.80/driver.exe");
        info["Version"]=json!("576.80");assert!(check(&info).is_none());
        info["Version"]=json!("581.80");info["IsBeta"]=json!("1");assert!(check(&info).is_none());
    }
    #[tokio::test]
    #[ignore = "read-only NVIDIA live catalog; never downloads or installs a driver"]
    async fn h3_nvidia_live_driver_lookup() {
        let hardware=classify(parse_smi("NVIDIA GeForce RTX 3060, 576.80, 12288"),Some(135));
        let result=lookup(&hardware).await;
        assert_ne!(result.url,DRIVER_SITE,"{}",result.message);
        assert!(result.url.ends_with(".exe"));
    }
}
