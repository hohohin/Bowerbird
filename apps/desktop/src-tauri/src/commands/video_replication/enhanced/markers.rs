use super::*;

pub(super) fn parse(prompt: &str) -> AppResult<(String, Vec<(String,String)>)> {
    let pattern = regex::Regex::new(r"\[\[([A-Za-z0-9_-]{1,40})\|([^\[\]\r\n]{1,200})\]\]").unwrap();
    let mut markers = Vec::new(); let mut ids = HashSet::new();
    for capture in pattern.captures_iter(prompt) {
        let id = capture[1].to_owned(); let text = capture[2].to_owned();
        if !ids.insert(id.clone()) || normalize(&text).is_empty() { return Err(error("台词标记编号重复或内容为空")); }
        markers.push((id,text));
    }
    let clean = pattern.replace_all(prompt,"$2").into_owned();
    if clean.contains("[[") || clean.contains("]]") { return Err(error("台词标记格式应为 [[编号|台词]]")); }
    Ok((clean,markers))
}
fn normalize(text: &str) -> String { text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect() }

/// Resolve only unique exact matches against provider words. Ambiguity stays explicit.
pub(super) fn align(markers: &[(String,String)], speech: &Value, offset: f64) -> Vec<Value> {
    let words: Vec<&Value> = speech["utterances"].as_array().into_iter().flatten()
        .flat_map(|u| u["words"].as_array().into_iter().flatten()).collect();
    markers.iter().map(|(id,text)| {
        let target = normalize(text); let mut matches = Vec::new();
        for start in 0..words.len() {
            let mut candidate = String::new();
            for end in start..words.len() {
                candidate.push_str(&normalize(field(words[end],"text")));
                if candidate == target { matches.push((start,end)); break; }
                if !target.starts_with(&candidate) { break; }
            }
        }
        if matches.len() == 1 {
            let (a,b) = matches[0];
            if let (Some(start),Some(end)) = (words[a]["startMs"].as_f64(),words[b]["endMs"].as_f64()) {
                return json!({"id":id,"text":text,"status":"aligned","localStart":start/1000.0,"localEnd":end/1000.0,"start":offset+start/1000.0,"end":offset+end/1000.0});
            }
        }
        json!({"id":id,"text":text,"status":if matches.len()>1 {"ambiguous"} else {"unmatched"}})
    }).collect()
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn markers_require_real_unique_word_evidence() {
        let (prompt,markers) = parse("说道：[[intro|你好。]]").unwrap();
        assert_eq!(prompt,"说道：你好。");
        let speech = json!({"utterances":[{"words":[{"text":"你","startMs":100,"endMs":200},{"text":"好","startMs":300,"endMs":500}]}]});
        let aligned = align(&markers,&speech,4.0);
        assert_eq!(aligned[0]["start"],4.1); assert_eq!(aligned[0]["end"],4.5);
        assert_eq!(align(&markers,&json!({"utterances":[{"text":"你好","startMs":100,"endMs":500}]}),0.0)[0]["status"],"unmatched");
        let twice=json!({"utterances":[speech["utterances"][0],speech["utterances"][0]]});
        assert_eq!(align(&markers,&twice,0.0)[0]["status"],"ambiguous");
        assert!(parse("[[x|你好]] [[x|你好]]").is_err());
        assert!(parse("[[bad]]").is_err());
    }
}
