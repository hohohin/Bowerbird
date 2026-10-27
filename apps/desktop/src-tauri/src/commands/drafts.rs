//! Local editable draft snapshots. Pixels, document and project membership commit together.
use crate::core::{library::Asset, paths::LibraryPaths};
use crate::db::Database;
use crate::error::{AppError, AppResult};
use base64::Engine;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::{Read, Write}, path::Path, sync::Arc};
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

const MAX_EDGE: u64 = 4096;
const MAX_LAYERS: usize = 32;
const MAX_LAYER_PIXELS: u64 = 64_000_000;
const MAX_DOCUMENT: usize = 256 * 1024 * 1024;
const MAX_PNG: usize = 30 * 1024 * 1024;

fn invalid() -> AppError { AppError::Other("草稿工程数据无效或超出大小限制".into()) }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn identifier(value: &Value) -> bool {
    value.as_str().is_some_and(|id| !id.is_empty() && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}
fn dimension(value: &Value) -> AppResult<u64> {
    value.as_u64().filter(|n| (1..=MAX_EDGE).contains(n)).ok_or_else(invalid)
}
fn number(value: &Value, min: f64, max: f64) -> AppResult<f64> {
    value.as_f64().filter(|n| n.is_finite() && (min..=max).contains(n)).ok_or_else(invalid)
}

fn png(url: &str) -> AppResult<(Vec<u8>, image::DynamicImage)> {
    let encoded = url.strip_prefix("data:image/png;base64,").ok_or_else(invalid)?;
    if encoded.len() > MAX_PNG.div_ceil(3) * 4 { return Err(invalid()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| invalid())?;
    if bytes.len() > MAX_PNG || image::guess_format(&bytes).map_err(|_| invalid())? != image::ImageFormat::Png {
        return Err(invalid());
    }
    let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Png).into_dimensions()?;
    if width == 0 || height == 0 || u64::from(width.max(height)) > MAX_EDGE { return Err(invalid()); }
    // Dimensions alone do not establish that a truncated PNG is usable after reopening.
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)?;
    Ok((bytes, decoded))
}

fn validate_text(text: &Value) -> AppResult<u64> {
    if !text.is_object()
        || text["content"].as_str().is_none_or(|s| s.chars().count() > 5000)
        || text["fontFamily"].as_str().is_none_or(|s| s.is_empty() || s.len() > 256)
        || !text["bold"].is_boolean()
        || !matches!(text["align"].as_str(), Some("left" | "center" | "right"))
        || text["color"].as_str().is_none_or(|s| s.len() != 7 || !s.starts_with('#') || !s[1..].bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(invalid());
    }
    number(&text["fontSize"], 1.0, 2000.0)?;
    number(&text["lineHeight"], 0.5, 5.0)?;
    number(&text["letterSpacing"], -50.0, 200.0)?;
    let w = number(&text["boxWidth"], 1.0, MAX_EDGE as f64)?;
    let h = number(&text["boxHeight"], 1.0, MAX_EDGE as f64)?;
    Ok(w.ceil() as u64 * h.ceil() as u64)
}

fn validate_document(document: &Value) -> AppResult<Vec<u8>> {
    let bytes = serde_json::to_vec(document)?;
    if bytes.len() > MAX_DOCUMENT || document["schemaVersion"] != 1 || !identifier(&document["documentId"])
        || (!document["backgroundLayerId"].is_null() && !identifier(&document["backgroundLayerId"])) {
        return Err(invalid());
    }
    dimension(&document["width"])?;
    dimension(&document["height"])?;
    let layers = document["layers"].as_array().ok_or_else(invalid)?;
    if layers.len() > MAX_LAYERS { return Err(invalid()); }
    let mut ids = HashSet::new();
    let mut pixels = 0u64;
    for layer in layers {
        if !identifier(&layer["id"]) || !ids.insert(layer["id"].as_str().unwrap())
            || layer["name"].as_str().is_none_or(|name| name.chars().count() > 256)
            || !layer["visible"].is_boolean() || !layer["locked"].is_boolean() {
            return Err(invalid());
        }
        number(&layer["x"], -100_000.0, 100_000.0)?;
        number(&layer["y"], -100_000.0, 100_000.0)?;
        number(&layer["width"], f64::EPSILON, MAX_EDGE as f64)?;
        number(&layer["height"], f64::EPSILON, MAX_EDGE as f64)?;
        number(&layer["opacity"], 0.0, 1.0)?;
        pixels += match layer["kind"].as_str() {
            Some("raster") if layer["text"].is_null() => {
                let (_, decoded) = png(layer["dataUrl"].as_str().ok_or_else(invalid)?)?;
                u64::from(decoded.width()) * u64::from(decoded.height())
            }
            Some("text") if layer["dataUrl"].is_null() => validate_text(&layer["text"])? ,
            _ => return Err(invalid()),
        };
        if pixels > MAX_LAYER_PIXELS { return Err(invalid()); }
    }
    Ok(bytes)
}

fn safe_document_file(root: &Path, name: &str) -> AppResult<std::path::PathBuf> {
    if name.strip_suffix(".json").is_none_or(|id| id.parse::<Ulid>().is_err()) { return Err(invalid()); }
    let directory = root.join("layers");
    if fs::canonicalize(&directory)? != fs::canonicalize(root)?.join("layers") { return Err(invalid()); }
    let file = directory.join(name);
    let meta = fs::symlink_metadata(&file)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_DOCUMENT as u64 { return Err(invalid()); }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return Err(invalid()); }
    }
    Ok(file)
}

fn load_document(paths: &LibraryPaths, db: &Database, asset_id: &str) -> AppResult<Option<Value>> {
    let name: Option<String> = db.conn.lock().unwrap().query_row(
        "SELECT payload FROM analyses WHERE asset_id=?1 AND kind='draft_workspace' ORDER BY created_at DESC LIMIT 1",
        [asset_id], |row| row.get(0),
    ).optional()?;
    let Some(name) = name else { return Ok(None); };
    let mut bytes = Vec::new();
    fs::File::open(safe_document_file(&paths.root, &name)?)?.take(MAX_DOCUMENT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_DOCUMENT { return Err(invalid()); }
    let document = serde_json::from_slice(&bytes)?;
    validate_document(&document)?;
    Ok(Some(document))
}

fn saved_asset(paths: &LibraryPaths, db: &Database, receipt_id: &str, expected: &Value) -> AppResult<Option<Asset>> {
    let row: Option<(String, String)> = db.conn.lock().unwrap().query_row(
        "SELECT asset_id,payload FROM analyses WHERE id=?1 AND kind='draft_save'", [receipt_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((id, payload)) = row else { return Ok(None); };
    if serde_json::from_str::<Value>(&payload)? != *expected {
        return Err(AppError::Other("这次草稿保存的内容已变化，请重新保存".into()));
    }
    let asset = db.get_asset(&id)?.ok_or_else(invalid)?;
    let document = load_document(paths, db, &id)?.ok_or_else(invalid)?;
    let stored = asset.store_path.as_deref().ok_or_else(invalid)?;
    let file = fs::File::open(stored)?;
    if file.metadata()?.len() > MAX_PNG as u64 { return Err(invalid()); }
    let mut image_bytes = Vec::new();
    file.take(MAX_PNG as u64 + 1).read_to_end(&mut image_bytes)?;
    if digest(&serde_json::to_vec(&document)?) != expected["documentHash"]
        || digest(&image_bytes) != expected["imageHash"] { return Err(invalid()); }
    Ok(Some(asset))
}

fn write_new(path: &Path, bytes: &[u8], created: &mut Vec<std::path::PathBuf>) -> AppResult<()> {
    fs::create_dir_all(path.parent().ok_or_else(invalid)?)?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    created.push(path.to_path_buf());
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn save_document(paths: &LibraryPaths, db: &Database, document: Value, data_url: String,
    project_id: Option<String>, save_id: String) -> AppResult<Asset> {
    if !identifier(&json!(save_id)) { return Err(invalid()); }
    let document_bytes = validate_document(&document)?;
    let (image_bytes, decoded) = png(&data_url)?;
    if u64::from(decoded.width()) != dimension(&document["width"])?
        || u64::from(decoded.height()) != dimension(&document["height"])? { return Err(invalid()); }
    let receipt_id = format!("draft-save-{}", digest(save_id.as_bytes()));
    let receipt = json!({"saveId":save_id,"documentId":document["documentId"],"projectId":project_id,
        "documentHash":digest(&document_bytes),"imageHash":digest(&image_bytes)});
    if let Some(asset) = saved_asset(paths, db, &receipt_id, &receipt)? { return Ok(asset); }
    // Freeze the destination now; recheck project existence in the committing transaction.
    if let Some(id) = &project_id {
        if db.get_project(id)?.is_none() { return Err(AppError::Other("目标项目已不存在".into())); }
    }
    let destination = paths.for_project(db, project_id.as_deref())?;
    let id = Ulid::new().to_string();
    let store_path = destination.asset_store_path(&id, "png")?;
    let thumbnail = paths.thumb_path(&id);
    let name = format!("{id}.json");
    let directory = paths.root.join("layers");
    fs::create_dir_all(&directory)?;
    if fs::canonicalize(&directory)? != fs::canonicalize(&paths.root)?.join("layers") { return Err(invalid()); }
    let mut created = Vec::new();
    let result = (|| -> AppResult<Asset> {
        write_new(&store_path, &image_bytes, &mut created)?;
        write_new(&directory.join(&name), &document_bytes, &mut created)?;
        // Reserve the unique thumbnail path before its encoder writes into it.
        write_new(&thumbnail, &[], &mut created)?;
        crate::media::thumb::generate_from_image(&decoded, &thumbnail, 480)?;
        fs::OpenOptions::new().write(true).open(&thumbnail)?.sync_all()?;
        #[cfg(unix)]
        for directory in [store_path.parent().unwrap(), thumbnail.parent().unwrap(), directory.as_path()] {
            fs::File::open(directory)?.sync_all()?;
        }
        let colors = crate::media::color::extract_from_image(&decoded, 5);
        let now = chrono::Utc::now().timestamp();
        let asset = Asset { id: id.clone(), name: "草稿".into(), ext: Some("png".into()),
            origin_path: None, store_path: Some(store_path.to_string_lossy().into_owned()),
            thumb_path: Some(thumbnail.to_string_lossy().into_owned()), size: Some(image_bytes.len() as i64),
            width: Some(decoded.width() as i64), height: Some(decoded.height() as i64), duration: None,
            phash: None, colors: Some(serde_json::to_string(&colors)?), rating: Some(0), source: Some("draft".into()),
            source_url: None, folder_id: None, created_at: Some(now), file_mtime: Some(now),
            generation_session_id: None, reference_count: 0, library_hidden: false };
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(project) = &project_id {
            if !tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [project], |r| r.get::<_,bool>(0))? {
                return Err(AppError::Other("目标项目已不存在".into()));
            }
        }
        tx.execute("INSERT INTO assets(id,name,ext,store_path,thumb_path,size,width,height,colors,rating,source,created_at,file_mtime,library_hidden)
            VALUES(?1,?2,'png',?3,?4,?5,?6,?7,?8,0,'draft',?9,?9,0)",
            params![id,asset.name,asset.store_path,asset.thumb_path,asset.size,asset.width,asset.height,asset.colors,now])?;
        tx.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'draft_workspace',?3,?4)",
            params![format!("draft-workspace-{id}"),id,name,now])?;
        tx.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'draft_save',?3,?4)",
            params![receipt_id,id,serde_json::to_string(&receipt)?,now])?;
        if let Some(project) = &project_id {
            tx.execute("INSERT INTO project_assets(project_id,asset_id,created_at) VALUES(?1,?2,?3)", params![project,id,now])?;
        }
        for bucket in crate::media::color::colors_to_buckets(asset.colors.as_deref().unwrap_or("[]")) {
            tx.execute("INSERT INTO asset_colors(asset_id,bucket) VALUES(?1,?2)", params![id,bucket])?;
        }
        tx.commit()?;
        Ok(asset)
    })();
    if result.is_err() {
        for path in created { let _ = fs::remove_file(path); }
        // A concurrent caller may have committed this save ID after our first lookup.
        if let Some(asset) = saved_asset(paths, db, &receipt_id, &receipt)? { return Ok(asset); }
    }
    result
}

#[tauri::command]
pub async fn draft_workspace_load(paths: State<'_, Arc<LibraryPaths>>, db: State<'_, Arc<Database>>,
    asset_id: String) -> AppResult<Option<Value>> {
    let paths = paths.inner().clone(); let db = db.inner().clone();
    tokio::task::spawn_blocking(move || load_document(&paths, &db, &asset_id)).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn draft_workspace_save(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, db: State<'_, Arc<Database>>,
    document: Value, data_url: String, project_id: Option<String>, save_id: String) -> AppResult<Asset> {
    let paths = paths.inner().clone(); let db = db.inner().clone();
    let asset = tokio::task::spawn_blocking(move || save_document(&paths, &db, document, data_url, project_id, save_id))
        .await.map_err(|e| AppError::Other(e.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

#[tauri::command]
pub async fn draft_workspace_asset_ids(db: State<'_, Arc<Database>>) -> AppResult<Vec<String>> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.conn.lock().unwrap();
        let mut statement = conn.prepare("SELECT DISTINCT asset_id FROM analyses WHERE kind='draft_workspace'")?;
        let ids = statement.query_map([], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }).await.map_err(|e| AppError::Other(e.to_string()))?
}

fn publish_to_canvas(paths: &LibraryPaths, db: &Database, project_id: &str, document_id: &str,
    asset_id: &str, source_node_id: Option<&str>, new_node: &crate::core::project_canvas::NewCanvasNode,
) -> AppResult<crate::core::project_canvas::CanvasNode> {
    let document = load_document(paths, db, asset_id)?.ok_or_else(invalid)?;
    if document["documentId"].as_str() != Some(document_id) { return Err(invalid()); }
    let asset = db.get_asset(asset_id)?.ok_or_else(invalid)?;
    db.upsert_draft_canvas_node(project_id, document_id, &asset, source_node_id, new_node)
}

#[tauri::command]
pub async fn draft_workspace_canvas_upsert(paths: State<'_, Arc<LibraryPaths>>, db: State<'_, Arc<Database>>,
    project_id: String, document_id: String, asset_id: String, source_node_id: Option<String>,
    new_node: crate::core::project_canvas::NewCanvasNode,
) -> AppResult<crate::core::project_canvas::CanvasNode> {
    let paths = paths.inner().clone(); let db = db.inner().clone();
    tokio::task::spawn_blocking(move || publish_to_canvas(&paths, &db, &project_id, &document_id,
        &asset_id, source_node_id.as_deref(), &new_node)).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::library::{cleanup_draft_workspace_files, draft_workspace_files};
    use std::path::PathBuf;

    struct Fixture { paths: LibraryPaths, db: Database }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("bowerbird-drafts-{}", Ulid::new()));
            let paths = LibraryPaths::init(root).unwrap();
            let db = Database::open(&paths.db).unwrap(); db.migrate().unwrap();
            db.create_project("p", "草稿项目", "blank:p", "blank:p", "blank").unwrap();
            Self { paths, db }
        }
        fn save(&self, document: Value, url: &str, key: &str) -> AppResult<Asset> {
            save_document(&self.paths, &self.db, document, url.into(), Some("p".into()), key.into())
        }
        fn file(&self, id: &str) -> PathBuf {
            let name: String = self.db.conn.lock().unwrap().query_row("SELECT payload FROM analyses WHERE asset_id=?1 AND kind='draft_workspace'", [id], |r| r.get(0)).unwrap();
            self.paths.root.join("layers").join(name)
        }
        fn count(&self) -> i64 {
            self.db.conn.lock().unwrap().query_row("SELECT count(*) FROM assets", [], |r| r.get(0)).unwrap()
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.paths.root); } }

    fn image_url(width: u32, height: u32) -> String {
        let mut data = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(width, height, image::Rgba([30, 70, 100, 128])))
            .write_to(&mut data, image::ImageFormat::Png).unwrap();
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(data.into_inner()))
    }
    fn document(url: &str) -> Value {
        json!({"schemaVersion":1,"documentId":"test-document","width":8,"height":8,
            "layers":[{"id":"raster","name":"绘画层","kind":"raster","dataUrl":url,"x":-2,"y":3,
                "width":8,"height":8,"opacity":0.5,"visible":true,"locked":false},
            {"id":"text","name":"文字层","kind":"text","x":1,"y":2,"width":8,"height":8,
                "opacity":1,"visible":false,"locked":true,"text":{"content":"可编辑\n中文","fontFamily":"sans-serif",
                    "fontSize":12,"color":"#224466","bold":true,"align":"left","lineHeight":1.25,
                    "letterSpacing":0,"boxWidth":8,"boxHeight":8}}]})
    }

    fn canvas_node(id: &str, asset: &Asset) -> crate::core::project_canvas::NewCanvasNode {
        use crate::core::creative_session_contract::{CreativeNodeKind, CreativeNodeRole};
        crate::core::project_canvas::NewCanvasNode { id: id.into(), project_id: "p".into(), thread_id: None,
            kind: CreativeNodeKind::Asset, asset_id: Some(asset.id.clone()), role: Some(CreativeNodeRole::Reference),
            payload_json: json!({"schema_version":1,"snapshot":{"name":asset.name,"width":asset.width,"height":asset.height}}).to_string(),
            x: 10.0, y: 20.0, width: 80.0, height: 80.0, z_index: 3, position_locked: false }
    }

    #[test]
    fn publishing_revisions_keeps_one_node_and_its_layout_connections_and_reference_history() {
        let f=Fixture::new(); f.db.ensure_project_canvas("p").unwrap();
        let url=image_url(8,8); let doc=document(&url);
        let first=f.save(doc.clone(),&url,"first").unwrap();
        let original=publish_to_canvas(&f.paths,&f.db,"p","test-document",&first.id,None,&canvas_node("draft-node",&first)).unwrap();
        {
            let conn=f.db.conn.lock().unwrap();
            conn.execute_batch("UPDATE canvas_nodes SET x=123,y=456,width=120,height=90,z_index=9,position_locked=1;
                INSERT INTO creative_threads(id,project_id,title,origin,created_at,updated_at) VALUES('t','p','thread','direct',1,1);
                INSERT INTO canvas_nodes(id,project_id,thread_id,kind,payload_json,x,y,width,height,created_at,updated_at) VALUES('prompt','p','t','prompt','{\"schema_version\":1}',0,0,100,100,1,1);
                INSERT INTO canvas_edges(id,project_id,thread_id,from_node_id,to_node_id,kind,ordinal,created_at) VALUES('edge','p','t','draft-node','prompt','input',0,1);
                INSERT INTO canvas_groups(id,project_id,name,x,y,width,height,created_at,updated_at) VALUES('g','p','group',0,0,100,100,1,1);
                INSERT INTO canvas_group_items(project_id,group_id,node_id,ordinal) VALUES('p','g','draft-node',0);").unwrap();
            conn.execute("UPDATE assets SET reference_count=7 WHERE id=?1",[&first.id]).unwrap();
        }
        let second=f.save(doc,&url,"second").unwrap();
        let reopened=Database::open(&f.paths.db).unwrap();
        for source in [None,Some(original.id.as_str()),None] {
            let saved=publish_to_canvas(&f.paths,&reopened,"p","test-document",&second.id,source,&canvas_node("unused-new-node",&second)).unwrap();
            assert_eq!(saved.id,original.id); assert_eq!(saved.asset_id,Some(second.id.clone()));
            assert_eq!((saved.x,saved.y,saved.width,saved.height,saved.z_index,saved.position_locked),(123.0,456.0,120.0,90.0,9,true));
            assert_eq!(serde_json::from_str::<Value>(&saved.payload_json).unwrap()["draft_document_id"],"test-document");
        }
        let conn=reopened.conn.lock().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM canvas_nodes WHERE kind='asset' AND hidden_at IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT from_node_id FROM canvas_edges WHERE id='edge'",[],|r|r.get::<_,String>(0)).unwrap(),original.id);
        assert_eq!(conn.query_row("SELECT node_id FROM canvas_group_items WHERE group_id='g'",[],|r|r.get::<_,String>(0)).unwrap(),original.id);
        drop(conn);
        assert_eq!(reopened.get_asset(&first.id).unwrap().unwrap().reference_count,7);
        assert_eq!(reopened.get_asset(&second.id).unwrap().unwrap().reference_count,0);
        assert!(f.file(&first.id).is_file()); assert!(f.file(&second.id).is_file());
    }

    #[test]
    fn publishing_legacy_drafts_updates_only_the_selected_instance() {
        let f=Fixture::new(); f.db.ensure_project_canvas("p").unwrap();
        let url=image_url(8,8); let doc=document(&url);
        let first=f.save(doc.clone(),&url,"legacy-a").unwrap(); let second=f.save(doc.clone(),&url,"legacy-b").unwrap();
        f.db.create_canvas_node(&canvas_node("legacy-a",&first)).unwrap();
        let untouched=f.db.create_canvas_node(&canvas_node("legacy-b",&second)).unwrap();
        let latest=f.save(doc,&url,"latest").unwrap();
        let saved=publish_to_canvas(&f.paths,&f.db,"p","test-document",&latest.id,Some("legacy-a"),&canvas_node("unused",&latest)).unwrap();
        assert_eq!(saved.id,"legacy-a"); assert_eq!(f.db.get_canvas_node("legacy-b").unwrap().unwrap(),untouched);
        assert_eq!(f.db.list_canvas_nodes("p").unwrap().len(),2);
    }

    #[test]
    fn ordinary_source_is_preserved_and_deleted_or_cross_project_sources_are_rejected() {
        let f=Fixture::new(); f.db.ensure_project_canvas("p").unwrap();
        f.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name) VALUES('ordinary','ordinary')",[]).unwrap();
        let ordinary=f.db.get_asset("ordinary").unwrap().unwrap();
        let original=f.db.create_canvas_node(&canvas_node("ordinary-node",&ordinary)).unwrap();
        assert!(publish_to_canvas(&f.paths,&f.db,"p","test-document",&ordinary.id,None,&canvas_node("forged",&ordinary)).is_err());
        let url=image_url(8,8); let saved=f.save(document(&url),&url,"draft").unwrap();
        let node=publish_to_canvas(&f.paths,&f.db,"p","test-document",&saved.id,Some("ordinary-node"),&canvas_node("draft-node",&saved)).unwrap();
        assert_eq!(node.id,"draft-node"); assert_eq!(f.db.get_canvas_node("ordinary-node").unwrap().unwrap(),original);
        f.db.conn.lock().unwrap().execute("UPDATE canvas_nodes SET hidden_at=1 WHERE id='draft-node'",[]).unwrap();
        assert!(publish_to_canvas(&f.paths,&f.db,"p","test-document",&saved.id,Some("draft-node"),&canvas_node("unused",&saved)).is_err());
        assert!(publish_to_canvas(&f.paths,&f.db,"p","test-document",&saved.id,Some("missing"),&canvas_node("unused",&saved)).is_err());
        f.db.create_project("q","q","blank:q","blank:q","blank").unwrap(); f.db.ensure_project_canvas("q").unwrap();
        let mut other=canvas_node("other-project",&saved); other.project_id="q".into(); f.db.create_canvas_node(&other).unwrap();
        assert!(publish_to_canvas(&f.paths,&f.db,"p","test-document",&saved.id,Some("other-project"),&canvas_node("unused",&saved)).is_err());
        assert_eq!(f.db.list_canvas_nodes("p").unwrap().len(),2);
    }

    #[test]
    fn publishing_validates_document_identity_and_rolls_back_node_and_membership_on_failure() {
        let f=Fixture::new(); f.db.ensure_project_canvas("p").unwrap();
        let url=image_url(8,8); let doc=document(&url);
        let first=f.save(doc.clone(),&url,"first").unwrap();
        let original=publish_to_canvas(&f.paths,&f.db,"p","test-document",&first.id,None,&canvas_node("draft",&first)).unwrap();
        assert!(publish_to_canvas(&f.paths,&f.db,"p","forged-document",&first.id,Some("draft"),&canvas_node("unused",&first)).is_err());
        let mut other_document=doc.clone(); other_document["documentId"]=json!("different-document");
        let other=f.save(other_document,&url,"other").unwrap();
        assert!(publish_to_canvas(&f.paths,&f.db,"p","different-document",&other.id,Some("draft"),&canvas_node("unused",&other)).is_err());
        let second=save_document(&f.paths,&f.db,doc,url,None,"second".into()).unwrap();
        f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_draft_update BEFORE UPDATE ON canvas_nodes BEGIN SELECT RAISE(ABORT,'synthetic publish failure'); END;").unwrap();
        assert!(publish_to_canvas(&f.paths,&f.db,"p","test-document",&second.id,Some("draft"),&canvas_node("unused",&second)).is_err());
        assert_eq!(f.db.get_canvas_node("draft").unwrap().unwrap(),original);
        assert_eq!(f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p' AND asset_id=?1",[&second.id],|r|r.get::<_,i64>(0)).unwrap(),0);
        f.db.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_draft_update;").unwrap();
        let retry=publish_to_canvas(&f.paths,&f.db,"p","test-document",&second.id,Some("draft"),&canvas_node("unused",&second)).unwrap();
        assert_eq!(retry.id,original.id); assert_eq!(retry.asset_id,Some(second.id));
    }

    #[test]
    fn saves_editable_document_and_retries_without_duplicate_assets() {
        let f = Fixture::new(); let url = image_url(8,8); let doc = document(&url);
        let first = f.save(doc.clone(), &url, "save-a").unwrap();
        let second = f.save(doc.clone(), &url, "save-a").unwrap();
        assert_eq!(first.id, second.id); assert_eq!(f.count(), 1);
        assert_eq!(load_document(&f.paths, &f.db, &first.id).unwrap(), Some(doc));
        assert!(f.file(&first.id).is_file()); assert!(Path::new(first.store_path.as_ref().unwrap()).is_file());
        assert_eq!(f.db.conn.lock().unwrap().query_row("SELECT count(*) FROM project_assets WHERE project_id='p' AND asset_id=?1", [&first.id], |r| r.get::<_,i64>(0)).unwrap(), 1);
        let rows = f.db.list_analyses_by_asset(&first.id).unwrap();
        assert!(rows.iter().all(|row| row.payload.len() < 1024));
        assert!(load_document(&f.paths, &f.db, "not-a-draft").unwrap().is_none());
    }

    #[test]
    fn independent_saves_keep_identical_pixels_and_old_revisions_separate() {
        let f = Fixture::new(); let url = image_url(8,8); let first_doc = document(&url);
        let first = f.save(first_doc.clone(), &url, "first").unwrap();
        let old_file = f.file(&first.id); let old_bytes = fs::read(&old_file).unwrap();
        let mut next = first_doc.clone(); next["layers"][1]["text"]["content"] = json!("修订后的文字");
        let second = f.save(next.clone(), &url, "next").unwrap();
        let mut independent = next.clone(); independent["documentId"] = json!("independent");
        let third = f.save(independent, &url, "another").unwrap();
        assert_ne!(first.id, second.id); assert_ne!(second.id, third.id); assert_eq!(f.count(), 3);
        assert_eq!(fs::read(old_file).unwrap(), old_bytes);
        assert_eq!(load_document(&f.paths,&f.db,&first.id).unwrap(), Some(first_doc));
        assert_eq!(load_document(&f.paths,&f.db,&second.id).unwrap(), Some(next));
        assert_eq!(fs::read(first.store_path.unwrap()).unwrap(), fs::read(second.store_path.unwrap()).unwrap());
    }

    #[test]
    fn save_id_conflicts_and_missing_project_never_create_partial_assets() {
        let f = Fixture::new(); let url = image_url(8,8); let doc = document(&url);
        f.save(doc.clone(), &url, "same").unwrap();
        let mut changed = doc.clone(); changed["layers"][0]["visible"] = json!(false);
        assert!(f.save(changed, &url, "same").unwrap_err().to_string().contains("内容已变化"));
        assert!(save_document(&f.paths,&f.db,doc.clone(),url.clone(),None,"same".into()).is_err());
        assert!(save_document(&f.paths,&f.db,doc,url,Some("missing".into()),"new".into()).is_err());
        assert_eq!(f.count(),1); assert_eq!(fs::read_dir(f.paths.root.join("layers")).unwrap().count(),1);
    }

    #[test]
    fn database_failures_roll_back_pixels_document_and_membership() {
        let f = Fixture::new(); let url = image_url(8,8); let doc = document(&url);
        f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_draft_member BEFORE INSERT ON project_assets BEGIN SELECT RAISE(ABORT,'synthetic project failure'); END;").unwrap();
        assert!(f.save(doc.clone(), &url, "retry").is_err()); assert_eq!(f.count(),0);
        assert_eq!(fs::read_dir(f.paths.root.join("layers")).unwrap().count(),0);
        assert_eq!(f.db.conn.lock().unwrap().query_row("SELECT count(*) FROM analyses",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        f.db.conn.lock().unwrap().execute_batch("DROP TRIGGER reject_draft_member").unwrap();
        let saved = f.save(doc, &url, "retry").unwrap();
        assert_eq!(f.count(),1); assert!(f.file(&saved.id).exists());
    }

    #[test]
    fn filesystem_failure_cleans_only_the_unsaved_attempt() {
        let f = Fixture::new(); let url = image_url(8,8); let doc = document(&url);
        let first = f.save(doc.clone(), &url, "first").unwrap(); let old = f.file(&first.id);
        let mut broken = f.paths.clone(); broken.thumbnails = f.paths.root.join("not-a-directory");
        fs::write(&broken.thumbnails,b"keep this file").unwrap();
        assert!(save_document(&broken,&f.db,doc,url,Some("p".into()),"failed".into()).is_err());
        assert_eq!(f.count(),1); assert!(old.is_file());
        assert_eq!(fs::read_dir(f.paths.root.join("layers")).unwrap().count(),1);
        assert_eq!(fs::read(broken.thumbnails).unwrap(), b"keep this file");
    }

    #[test]
    fn validates_pixels_layer_limits_text_and_output_dimensions() {
        let url = image_url(8,8); let doc = document(&url);
        for (field, value) in [("width",json!(4097)), ("height",json!(0)), ("schemaVersion",json!(2)), ("documentId",json!("../bad")), ("backgroundLayerId",json!("../bad"))] {
            let mut invalid = doc.clone(); invalid[field] = value; assert!(validate_document(&invalid).is_err(),"{field}");
        }
        for (field, value) in [("width",json!(0)), ("height",json!(4097)), ("opacity",json!(1.1)), ("x",json!(100001)), ("kind",json!("other")), ("locked",Value::Null), ("dataUrl",json!("data:image/jpeg;base64,aA=="))] {
            let mut invalid = doc.clone(); invalid["layers"][0][field] = value; assert!(validate_document(&invalid).is_err(),"{field}");
        }
        let mut duplicate = doc.clone(); duplicate["layers"][1]["id"] = json!("raster"); assert!(validate_document(&duplicate).is_err());
        let mut too_many = doc.clone(); too_many["layers"] = json!((0..33).map(|i| {let mut layer=doc["layers"][0].clone(); layer["id"]=json!(format!("id{i}")); layer}).collect::<Vec<_>>()); assert!(validate_document(&too_many).is_err());
        let mut pixels = doc.clone(); pixels["layers"] = json!((0..4).map(|i| {let mut layer=doc["layers"][1].clone(); layer["id"]=json!(format!("text{i}")); layer["text"]["boxWidth"]=json!(4096);layer["text"]["boxHeight"]=json!(4096);layer}).collect::<Vec<_>>()); assert!(validate_document(&pixels).is_err());
        let mut text = doc.clone(); text["layers"][1]["text"]["fontSize"] = json!(0); assert!(validate_document(&text).is_err());
        let mut empty = doc.clone(); empty["layers"]=json!([]); assert!(validate_document(&empty).is_ok());
        empty["backgroundLayerId"]=json!("removed-background"); assert!(validate_document(&empty).is_ok());
        assert!(png(&image_url(4097,1)).is_err());
        let f = Fixture::new(); assert!(f.save(doc, &image_url(9,8), "wrong-size").is_err()); assert_eq!(f.count(),0);
    }

    #[test]
    fn missing_or_corrupt_saved_files_are_not_reported_as_success() {
        let f = Fixture::new(); let url=image_url(8,8); let doc=document(&url);
        let saved=f.save(doc.clone(),&url,"saved").unwrap();
        fs::write(f.file(&saved.id),b"broken").unwrap();
        assert!(load_document(&f.paths,&f.db,&saved.id).is_err());
        assert!(f.save(doc,&url,"saved").is_err()); assert_eq!(f.count(),1);
    }

    #[test]
    fn concurrent_identical_saves_share_one_committed_snapshot() {
        let f=Fixture::new(); let url=image_url(8,8); let doc=document(&url);
        std::thread::scope(|scope| {
            let a=scope.spawn(|| f.save(doc.clone(),&url,"concurrent").unwrap());
            let b=scope.spawn(|| f.save(doc.clone(),&url,"concurrent").unwrap());
            assert_eq!(a.join().unwrap().id,b.join().unwrap().id);
        });
        assert_eq!(f.count(),1); assert_eq!(fs::read_dir(f.paths.root.join("layers")).unwrap().count(),1);
    }

    #[test]
    fn physical_deletion_preserves_shared_pointer_until_last_asset_is_removed() {
        let f=Fixture::new(); let url=image_url(8,8); let saved=f.save(document(&url),&url,"shared").unwrap();
        let file=f.file(&saved.id); let name=file.file_name().unwrap().to_str().unwrap();
        f.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name) VALUES('alias','alias')",[]).unwrap();
        f.db.conn.lock().unwrap().execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('shared-pointer','alias','draft_workspace',?1)",[name]).unwrap();
        f.db.delete_asset(&saved.id).unwrap(); assert!(file.exists());
        f.db.delete_asset("alias").unwrap(); assert!(!file.exists());
    }

    #[test]
    fn local_file_and_project_deletion_clean_only_deleted_draft_assets() {
        let f=Fixture::new(); let url=image_url(8,8); let doc=document(&url);
        let local=f.save(doc.clone(),&url,"local").unwrap(); let local_doc=f.file(&local.id);
        f.db.delete_local_file(&local.id,local.store_path.as_deref().unwrap()).unwrap(); assert!(!local_doc.exists());
        let exclusive=f.save(doc.clone(),&url,"exclusive").unwrap(); let exclusive_doc=f.file(&exclusive.id);
        let shared=f.save(doc,&url,"shared").unwrap(); let shared_doc=f.file(&shared.id);
        f.db.create_project("q", "其他项目", "blank:q", "blank:q", "blank").unwrap();
        f.db.add_assets_to_project("q",std::slice::from_ref(&shared.id)).unwrap();
        let impact=f.db.project_exclusive_impact(&f.paths,"p").unwrap();
        let result=f.db.delete_project_exclusive(&f.paths,"p",&impact.confirmation).unwrap();
        assert_eq!(result.deleted_assets,1); assert!(result.cleanup_pending.is_empty());
        assert!(!exclusive_doc.exists()); assert!(shared_doc.exists());
        assert!(load_document(&f.paths,&f.db,&shared.id).unwrap().is_some());
    }

    #[test]
    fn deleting_only_project_membership_preserves_the_editable_draft() {
        let f=Fixture::new(); let url=image_url(8,8); let doc=document(&url);
        let saved=f.save(doc.clone(),&url,"keep").unwrap(); let file=f.file(&saved.id);
        let result=f.db.delete_project_keep_managed(&f.paths,"p").unwrap();
        assert_eq!(result.deleted_assets,0); assert!(file.is_file());
        assert_eq!(load_document(&f.paths,&f.db,&saved.id).unwrap(),Some(doc));
        assert!(f.db.get_asset(&saved.id).unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn linked_document_files_are_neither_opened_nor_deleted() {
        let f=Fixture::new(); let url=image_url(8,8);
        let saved=f.save(document(&url),&url,"linked").unwrap(); let file=f.file(&saved.id);
        let outside=f.paths.root.join("preserved.json"); fs::rename(&file,&outside).unwrap();
        std::os::unix::fs::symlink(&outside,&file).unwrap();
        assert!(load_document(&f.paths,&f.db,&saved.id).is_err());
        f.db.delete_asset(&saved.id).unwrap();
        assert!(outside.is_file()); assert!(fs::symlink_metadata(&file).unwrap().file_type().is_symlink());
    }

    #[test]
    fn in_memory_cleanup_requires_explicit_root_and_rejects_unsafe_pointers() {
        let f=Fixture::new(); let db=Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let name=format!("{}.json",Ulid::new()); fs::create_dir_all(f.paths.root.join("layers")).unwrap();
        let file=f.paths.root.join("layers").join(&name); fs::write(&file,b"owned").unwrap();
        let conn=db.conn.lock().unwrap();
        conn.execute("INSERT INTO assets(id,name) VALUES('a','a')",[]).unwrap();
        conn.execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('pointer','a','draft_workspace',?1)",[&name]).unwrap();
        assert!(draft_workspace_files(&conn,&["a".into()],None).unwrap().is_empty());
        let files=draft_workspace_files(&conn,&["a".into()],Some(&f.paths.root)).unwrap(); assert_eq!(files,vec![file.clone()]);
        conn.execute("UPDATE analyses SET payload='../outside.json'",[]).unwrap();
        assert!(draft_workspace_files(&conn,&["a".into()],Some(&f.paths.root)).unwrap().is_empty());
        assert!(cleanup_draft_workspace_files(&conn,&files).is_empty()); assert!(!file.exists());
    }

    #[test]
    fn library_migration_preserves_editable_drafts_and_idempotency() {
        let f=Fixture::new(); let url=image_url(8,8); let doc=document(&url);
        let saved=f.save(doc.clone(),&url,"migrate").unwrap();
        let target=f.paths.root.parent().unwrap().join(format!("bowerbird-drafts-migrated-{}",Ulid::new()));
        crate::core::migrate::migrate_library(&f.db,&f.paths,&target,&mut |_,_,_| {}).unwrap();
        let moved=LibraryPaths::init(target.clone()).unwrap(); let db=Database::open(&moved.db).unwrap();
        assert_eq!(load_document(&moved,&db,&saved.id).unwrap(),Some(doc.clone()));
        assert_eq!(save_document(&moved,&db,doc,url,Some("p".into()),"migrate".into()).unwrap().id,saved.id);
        assert!(f.file(&saved.id).is_file()); drop(db); fs::remove_dir_all(target).unwrap();
    }
}
