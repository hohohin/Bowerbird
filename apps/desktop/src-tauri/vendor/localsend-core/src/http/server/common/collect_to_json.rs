use crate::http::server::common::error::AppError;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use serde::de::DeserializeOwned;

pub(crate) trait CollectToJson {
    async fn collect_to_json<T: DeserializeOwned>(self) -> Result<T, AppError>;
}

impl CollectToJson for Incoming {
    async fn collect_to_json<T: DeserializeOwned>(self) -> Result<T, AppError> {
        // Bowerbird: metadata must never consume unbounded memory before validation.
        let bytes = http_body_util::Limited::new(self, 256 * 1024)
            .collect().await.map_err(|_| AppError::BadRequest("JSON body exceeds 256 KiB".to_string()))?.to_bytes();
        serde_json::from_slice::<T>(&bytes).map_err(|err| {
            tracing::warn!("Failed to parse JSON body: {err:#}");
            AppError::BadRequest("Invalid JSON body".to_string())
        })
    }
}
