use super::*;

fn attributes(raw: &str) -> AppResult<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    let mut rest = raw.trim();
    while !rest.is_empty() {
        let (name, value) = rest.split_once('=').ok_or_else(invalid)?;
        let (value, tail) = if let Some(quoted) = value.strip_prefix('"') {
            let end = quoted.find('"').ok_or_else(invalid)?;
            (&quoted[..end], &quoted[end+1..])
        } else { value.split_once(',').map(|(v,t)|(v,t)).unwrap_or((value,"")) };
        if result.insert(name.trim().to_owned(), value.to_owned()).is_some() { return Err(invalid()); }
        rest = tail.trim_start_matches(',').trim();
    }
    Ok(result)
}

pub(super) fn parse_hls(text: &str, url: &str, kind: &'static str) -> AppResult<Hls> {
    let text = text.trim_start_matches('\u{feff}');
    if text.len() > MAX_MANIFEST || !text.starts_with("#EXTM3U") { return Err(invalid()); }
    let lines: Vec<_> = text.lines().map(str::trim).filter(|line|!line.is_empty()).collect();
    let mut variants = Vec::new();
    let mut audio = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if let Some(raw) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let attrs = attributes(raw)?;
            let next = lines.get(index+1).filter(|line|!line.starts_with('#')).ok_or_else(invalid)?;
            variants.push((attrs.get("BANDWIDTH").and_then(|s|s.parse::<u64>().ok()).unwrap_or(0), checked_url(url,next)?, attrs.get("AUDIO").cloned()));
        }
        if let Some(raw) = line.strip_prefix("#EXT-X-MEDIA:") {
            let attrs = attributes(raw)?;
            if attrs.get("TYPE").is_some_and(|v|v == "AUDIO") { audio.push(attrs); }
        }
        if line.starts_with("#EXT-X-SESSION-KEY:") { return Err(unsupported("加密视频")); }
    }
    if let Some((_, video, group)) = variants.into_iter().max_by_key(|v|v.0) {
        let audio = if let Some(group) = group {
            let selected = audio.iter().filter(|a|a.get("GROUP-ID") == Some(&group)).max_by_key(|a|a.get("DEFAULT").is_some_and(|v|v == "YES")).ok_or_else(invalid)?;
            selected.get("URI").map(|uri|checked_url(url,uri)).transpose()?
        } else { None };
        return Ok(Hls::Master { video, audio });
    }
    if !lines.contains(&"#EXT-X-ENDLIST") { return Err(unsupported("直播或尚未结束的分段视频")); }
    let mut track = Track { kind, init: None, segments: Vec::new(), duration: 0.0, start: 0.0, bounded_period: false };
    let mut duration = None;
    for line in lines {
        if line.starts_with("#EXT-X-BYTERANGE:") || line.starts_with("#EXT-X-PART:") || line.starts_with("#EXT-X-DISCONTINUITY") || line == "#EXT-X-GAP" {
            return Err(unsupported("字节范围、缺片或时间线切换的分段视频"));
        }
        if let Some(raw) = line.strip_prefix("#EXT-X-KEY:") {
            if attributes(raw)?.get("METHOD").is_none_or(|method|method != "NONE") { return Err(unsupported("加密视频")); }
        }
        if let Some(raw) = line.strip_prefix("#EXT-X-MAP:") {
            let attrs = attributes(raw)?;
            if attrs.contains_key("BYTERANGE") { return Err(unsupported("字节范围分段视频")); }
            let init = checked_url(url, attrs.get("URI").ok_or_else(invalid)?)?;
            if (track.init.is_none() && !track.segments.is_empty()) || track.init.as_ref().is_some_and(|old|old != &init) { return Err(unsupported("切换初始化片段的视频")); }
            track.init = Some(init);
        }
        if let Some(raw) = line.strip_prefix("#EXTINF:") {
            if duration.is_some() { return Err(invalid()); }
            let value = raw.split(',').next().ok_or_else(invalid)?.parse::<f64>().map_err(|_|invalid())?;
            if !value.is_finite() || value <= 0.0 { return Err(invalid()); }
            duration = Some(value);
        } else if !line.starts_with('#') {
            let seconds = duration.take().ok_or_else(invalid)?;
            track.duration += seconds;
            if track.duration > MAX_DURATION || track.segments.len() >= MAX_SEGMENTS { return Err(unsupported("时长或片段数量过多的视频")); }
            track.segments.push(Segment { url: checked_url(url,line)?, duration: seconds });
        }
    }
    if track.segments.is_empty() || duration.is_some() { return Err(invalid()); }
    Ok(Hls::Track(track))
}
