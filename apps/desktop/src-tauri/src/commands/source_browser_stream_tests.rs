use super::*;

#[test]
fn hls_vod_preserves_every_segment_and_init() {
    let Hls::Track(track) = parse_hls("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:1.5,\nfirst.m4s\n#EXTINF:2,\nsecond.m4s\n#EXT-X-ENDLIST\n", "https://cdn.example/path/index.m3u8", "video").unwrap() else { panic!("expected track") };
    assert_eq!(track.init.as_deref(), Some("https://cdn.example/path/init.mp4"));
    assert_eq!(track.segments.len(), 2);
    assert_eq!(track.segments[1].url, "https://cdn.example/path/second.m4s");
    assert_eq!(track.duration, 3.5);
}

#[test]
fn hls_master_selects_video_and_matching_audio_group() {
    let Hls::Master { video, audio } = parse_hls("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"main\",DEFAULT=YES,URI=\"audio.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500,AUDIO=\"a\"\nhigh.m3u8", "https://cdn.example/master.m3u8", "video").unwrap() else { panic!("expected master") };
    assert_eq!(video, "https://cdn.example/high.m3u8");
    assert_eq!(audio.as_deref(), Some("https://cdn.example/audio.m3u8"));
}

#[test]
fn unsupported_hls_is_explicitly_rejected() {
    for body in ["#EXTM3U\n#EXTINF:1,\na.ts", "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST", "#EXTM3U\n#EXT-X-BYTERANGE:12@0\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST"] {
        let error = parse_hls(body, "https://cdn.example/index.m3u8", "video").unwrap_err().to_string();
        assert!(error.contains("暂不支持"), "{error}");
    }
}

#[test]
fn dash_number_and_timeline_keep_separate_audio_video() {
    let xml = r#"<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="video"><SegmentTemplate timescale="1" duration="2" initialization="init-$RepresentationID$.mp4" media="v-$Number%03d$.m4s" startNumber="7"/><Representation id="v" bandwidth="100"/></AdaptationSet><AdaptationSet mimeType="audio/mp4"><Representation id="a"><SegmentTemplate timescale="10" initialization="a-init.mp4" media="a-$Time$.m4s"><SegmentTimeline><S t="0" d="10" r="3"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>"#;
    let tracks = parse_dash(xml, "https://cdn.example/path/manifest.mpd").unwrap();
    assert_eq!(tracks.len(), 2);
    assert_eq!(tracks[0].kind, "video");
    assert_eq!(tracks[0].segments.iter().map(|v|v.url.as_str()).collect::<Vec<_>>(), ["https://cdn.example/path/v-007.m4s", "https://cdn.example/path/v-008.m4s"]);
    assert_eq!(tracks[1].kind, "audio");
    assert_eq!(tracks[1].segments[3].url, "https://cdn.example/path/a-30.m4s");
}

#[test]
fn dash_rejects_dynamic_drm_and_unbounded_timeline() {
    for xml in [r#"<MPD type="dynamic"><Period/></MPD>"#, r#"<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet><ContentProtection schemeIdUri="urn:drm"/></AdaptationSet></Period></MPD>"#, r#"<MPD><Period><AdaptationSet contentType="video"><Representation id="v"><SegmentTemplate initialization="i.mp4" media="$Time$.m4s"><SegmentTimeline><S d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>"#] {
        let error = parse_dash(xml, "https://cdn.example/index.mpd").unwrap_err().to_string();
        assert!(error.contains("暂不支持"), "{error}");
    }
}

#[test]
fn dash_inherits_base_url_and_bounds_negative_repeat() {
    let xml = r#"<MPD mediaPresentationDuration="PT6S"><BaseURL>https://cdn.example/</BaseURL><Period><AdaptationSet contentType="video"><BaseURL>media/</BaseURL><SegmentTemplate initialization="init.mp4" media="$Time$.m4s" timescale="1"><SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate><Representation id="v"/></AdaptationSet></Period></MPD>"#;
    let tracks = parse_dash(xml,"https://page.example/manifest.mpd").unwrap();
    assert_eq!(tracks[0].segments.len(),3);
    assert_eq!(tracks[0].segments[2].url,"https://cdn.example/media/4.m4s");
}

#[test]
fn dash_rejects_gaps_overlaps_and_missing_tail_but_accepts_preroll_and_final_overlap() {
    let parse = |timeline: &str, offset: u64| parse_dash(&format!(r#"<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet contentType="video"><Representation id="v"><SegmentTemplate timescale="10" presentationTimeOffset="{offset}" initialization="i.mp4" media="$Time$.m4s"><SegmentTimeline>{timeline}</SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>"#),"https://cdn.example/a.mpd");
    for timeline in [r#"<S t="0" d="10"/><S t="20" d="10" r="1"/>"#, r#"<S t="0" d="20"/><S t="10" d="30"/>"#, r#"<S t="0" d="10" r="1"/>"#, r#"<S t="10" d="10" r="2"/>"#] {
        assert!(parse(timeline,0).is_err(),"incomplete timeline must fail: {timeline}");
    }
    assert!(parse(r#"<S t="0" d="21" r="1"/>"#,0).is_ok(),"last segment may extend beyond Period end");
    assert!(parse(r#"<S t="0" d="20" r="2"/>"#,5).is_ok(),"first segment may include presentation preroll");
}

#[test]
fn segment_bytes_cannot_smuggle_another_remote_or_local_playlist() {
    for bytes in [b"#EXTM3U\nfile:///private.mp4".as_slice(), b"<MPD/>".as_slice(), b"<html>Login</html>".as_slice()] { assert!(segment_extension(bytes).is_err()); }
}

fn resource(url: &str, bytes: Vec<u8>) -> CaptureResource {
    CaptureResource { url: url.into(), total_bytes: Some(bytes.len() as u64), bytes, content_type: String::new() }
}

#[tokio::test]
async fn missing_or_partial_segment_stops_before_remux() {
    use std::{cell::RefCell,rc::Rc};
    let body = b"#EXTM3U\n#EXTINF:1,\na.ts\n#EXTINF:1,\nb.ts\n#EXTINF:1,\nc.ts\n#EXT-X-ENDLIST";
    for partial in [false,true] {
        let requests = Rc::new(RefCell::new(Vec::new()));
        let seen = requests.clone();
        let result = download(resource("https://cdn.example/index.m3u8",body.to_vec()), &CaptureControl::detached(), move |url, _| {
            seen.borrow_mut().push(url.clone());
            let value = if url.ends_with("b.ts") {
                if partial { Ok(CaptureResource { total_bytes: Some(9), ..resource(&url,vec![1,2,3]) }) }
                else { Err(AppError::Other("片段不存在".into())) }
            } else { let mut bytes = vec![0;188]; bytes[0] = 0x47; Ok(resource(&url,bytes)) };
            std::future::ready(value)
        }).await;
        assert!(result.is_err());
        assert_eq!(&*requests.borrow(), &["https://cdn.example/a.ts","https://cdn.example/b.ts"]);
    }
}

#[tokio::test]
async fn downloaded_manifest_contains_only_local_generated_paths() {
    let body = b"#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:1,\na.m4s\n#EXTINF:1,\nb.m4s\n#EXT-X-ENDLIST";
    let result = download(resource("https://cdn.example/index.m3u8",body.to_vec()), &CaptureControl::detached(), |url,_|std::future::ready(Ok(resource(&url,b"\0\0\0\x08free".to_vec())))).await.unwrap();
    let root = result._temporary.path().to_owned();
    let playlist = std::fs::read_to_string(&result.inputs[0].0).unwrap();
    assert!(!playlist.contains("https:") && !playlist.contains("cdn.example"));
    assert!(playlist.contains("track-0-0.mp4") && playlist.contains("track-0-2.mp4"));
    drop(result);
    assert!(!root.exists(),"temporary segments must be removed after the job ends");
}

#[test]
fn aggregate_limit_includes_every_resource_and_rejects_empty_or_short_body() {
    let mut total = MAX_BYTES-2;
    assert!(receive(&resource("https://cdn.example/part",vec![1,2,3]), &mut total).is_err());
    assert!(receive(&resource("https://cdn.example/part",vec![]), &mut 0).is_err());
    assert!(receive(&CaptureResource { total_bytes: Some(4), ..resource("https://cdn.example/part",vec![1,2,3]) },&mut 0).is_err());
}

#[tokio::test]
#[ignore = "requires existing local FFmpeg; generates synthetic media only, no network or user library"]
async fn real_hls_and_dash_preserve_video_audio_and_decode() {
    use crate::media::tools::{resolve,command,Tool};
    let ffmpeg = resolve(Tool::Ffmpeg).unwrap();
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.mp4");
    let status = command(ffmpeg).args(["-nostdin","-v","error","-y","-f","lavfi","-i","testsrc2=size=160x90:rate=25:duration=4","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=4","-c:v","libx264","-g","25","-pix_fmt","yuv420p","-c:a","aac","-shortest"]).arg(&source).status().unwrap();
    assert!(status.success());
    for format in ["hls","hls-fmp4","hls-master","hls-master-ts","dash"] {
        let folder = root.path().join(format); std::fs::create_dir(&folder).unwrap();
        let manifest = folder.join(if format.starts_with("hls") { "index.m3u8" } else { "index.mpd" });
        if format.starts_with("hls-master") {
            for (name,map) in [("video","0:v:0"),("audio","0:a:0")] {
                let track = folder.join(name); std::fs::create_dir(&track).unwrap();
                assert!(command(ffmpeg).current_dir(&track).args(["-nostdin","-v","error","-y","-i"]).arg(&source)
                    .args(["-map",map,"-c","copy","-f","hls","-hls_segment_type",if format == "hls-master-ts" {"mpegts"} else {"fmp4"},"-hls_time","1","-hls_playlist_type","vod"]).arg("index.m3u8").status().unwrap().success());
            }
            std::fs::write(&manifest,b"#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"main\",DEFAULT=YES,URI=\"audio/index.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,AUDIO=\"a\"\nvideo/index.m3u8\n").unwrap();
        } else {
        let mut make = command(ffmpeg);
        make.current_dir(&folder);
        make.args(["-nostdin","-v","error","-y","-i"]).arg(&source).args(["-map","0:v:0","-map","0:a:0","-c","copy"]);
        if format.starts_with("hls") { make.args(["-f","hls","-hls_time","1","-hls_playlist_type","vod"]); if format == "hls-fmp4" { make.args(["-hls_segment_type","fmp4"]); } }
        else { make.args(["-f","dash","-seg_duration","1","-use_template","1","-use_timeline","1"]); }
        assert!(make.arg(&manifest).status().unwrap().success());
        }
        let first = resource(&format!("https://fixture.example/{}",manifest.file_name().unwrap().to_str().unwrap()),std::fs::read(&manifest).unwrap());
        let control = CaptureControl::detached();
        let downloaded = download(first,&control,|url,_| {
            let name = tauri::Url::parse(&url).unwrap().path().trim_start_matches('/').to_owned();
            let path = folder.join(name);
            let bytes = std::fs::read(&path).unwrap_or_else(|error|panic!("{format}: {url} -> {}: {error}",path.display()));
            std::future::ready(Ok(resource(&url,bytes)))
        }).await.unwrap();
        let output = remux(downloaded,&control).await.unwrap();
        let path = root.path().join(format!("{format}-result.mp4")); std::fs::write(&path,output).unwrap();
        let file = std::fs::File::open(&path).unwrap();
        let parsed = mp4::Mp4Reader::read_header(file,std::fs::metadata(&path).unwrap().len()).unwrap();
        assert_eq!(parsed.tracks().len(),2,"audio must remain in {format} result");
        let video = parsed.tracks().values().find(|track|track.track_type().unwrap() == mp4::TrackType::Video).unwrap();
        assert_eq!(video.sample_count(),100,"all four video seconds must remain in {format}");
        let audio = parsed.tracks().values().find(|track|track.track_type().unwrap() == mp4::TrackType::Audio).unwrap();
        assert!((audio.duration().as_secs_f64()-4.0).abs() < 0.1,"audio duration must remain in {format}");

        if format == "hls-master-ts" {
            // A damaged AAC stream must still fail after timestamp repair is allowed.
            let first = resource("https://fixture.example/index.m3u8",std::fs::read(&manifest).unwrap());
            let damaged = download(first,&control,|url,_| {
                let name = tauri::Url::parse(&url).unwrap().path().trim_start_matches('/').to_owned();
                let mut bytes = std::fs::read(folder.join(&name)).unwrap();
                if name == "audio/index1.ts" { for packet in bytes.chunks_mut(188) { if packet.len() > 20 { packet[20..].fill(0xff); } } }
                std::future::ready(Ok(resource(&url,bytes)))
            }).await.unwrap();
            assert!(remux(damaged,&control).await.is_err(),"corrupt audio cannot become a successful capture");
        }
    }
}
