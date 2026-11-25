use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

const BUNDLED: &[u8] = include_bytes!("source_browser_site_rules.json");
pub(crate) const VERSION: u8 = 1;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SiteRules {
    version: u8,
    pinterest: PinterestRules,
    xiaohongshu: XiaohongshuRules,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PinterestRules {
    lens_button_labels: Vec<String>,
    lens_popover_label: String,
    pin_wrapper: String,
    hover_overlay: String,
    hover_decorations: Vec<String>,
    hidden_toolbar_items: Vec<String>,
    toolbar_id: String,
    toolbar_icon: String,
    sidebar: String,
    main_class: String,
    lens_image_container: String,
    lens_image_placeholder: String,
    lens_cropper: String,
    video_indexes: Vec<String>,
    relay_video_path: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct XiaohongshuRules {
    note_card_class: String,
    video_index: String,
    stream_path: String,
    variant_url_keys: Vec<String>,
    video_url_keys: Vec<String>,
}

fn labels(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 96 && !value.chars().any(char::is_control)
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn field_path(value: &str) -> bool {
    value.split('.').count() <= 8 && value.split('.').all(field_key)
}

fn field_key(value: &str) -> bool {
    identifier(value) && !matches!(value, "__proto__" | "constructor" | "prototype")
}

fn bounded_list(values: &[String], validate: fn(&str) -> bool) -> bool {
    (1..=12).contains(&values.len()) && values.iter().all(|value| validate(value))
}

fn parse(payload: &[u8]) -> Option<SiteRules> {
    let rules: SiteRules = serde_json::from_slice(payload).ok()?;
    let pin = &rules.pinterest;
    let note = &rules.xiaohongshu;
    (rules.version == VERSION
        && bounded_list(&pin.lens_button_labels, labels)
        && labels(&pin.lens_popover_label)
        && [
            &pin.pin_wrapper,
            &pin.hover_overlay,
            &pin.toolbar_id,
            &pin.toolbar_icon,
            &pin.sidebar,
            &pin.main_class,
            &pin.lens_image_container,
            &pin.lens_image_placeholder,
            &pin.lens_cropper,
            &note.note_card_class,
        ]
        .into_iter()
        .all(|id| identifier(id))
        && bounded_list(&pin.hover_decorations, identifier)
        && bounded_list(&pin.hidden_toolbar_items, identifier)
        && bounded_list(&pin.video_indexes, field_path)
        && field_path(&pin.relay_video_path)
        && field_path(&note.video_index)
        && field_path(&note.stream_path)
        && bounded_list(&note.variant_url_keys, field_key)
        && bounded_list(&note.video_url_keys, field_key))
    .then_some(rules)
}

// A future native update source can supply signed bytes and a key pinned in the app.
// Neither the browsing document nor the payload chooses the signing key.
struct SignedRules<'a> {
    payload: &'a [u8],
    signature: &'a [u8],
    pinned_key: &'a [u8; 32],
}

fn select(candidate: Option<SignedRules<'_>>) -> SiteRules {
    candidate
        .and_then(|update| {
            if update.payload.len() > 16 * 1024 {
                return None;
            }
            UnparsedPublicKey::new(&ED25519, update.pinned_key)
                .verify(update.payload, update.signature)
                .ok()?;
            parse(update.payload)
        })
        .unwrap_or_else(|| parse(BUNDLED).expect("valid built-in source browser site rules"))
}

pub(crate) fn render(script: &str) -> String {
    static RULES: OnceLock<String> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        serde_json::to_string(&select(None)).expect("serializable source browser site rules")
    });
    script.replacen("__BOWERBIRD_SITE_RULES__", rules, 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    #[test]
    fn source_browser_site_rules_require_a_valid_signature_and_schema() {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[11; 32]).unwrap();
        let pinned_key = signer.public_key().as_ref().try_into().unwrap();
        let mut modified: serde_json::Value = serde_json::from_slice(BUNDLED).unwrap();
        modified["pinterest"]["lensButtonLabels"][0] = "Search with Lens".into();
        let valid = serde_json::to_vec(&modified).unwrap();
        let signature = signer.sign(&valid);
        let load = |payload: &[u8], signature: &[u8]| {
            select(Some(SignedRules {
                payload,
                signature,
                pinned_key,
            }))
        };
        assert_eq!(
            load(&valid, signature.as_ref())
                .pinterest
                .lens_button_labels[0],
            "Search with Lens"
        );
        assert_eq!(
            load(&valid, &[0; 64]).pinterest.lens_button_labels[0],
            "Lens"
        );
        modified["version"] = 2.into();
        let wrong_version = serde_json::to_vec(&modified).unwrap();
        assert_eq!(
            load(&wrong_version, signer.sign(&wrong_version).as_ref())
                .pinterest
                .lens_button_labels[0],
            "Lens"
        );
        modified["version"] = 1.into();
        modified["xiaohongshu"]["streamPath"] = "constructor.prototype".into();
        let invalid_path = serde_json::to_vec(&modified).unwrap();
        assert_eq!(
            load(&invalid_path, signer.sign(&invalid_path).as_ref())
                .pinterest
                .lens_button_labels[0],
            "Lens"
        );
        assert!(render("const rules = __BOWERBIRD_SITE_RULES__;").contains("note.noteDetailMap"));
    }
}
