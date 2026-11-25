//! Session-only proof of an exact media drag past its source document's lifetime.
use super::{DragNotice, SourceMediaKind, capture_url};
use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{hmac, rand::SystemRandom};
use std::{collections::VecDeque, sync::Mutex, time::{Duration, Instant}};

struct DragEvidence {
    id: String,
    media: String,
    page: String,
    kind: SourceMediaKind,
    observed: Instant,
}

pub(crate) struct CaptureAdmissions {
    key: hmac::Key,
    recent: Mutex<VecDeque<DragEvidence>>,
}

fn proof_data(id: &str, media: &str, page: &str, kind: SourceMediaKind) -> Vec<u8> {
    serde_json::to_vec(&(id, media, page, kind)).expect("capture fields are serializable")
}

impl CaptureAdmissions {
    pub(crate) fn new() -> AppResult<Self> {
        let key = hmac::Key::generate(hmac::HMAC_SHA256, &SystemRandom::new())
            .map_err(|_| AppError::Other("无法初始化探索采集".into()))?;
        Ok(Self { key, recent: Mutex::new(VecDeque::new()) })
    }

    pub(super) fn remember(&self, notice: &DragNotice, current: &tauri::Url) {
        let (Some(media), Some(page)) = (&notice.image_url, &notice.page_url) else { return; };
        // Only direct HTTP(S) links may get proof. A live blob/MediaSource must
        // still be resolved by the originating document when the capture runs.
        if capture_url(media).is_err()
            || capture_url(page).ok().is_none_or(|page| page.origin() != current.origin())
        {
            return;
        }
        let mut recent = self.recent.lock().unwrap();
        if recent.iter().any(|drag| drag.id == notice.id) { return; }
        if recent.len() >= 64 { recent.pop_front(); }
        recent.push_back(DragEvidence {
            id: notice.id.clone(), media: media.clone(), page: page.clone(),
            kind: notice.media_kind.unwrap_or(SourceMediaKind::Image), observed: Instant::now(),
        });
    }

    pub(super) fn authorize(&self, id: &str, media: &str, page: &str, kind: SourceMediaKind) -> Option<String> {
        let mut recent = self.recent.lock().unwrap();
        recent.retain(|drag| drag.observed.elapsed() < Duration::from_secs(600));
        let index = recent.iter().position(|drag| {
            drag.id == id && drag.media == media && drag.page == page && drag.kind == kind
        })?;
        recent.remove(index);
        let tag = hmac::sign(&self.key, &proof_data(id, media, page, kind));
        Some(URL_SAFE_NO_PAD.encode(tag.as_ref()))
    }

    pub(super) fn verify(&self, proof: &str, id: &str, media: &str, page: &str, kind: SourceMediaKind) -> bool {
        if proof.len() != 43 { return false; }
        URL_SAFE_NO_PAD.decode(proof).ok().is_some_and(|tag| {
            hmac::verify(&self.key, &proof_data(id, media, page, kind), &tag).is_ok()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "1234567890abcdef1234567890abcdef";
    const PAGE: &str = "https://www.example.com/pin/1";
    const IMAGE: &str = "https://cdn.example.com/1.png?signature=one";

    fn notice(media: &str, kind: SourceMediaKind) -> DragNotice {
        DragNotice {
            id: ID.into(), image_url: Some(media.into()), page_url: Some(PAGE.into()),
            media_kind: Some(kind), poster_url: None,
        }
    }

    #[test]
    fn accepts_exact_source_notice_and_verifies_same_proof_for_session_retry() {
        let state = CaptureAdmissions::new().unwrap();
        let current = tauri::Url::parse("https://www.example.com/feed").unwrap();
        state.remember(&notice(IMAGE, SourceMediaKind::Image), &current);
        assert!(state.authorize(ID, IMAGE, PAGE, SourceMediaKind::Video).is_none());
        let proof = state.authorize(ID, IMAGE, PAGE, SourceMediaKind::Image).unwrap();
        assert!(state.authorize(ID, IMAGE, PAGE, SourceMediaKind::Image).is_none());
        for _ in 0..2 {
            assert!(state.verify(&proof, ID, IMAGE, PAGE, SourceMediaKind::Image));
        }
        assert!(!state.verify(&proof, ID, "https://cdn.example.com/2.png", PAGE, SourceMediaKind::Image));
        assert!(!state.verify(&proof, ID, IMAGE, PAGE, SourceMediaKind::Video));
        assert!(!state.verify(&proof, ID, IMAGE, "https://www.example.com/pin/2", SourceMediaKind::Image));
        assert!(!CaptureAdmissions::new().unwrap().verify(&proof, ID, IMAGE, PAGE, SourceMediaKind::Image));
    }

    #[test]
    fn refuses_cross_origin_notices_blob_and_invalid_addresses() {
        let state = CaptureAdmissions::new().unwrap();
        let different = tauri::Url::parse("https://elsewhere.example").unwrap();
        let same = tauri::Url::parse(PAGE).unwrap();
        state.remember(&notice(IMAGE, SourceMediaKind::Image), &different);
        assert!(state.authorize(ID, IMAGE, PAGE, SourceMediaKind::Image).is_none());
        for media in ["blob:https://www.example.com/id", "file:///media", "https://user:pw@cdn.example.com/video"] {
            state.remember(&notice(media, SourceMediaKind::Video), &same);
            assert!(state.authorize(ID, media, PAGE, SourceMediaKind::Video).is_none());
        }
    }
}
