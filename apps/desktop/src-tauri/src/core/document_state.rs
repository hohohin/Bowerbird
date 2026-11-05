//! The same Markdown fingerprint and node boundary as src/lib/documentState.ts.
use base64::Engine;
use serde_json::Value;

fn valid_node(node: &Value, depth: usize, count: &mut usize) -> bool {
    *count += 1;
    if *count > 100000 || depth > 128 { return false; }
    if node["text"].is_string() { return node.get("children").is_none(); }
    node["type"].is_string() && node["id"].is_string() && node["children"].as_array().is_some_and(|children| !children.is_empty() && children.iter().all(|child| valid_node(child, depth + 1, count)))
}
pub fn has_current_rich_state(source: &str) -> bool {
    static FOOTER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\r?\n\r?\n<!-- bowerbird-document:1:([A-Za-z0-9+/=]+) -->\s*$").unwrap());
    let Some(captures) = FOOTER.captures(source) else { return false; };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&captures[1]) else { return false; };
    let Ok(state) = serde_json::from_slice::<Value>(&bytes) else { return false; };
    let normalized = source[..captures.get(0).unwrap().start()].replace("\r\n", "\n").replace('\r', "\n");
    let canonical = format!("{}\n", normalized.trim_end());
    // JS for-of yields Unicode characters; charCodeAt(0) uses the first UTF-16 unit.
    let hash = canonical.chars().fold(2166136261u32, |hash, character| {
        let mut units = [0; 2];
        (hash ^ character.encode_utf16(&mut units)[0] as u32).wrapping_mul(16777619)
    });
    if state["hash"].as_str() != Some(&format!("{hash:x}")) { return false; }
    let mut count = 0;
    state["value"].as_array().is_some_and(|nodes| !nodes.is_empty() && nodes.iter().all(|node| node["type"].is_string() && valid_node(node, 0, &mut count)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frontend_state_matches_and_external_edits_invalidate_it() {
        let source = include_str!("../../../scripts/fixtures/text-editor-demo/rich-reference.md");
        assert!(has_current_rich_state(source));
        assert!(has_current_rich_state(&source.replace('\n', "\r\n")));
        assert!(!has_current_rich_state(&source.replace("Reference", "Changed")));
        assert!(!has_current_rich_state("<!-- bowerbird-document:1:!!!! -->"));
    }
}
