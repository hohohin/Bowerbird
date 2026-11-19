use tauri::State;

use crate::cloud::auth::AuthSnapshot;
use crate::cloud::entitlement::{CodeRedemption, EntitlementSnapshot};
use crate::cloud::{AuthClient, CloudClient, EntitlementService};
use crate::error::AppError;

#[tauri::command]
pub async fn cloud_auth_snapshot(auth: State<'_, AuthClient>) -> Result<AuthSnapshot, AppError> {
    Ok(auth.snapshot())
}

#[tauri::command]
pub async fn cloud_start_email_login(
    auth: State<'_, AuthClient>,
    email: String,
) -> Result<(), AppError> {
    auth.start_email_login(&email).await
}

/// 发起微信扫码登录；返回系统浏览器要打开的二维码页 URL（由前端 open）。
#[tauri::command]
pub async fn cloud_start_wechat_login(auth: State<'_, AuthClient>) -> Result<String, AppError> {
    auth.start_wechat_login().await
}

#[tauri::command]
pub async fn cloud_restore_session(auth: State<'_, AuthClient>) -> Result<AuthSnapshot, AppError> {
    auth.restore().await
}

#[tauri::command]
pub async fn cloud_logout(
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
) -> Result<AuthSnapshot, AppError> {
    // Logout waits for account-bound cache writes, then removes any result they
    // completed. Clearing first could let an in-flight sync recreate the cache.
    let result = auth.logout();
    entitlement.clear()?;
    result
}

#[tauri::command]
pub async fn cloud_entitlement(
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
) -> Result<EntitlementSnapshot, AppError> {
    // 缓存 Fresh 时是纯本地读；未签名缓存在重启/超 6h 后判 Invalid，已登录则在此在线
    // 自愈一次，避免 UI 把 Pro 显示成 free 直到用户手动刷新（门控路径早已走 current_or_sync）。
    Ok(entitlement.current_or_sync(&auth).await)
}

#[tauri::command]
pub async fn cloud_sync_entitlement(
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
) -> Result<EntitlementSnapshot, AppError> {
    entitlement.sync(&auth).await
}

#[tauri::command]
pub async fn cloud_start_pro_trial(
    auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, user_id: Option<String>,
) -> Result<EntitlementSnapshot, AppError> {
    let user_id = user_id.or_else(|| auth.snapshot().user_id)
        .ok_or_else(|| AppError::Cloud("请先登录 Bowerbird 账号".into()))?;
    entitlement.start_trial(&auth, &user_id).await
}

#[tauri::command]
pub async fn cloud_redeem_code(
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
    code: String,
) -> Result<CodeRedemption, AppError> {
    entitlement.redeem_code(&auth, &code).await
}

#[derive(serde::Deserialize, serde::Serialize)]
pub struct CheckoutRequest {
    product: String,
    idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_amount_yuan: Option<u32>,
}

async fn checkout_request(
    auth: &AuthClient, cloud: &CloudClient, user_id: &str,
    function: &str, body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    if auth.snapshot().user_id.as_deref() != Some(user_id) {
        return Err(AppError::Cloud("账号已切换，请重新打开购买页面".into()));
    }
    let url = cloud.config().account_endpoint(function)
        .ok_or_else(|| AppError::Cloud("购买服务暂不可用".into()))?;
    let request = if let Some(body) = body { cloud.http().post(url).json(&body) } else { cloud.http().get(url) }
        .timeout(std::time::Duration::from_secs(30));
    let response = auth.send_authorized_for_user(request, "支付请求未完成，请查询原订单", user_id).await?;
    let success = response.status().is_success();
    let value: serde_json::Value = response.json().await
        .map_err(|_| AppError::Cloud("暂时无法读取支付状态，请查询原订单".into()))?;
    if auth.snapshot().user_id.as_deref() != Some(user_id) {
        return Err(AppError::Cloud("账号已切换，请重新打开购买页面".into()));
    }
    if !success {
        let message = value.get("error").and_then(|e| e.get("message")).and_then(|s| s.as_str())
            .unwrap_or("支付请求未完成，请查询原订单");
        return Err(AppError::Cloud(message.to_owned()));
    }
    Ok(value)
}

#[tauri::command]
pub async fn cloud_checkout_capability(auth: State<'_, AuthClient>, cloud: State<'_, CloudClient>, user_id: String) -> Result<serde_json::Value, AppError> {
    checkout_request(&auth, &cloud, &user_id, "create-checkout", None).await
}

#[tauri::command]
pub async fn cloud_create_checkout(auth: State<'_, AuthClient>, cloud: State<'_, CloudClient>, user_id: String, request: CheckoutRequest) -> Result<serde_json::Value, AppError> {
    checkout_request(&auth, &cloud, &user_id, "create-checkout", Some(serde_json::to_value(request)?)).await
}

#[tauri::command]
pub async fn cloud_checkout_status(auth: State<'_, AuthClient>, cloud: State<'_, CloudClient>, user_id: String, order_id: Option<String>) -> Result<serde_json::Value, AppError> {
    let body = order_id.map(|id| serde_json::json!({ "order_id": id })).unwrap_or(serde_json::json!({}));
    checkout_request(&auth, &cloud, &user_id, "checkout-status", Some(body)).await
}
