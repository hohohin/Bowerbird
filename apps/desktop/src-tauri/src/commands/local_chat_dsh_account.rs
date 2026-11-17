use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_configured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    authorize_url: Option<String>,
}

impl AccountStatus {
    fn new(state: &'static str) -> Self {
        Self {
            state,
            model_configured: None,
            attempt_id: None,
            authorize_url: None,
        }
    }
}

fn public_attempt(view: &Value) -> AppResult<Option<AccountStatus>> {
    let attempt = &view["attempt"];
    let phase = attempt["phase"].as_str();
    let state = match phase {
        Some("initializing" | "waiting-browser" | "exchanging" | "committing") => "pending",
        Some("failed") => "failed",
        Some("cancelled") => "cancelled",
        Some("expired") => "expired",
        _ => return Ok(None),
    };
    let mut status = AccountStatus::new(state);
    if state == "pending" {
        let id = attempt["id"]
            .as_str()
            .filter(|s| uuid::Uuid::parse_str(s).is_ok())
            .ok_or_else(|| error("DSH 登录请求标识无效，请重新授权"))?;
        status.attempt_id = Some(id.to_owned());
    }
    if phase == Some("waiting-browser") {
        let url = attempt["authorizeUrl"]
            .as_str()
            .and_then(|s| reqwest::Url::parse(s).ok())
            .filter(|url| {
                url.scheme() == "https"
                    && url.host_str() == Some("platform.deepseek.com")
                    && url.port().is_none()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path() == "/dsh/authorize"
                    && url.fragment().is_none()
            })
            .ok_or_else(|| error("DSH 未返回有效的 DeepSeek 官方授权地址，请重新授权"))?;
        status.authorize_url = Some(url.to_string());
    }
    Ok(Some(status))
}

// Directory failures mean connectivity is unknown. Only an authoritative catalog
// that omits the configured route/model establishes that setup is required.
fn configured(catalog: &Value) -> Option<bool> {
    let provider = catalog["default"]["provider"].as_str()?;
    let model = catalog["default"]["model"].as_str()?;
    let groups = catalog["groups"].as_array()?;
    if groups.iter().any(|group| {
        group["id"] == provider
            && group["models"]
                .as_array()
                .is_some_and(|items| items.iter().any(|m| m["id"] == model))
    }) {
        return Some(true);
    }
    if catalog["failures"]
        .as_array()?
        .iter()
        .any(|row| row["id"] == provider)
    {
        return None;
    }
    Some(false)
}

pub(in crate::commands::local_chat) async fn account(
    action: &str,
    attempt_id: Option<&str>,
) -> AppResult<AccountStatus> {
    if !matches!(action, "start" | "cancel" | "status" | "logout") {
        return Err(error("无效的 DSH 授权操作"));
    }
    if action == "start" {
        ensure_installed().await?;
    } else if host::discover().is_none() {
        return Ok(AccountStatus::new("notInstalled"));
    } else if !host::account_capable().await? {
        // Older hosts can still serve existing API-key sessions. Only explicit login
        // prepares the account-capable CLI.
        return Ok(AccountStatus::new("signedOut"));
    }
    let connection = host::ensure().await?;
    let host = dsh_local::Host::connect(&connection.base, connection.auth.as_deref()).await?;
    let client = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "locale": "zh-CN",
        "timezoneOffsetSeconds": chrono::Local::now().offset().local_minus_utc(),
    });
    let mut view = host.rpc("account/getState", json!({})).await?;
    // On a confirmed rejection the official profile reader clears its grant.
    // A temporary network failure leaves that grant and its model selection intact.
    let mut checked_profile = None;
    match action {
        "start" => {
            if view["status"] == "credential-stored" {
                checked_profile = Some(
                    host.rpc("account/getProfile", json!({"client":client}))
                        .await?,
                );
                if checked_profile.as_ref().is_some_and(Value::is_null) {
                    view = host.rpc("account/getState", json!({})).await?;
                }
            }
            let begin = view["status"] == "signed-out";
            if begin {
                view = host
                    .rpc(
                        "account/startSignIn",
                        json!({
                            "client":client, "callbackOrigin":connection.base, "loginSource":"web"
                        }),
                    )
                    .await?;
                checked_profile = None;
            }
            if checked_profile
                .as_ref()
                .is_some_and(|p| p["status"] == "ready")
                || begin
            {
                save_mode(true)?;
            }
        }
        "logout" => {
            if host.rpc("account/hasRunningAccountTasks", json!({})).await? == true {
                return Err(error("请等待当前 DeepSeek 账号任务完成后再退出登录"));
            }
            host.rpc("account/signOut", json!({"client": client})).await?;
            view = host.rpc("account/getState", json!({})).await?;
        }
        "cancel" => {
            let id = attempt_id
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .ok_or_else(|| error("请重新检测当前 DSH 登录状态"))?;
            view = host
                .rpc("account/cancelSignIn", json!({"attemptId":id}))
                .await?;
        }
        _ => {}
    }
    let stored = match view["status"].as_str() {
        Some("credential-stored") => true,
        Some("signed-out") => false,
        _ => return Err(error("无法识别本机 DSH 账户状态，请更新 DeepSeek Harness")),
    };
    let mut status = match public_attempt(&view)? {
        Some(attempt) if attempt.state == "pending" => return Ok(attempt),
        Some(attempt) if !stored => attempt,
        _ => AccountStatus::new(if stored { "unverified" } else { "signedOut" }),
    };
    let catalog = host.rpc("session/modelCatalog", json!({})).await.ok();
    status.model_configured = catalog.as_ref().and_then(configured);
    if !stored {
        return Ok(status);
    }
    let profile = match checked_profile {
        Some(profile) => profile,
        None => {
            host.rpc("account/getProfile", json!({"client":client}))
                .await?
        }
    };
    if profile.is_null() {
        if host.rpc("account/getState", json!({})).await?["status"] == "signed-out" {
            status.state = "signedOut";
        }
        return Ok(status);
    }
    if profile["status"] != "ready" {
        return Ok(status);
    }

    // This is the same post-login operation as the official UI. DSH checks
    // API key presence before saving the first available DeepSeek account model.
    if status.model_configured != Some(true)
        && (action == "start" || view["attempt"]["phase"] == "succeeded")
    {
        if host
            .rpc("session/initializeDefaultModel", json!({}))
            .await
            .is_ok()
        {
            status.model_configured = host
                .rpc("session/modelCatalog", json!({}))
                .await
                .ok()
                .as_ref()
                .and_then(configured);
        }
    }
    if status.model_configured == Some(true) {
        status.state = "verified";
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_official_authorization_link_and_public_fields_leave_host() {
        let mut view = json!({"attempt":{"id":uuid::Uuid::new_v4(), "phase":"waiting-browser",
            "secret":"private","authorizeUrl":"https://platform.deepseek.com/dsh/authorize?state=abc"}});
        let exposed = serde_json::to_value(public_attempt(&view).unwrap()).unwrap();
        assert_eq!(exposed["state"], "pending");
        assert!(exposed.get("secret").is_none());
        for url in [
            "https://platform.deepseek.com.example/dsh/authorize",
            "http://platform.deepseek.com/dsh/authorize",
            "https://a@platform.deepseek.com/dsh/authorize",
            "https://platform.deepseek.com/dsh/authorized",
            "https://platform.deepseek.com:8443/dsh/authorize",
        ] {
            view["attempt"]["authorizeUrl"] = json!(url);
            assert!(public_attempt(&view).is_err());
        }
    }

    #[test]
    fn model_readiness_checks_default_model_in_its_own_group() {
        let mut c = json!({"default":{"provider":"local","model":"m"},"groups":[{"id":"local","models":[{"id":"m"}]}],"failures":[]});
        assert_eq!(configured(&c), Some(true));
        c["default"]["provider"] = json!("other");
        assert_eq!(configured(&c), Some(false));
        c["failures"] = json!([{"id":"other"}]);
        assert_eq!(configured(&c), None);
    }
}
