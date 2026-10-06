//! macOS debug builds use a stable helper so recompilation does not invalidate
//! the Keychain CDHash partition. Release builds retain the platform backend.
use std::io::Write;
use std::process::{Command, Stdio};

pub struct DevKeychain;

fn failure(message: impl Into<String>) -> keyring::Error {
    keyring::Error::PlatformFailure(Box::new(std::io::Error::other(message.into())))
}

impl DevKeychain {
    fn request(&self, operation: &str, secret: Option<&[u8]>) -> keyring::Result<Vec<u8>> {
        let app = std::env::current_exe().map_err(|_| failure("无法定位开发应用"))?;
        let helper = app.with_file_name("bowerbird-dev-keychain");
        // Authenticate the helper before sending any secret. Its certificate
        // requirement must match the signed desktop, with its own identifier.
        let signature = Command::new("/usr/bin/codesign")
            .args(["-d", "-r-"])
            .arg(&app)
            .output()
            .map_err(|_| failure("无法检查开发签名"))?;
        let requirement = String::from_utf8_lossy(&signature.stdout);
        let rule = requirement
            .trim()
            .strip_prefix("designated => ")
            .filter(|rule| {
                rule.starts_with("identifier \"com.bowerbird.desktop\" and certificate ")
            })
            .filter(|_| signature.status.success())
            .ok_or_else(|| failure("开发应用未使用稳定签名，请通过 tauri dev 启动"))?
            .replacen(
                "\"com.bowerbird.desktop\"",
                "\"com.bowerbird.desktop.dev-keychain\"",
                1,
            );
        let verification = Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict", "--test-requirement"])
            .arg(format!("={rule}"))
            .arg(&helper)
            .output()
            .map_err(|_| failure("无法验证开发凭据辅助程序"))?;
        if !verification.status.success() {
            return Err(failure(
                "开发凭据辅助程序缺失或签名不匹配，请通过 tauri dev 重新启动",
            ));
        }
        let mut child = Command::new(helper)
            .arg(operation)
            .stdin(if secret.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| failure("无法启动开发凭据辅助程序"))?;
        if let Some(secret) = secret {
            let result = child.stdin.take().unwrap().write_all(secret);
            if result.is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failure("无法传递开发凭据"));
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|_| failure("开发凭据辅助程序未完成"))?;
        match output.status.code() {
            Some(0) => Ok(output.stdout),
            Some(3) => Err(keyring::Error::NoEntry),
            _ => Err(failure("钥匙串访问未获授权或失败，请检查系统授权提示")),
        }
    }
}

impl keyring::credential::CredentialApi for DevKeychain {
    fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
        self.request("set", Some(secret)).map(|_| ())
    }
    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        self.request("get", None)
    }
    fn delete_credential(&self) -> keyring::Result<()> {
        self.request("delete", None).map(|_| ())
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
