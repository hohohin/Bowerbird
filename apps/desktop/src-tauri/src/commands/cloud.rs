use chrono::Utc;
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

#[tauri::command]
pub async fn cloud_restore_session(
    auth: State<'_, AuthClient>,
) -> Result<AuthSnapshot, AppError> {
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
    entitlement: State<'_, EntitlementService>,
) -> Result<EntitlementSnapshot, AppError> {
    Ok(entitlement.current(Utc::now()))
}

#[tauri::command]
pub async fn cloud_sync_entitlement(
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
) -> Result<EntitlementSnapshot, AppError> {
    entitlement.sync(&auth).await
}
