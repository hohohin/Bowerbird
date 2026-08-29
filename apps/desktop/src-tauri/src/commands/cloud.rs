use tauri::State;

use crate::cloud::auth::AuthSnapshot;
use crate::cloud::entitlement::EntitlementSnapshot;
use crate::cloud::{AuthClient, EntitlementService};
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
    entitlement.clear()?;
    auth.logout()
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
