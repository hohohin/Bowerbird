use super::*;
use quick_xml::{events::Event, Reader};

#[derive(Default, Debug)]
struct Element { name: String, attrs: BTreeMap<String, String>, text: String, children: Vec<Element> }
impl Element {
    fn attr(&self, name: &str) -> Option<&str> { self.attrs.get(name).map(String::as_str) }
    fn child(&self, name: &str) -> Option<&Self> { self.children.iter().find(|node|node.name == name) }
    fn has(&self, name: &str) -> bool { self.name == name || self.children.iter().any(|node|node.has(name)) }
}

fn xml(text: &str) -> AppResult<Element> {
    if text.len() > MAX_MANIFEST { return Err(invalid()); }
    let mut reader = Reader::from_str(text);
    let mut stack = vec![Element::default()];
    let mut count = 0;
    loop {
        let event = reader.read_event().map_err(|_|invalid())?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(event) | Event::Empty(event) => {
                count += 1;
                if count > 30_000 || stack.len() > 32 { return Err(invalid()); }
                let name = String::from_utf8(event.local_name().as_ref().to_vec()).map_err(|_|invalid())?;
                let mut node = Element { name, ..Default::default() };
                for attr in event.attributes() {
                    let attr = attr.map_err(|_|invalid())?;
                    let key = String::from_utf8(attr.key.local_name().as_ref().to_vec()).map_err(|_|invalid())?;
                    let value = attr.decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0,reader.decoder()).map_err(|_|invalid())?.into_owned();
                    node.attrs.insert(key, value);
                }
                if empty { stack.last_mut().ok_or_else(invalid)?.children.push(node); }
                else { stack.push(node); }
            }
            Event::End(_) => {
                if stack.len() < 2 { return Err(invalid()); }
                let node = stack.pop().ok_or_else(invalid)?;
                stack.last_mut().ok_or_else(invalid)?.children.push(node);
            }
            Event::Text(event) => stack.last_mut().ok_or_else(invalid)?.text.push_str(&event.decode().map_err(|_|invalid())?),
            Event::CData(event) => stack.last_mut().ok_or_else(invalid)?.text.push_str(&event.decode().map_err(|_|invalid())?),
            Event::GeneralRef(event) => {
                let name = event.decode().map_err(|_|invalid())?;
                let value = match name.as_ref() { "amp" => "&", "lt" => "<", "gt" => ">", "quot" => "\"", "apos" => "'", _ => return Err(invalid()) };
                stack.last_mut().ok_or_else(invalid)?.text.push_str(value);
            }
            Event::DocType(_) => return Err(unsupported("含外部定义的视频播放清单")),
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 || stack[0].children.len() != 1 { return Err(invalid()); }
    Ok(stack.remove(0).children.remove(0))
}

fn seconds(raw: &str) -> AppResult<f64> {
    let body = raw.strip_prefix("PT").ok_or_else(||unsupported("此时长格式的视频"))?;
    let mut number = String::new();
    let mut total = 0.0;
    for char in body.chars() {
        if char.is_ascii_digit() || char == '.' { number.push(char); }
        else {
            let value: f64 = number.parse().map_err(|_|invalid())?;
            number.clear();
            total += value * match char { 'H' => 3600.0, 'M' => 60.0, 'S' => 1.0, _ => return Err(invalid()) };
        }
    }
    if !number.is_empty() || !total.is_finite() || total < 0.0 || total > MAX_DURATION { return Err(invalid()); }
    Ok(total)
}

fn base_url(parent: &str, node: &Element) -> AppResult<String> {
    node.child("BaseURL").map(|value|checked_url(parent,value.text.trim())).unwrap_or_else(||Ok(parent.to_owned()))
}

fn template_value(raw: &str, id: &str, bandwidth: &str, number: u64, time: u64) -> AppResult<String> {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(position) = rest.find('$') {
        out.push_str(&rest[..position]);
        rest = &rest[position+1..];
        if let Some(tail) = rest.strip_prefix('$') { out.push('$'); rest = tail; continue; }
        let end = rest.find('$').ok_or_else(invalid)?;
        let variable = &rest[..end];
        let (name, width) = match variable.split_once('%') {
            Some((name, format)) => {
                let width = format.strip_prefix('0').and_then(|value|value.strip_suffix('d')).and_then(|value|value.parse::<usize>().ok()).filter(|width|(1..=20).contains(width)).ok_or_else(invalid)?;
                (name, width)
            },
            None => (variable, 0),
        };
        let value = match name { "RepresentationID" => id.to_owned(), "Bandwidth" => bandwidth.to_owned(), "Number" => format!("{number:0width$}"), "Time" => format!("{time:0width$}"), _ => return Err(unsupported("此分段地址模板的视频")) };
        out.push_str(&value);
        rest = &rest[end+1..];
    }
    out.push_str(rest);
    if out.len() > 8192 { return Err(invalid()); }
    Ok(out)
}

fn numeric(attrs: &BTreeMap<String,String>, name: &str, fallback: u64) -> AppResult<u64> {
    attrs.get(name).map(|value|value.parse().map_err(|_|invalid())).unwrap_or(Ok(fallback))
}

fn timeline(attrs: &BTreeMap<String,String>, lines: Option<&Element>, duration: f64) -> AppResult<Vec<(u64,u64)>> {
    let scale = numeric(attrs,"timescale",1)?;
    if scale == 0 { return Err(invalid()); }
    let offset = numeric(attrs,"presentationTimeOffset",0)?;
    let end = (duration * scale as f64).ceil();
    if !end.is_finite() || end > (u64::MAX - offset) as f64 { return Err(invalid()); }
    let end = offset.checked_add(end as u64).ok_or_else(invalid)?;
    let mut result = Vec::new();
    if let Some(timeline) = lines {
        let lines: Vec<_> = timeline.children.iter().filter(|node|node.name == "S").collect();
        let mut time = 0;
        for (index,node) in lines.iter().enumerate() {
            if let Some(raw) = node.attr("t") {
                let next = raw.parse().map_err(|_|invalid())?;
                if !result.is_empty() && next != time { return Err(unsupported("时间线有缺口或重叠的分段视频")); }
                time = next;
            }
            let span: u64 = node.attr("d").ok_or_else(invalid)?.parse().map_err(|_|invalid())?;
            if span == 0 { return Err(invalid()); }
            let repeat: i64 = node.attr("r").unwrap_or("0").parse().map_err(|_|invalid())?;
            let count = if repeat == -1 {
                let until = lines.get(index+1).and_then(|node|node.attr("t")).map(|raw|raw.parse::<u64>().map_err(|_|invalid())).transpose()?.unwrap_or(end);
                if until <= time { return Err(invalid()); }
                (until - time).div_ceil(span)
            } else if repeat >= 0 { repeat as u64 + 1 } else { return Err(invalid()); };
            if count > MAX_SEGMENTS as u64 || result.len() + count as usize > MAX_SEGMENTS { return Err(unsupported("片段数量过多的视频")); }
            for _ in 0..count {
                result.push((time,span));
                time = time.checked_add(span).ok_or_else(invalid)?;
            }
        }
    } else {
        let span = numeric(attrs,"duration",0)?;
        if span == 0 { return Err(unsupported("缺少有限分段时间线的视频")); }
        let first = offset / span * span;
        let count = (end-first).div_ceil(span);
        if count > MAX_SEGMENTS as u64 { return Err(unsupported("片段数量过多的视频")); }
        for index in 0..count { result.push((first.checked_add(index.checked_mul(span).ok_or_else(invalid)?).ok_or_else(invalid)?,span)); }
    }
    let first = result.first().ok_or_else(invalid)?;
    let last = result.last().ok_or_else(invalid)?;
    let last_end = last.0.checked_add(last.1).ok_or_else(invalid)?;
    if first.0 > offset || last_end < end { return Err(AppError::Other("视频分段清单未覆盖完整时长，未保存视频。".into())); }
    Ok(result)
}

fn representation(period: &Element, adaptation: &Element, representation: &Element, base: &str, duration: f64, kind: &'static str) -> AppResult<Track> {
    let base = base_url(&base_url(base,adaptation)?,representation)?;
    let mut attrs = BTreeMap::new();
    let mut lines = None;
    for node in [period, adaptation, representation] {
        if let Some(template) = node.child("SegmentTemplate") {
            attrs.extend(template.attrs.clone());
            if let Some(value) = template.child("SegmentTimeline") { lines = Some(value); }
        }
    }
    let init = attrs.get("initialization").ok_or_else(||unsupported("缺少初始化片段的视频"))?;
    let media = attrs.get("media").ok_or_else(||unsupported("此视频分段格式"))?;
    let id = representation.attr("id").unwrap_or("");
    let bandwidth = representation.attr("bandwidth").unwrap_or("0");
    let scale = numeric(&attrs,"timescale",1)?;
    let timeline = timeline(&attrs,lines,duration)?;
    let start = (numeric(&attrs,"presentationTimeOffset",0)? - timeline[0].0) as f64 / scale as f64;
    let number_offset = if lines.is_none() { numeric(&attrs,"presentationTimeOffset",0)? / numeric(&attrs,"duration",1)? } else { 0 };
    let start_number = numeric(&attrs,"startNumber",1)?.checked_add(number_offset).ok_or_else(invalid)?;
    let segments = timeline.into_iter().enumerate().map(|(index,(time,span))| {
        let relative = template_value(media,id,bandwidth,start_number.checked_add(index as u64).ok_or_else(invalid)?,time)?;
        Ok(Segment { url: checked_url(&base,&relative)?, duration: span as f64 / scale as f64 })
    }).collect::<AppResult<Vec<_>>>()?;
    Ok(Track { kind, init: Some(checked_url(&base,&template_value(init,id,bandwidth,start_number,0)?)?), segments, duration, start, bounded_period: true })
}

pub(super) fn parse_dash(text: &str, url: &str) -> AppResult<Vec<Track>> {
    let mpd = xml(text)?;
    if mpd.name != "MPD" { return Err(invalid()); }
    if mpd.attr("type").is_some_and(|value|value != "static") { return Err(unsupported("直播或动态分段视频")); }
    if mpd.has("ContentProtection") { return Err(unsupported("加密或受保护的视频")); }
    if mpd.has("SegmentBase") || mpd.has("SegmentList") { return Err(unsupported("此分段索引格式的视频")); }
    let periods: Vec<_> = mpd.children.iter().filter(|node|node.name == "Period").collect();
    if periods.len() != 1 { return Err(unsupported("多时间段的视频播放清单")); }
    let period = periods[0];
    let duration = period.attr("duration").or_else(||mpd.attr("mediaPresentationDuration")).ok_or_else(||unsupported("没有结束时间的视频"))?;
    let duration = seconds(duration)?;
    if duration <= 0.0 { return Err(invalid()); }
    if period.attr("start").map(seconds).transpose()?.is_some_and(|value|value != 0.0) { return Err(unsupported("起点偏移的视频时间段")); }
    let base = base_url(&base_url(url,&mpd)?,period)?;
    let mut tracks = Vec::new();
    for kind in ["video","audio"] {
        let mut selected = None;
        for adaptation in period.children.iter().filter(|node|node.name == "AdaptationSet") {
            for candidate in adaptation.children.iter().filter(|node|node.name == "Representation") {
                let mime = candidate.attr("mimeType").or_else(||adaptation.attr("mimeType")).unwrap_or("");
                let content = candidate.attr("contentType").or_else(||adaptation.attr("contentType")).unwrap_or("");
                if content != kind && !mime.starts_with(&format!("{kind}/")) { continue; }
                let bandwidth = candidate.attr("bandwidth").and_then(|value|value.parse::<u64>().ok()).unwrap_or(0);
                if selected.as_ref().is_none_or(|(_,_,old)|bandwidth > *old) { selected = Some((adaptation,candidate,bandwidth)); }
            }
        }
        if let Some((adaptation,candidate,_)) = selected { tracks.push(representation(period,adaptation,candidate,&base,duration,kind)?); }
    }
    if !tracks.iter().any(|track|track.kind == "video") { return Err(invalid()); }
    Ok(tracks)
}
