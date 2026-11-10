use super::*;
use std::time::Instant;

struct ReadFixture { db: Database, temp: tempfile::TempDir }
impl ReadFixture {
    fn new(current: usize, other: usize, history: usize) -> Self {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let temp = tempfile::tempdir().unwrap();
        db.create_project("scope", "scope", "blank:scope", "blank:scope", "blank").unwrap();
        for i in 0..history {
            let id = format!("history-{i}");
            db.create_project(&id, &id, &format!("blank:{id}"), &format!("blank:{id}"), "blank").unwrap();
        }
        {
            let conn = db.conn.lock().unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute_batch("INSERT INTO connected_roots(id,path) VALUES('current','/fixture/current'),('other','/fixture/other');
              INSERT INTO connected_folders(id,root_id,path,name) VALUES('current','current','/fixture/current','Current'),('other','other','/fixture/other','Other');").unwrap();
            for i in 0..current + other {
                let folder = if i < current { "current" } else { "other" };
                let id = format!("a-{i:05}");
                let ext = if i % 7 == 0 { "csv" } else if i % 11 == 0 { "mp4" } else { "png" };
                let name = format!("{i:05}.{ext}");
                let path = temp.path().join(&name);
                if i < current { fs::write(&path, b"fixture").unwrap(); }
                tx.execute("INSERT INTO assets(id,name,ext,source,store_path,created_at) VALUES(?1,?2,?3,'external',?4,?5)", params![id,name,ext,string(&path),i as i64]).unwrap();
                tx.execute("INSERT INTO connected_entries(id,folder_id,asset_id,path,name,is_reference,size,mtime) VALUES(?1,?2,?3,?4,?5,0,7,'stamp')", params![format!("e-{i:05}"),folder,id,string(&path),name]).unwrap();
                if i % 2 == 0 {
                    tx.execute("INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('scope',?1,1)", [&id]).unwrap();
                    tx.execute("INSERT INTO asset_colors(asset_id,bucket) VALUES(?1,'red')", [&id]).unwrap();
                }
            }
            for i in 0..history {
                let runs: Vec<_> = (0..20).map(|j| serde_json::json!({"steps": {"image": {"jobId": format!("job-{i}-{j}"), "generatedAssetIds": [format!("a-{:05}", current + (i * 20 + j) % other.max(1))]}}})).collect();
                tx.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES(?1,1,?2)", params![format!("history-{i}"), serde_json::json!({"schema_version":1,"nodes":[],"runs":runs}).to_string()]).unwrap();
            }
            tx.commit().unwrap();
        }
        Self { db, temp }
    }
}

// Frozen pre-optimization query shape: retain a comparable baseline without
// accessing a user's database or relying on timing assertions in normal tests.
fn legacy_ids(db: &Database, folder: Option<&str>, project: Option<&str>, media: Option<&str>, offset: i64, limit: i64, filter: &ConnectionFilter) -> Vec<String> {
    let (condition, mut values) = filter.sql(project, media).unwrap();
    values.extend([folder.map(|v| Value::Text(v.into())).unwrap_or(Value::Null), folder.map(|v| Value::Text(v.into())).unwrap_or(Value::Null), Value::Integer(limit), Value::Integer(offset)]);
    let gallery = filter.gallery(&condition);
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(&format!("WITH {gallery} SELECT e.id FROM ranked_entries e WHERE e.rank=1 AND (? IS NULL OR e.folder_id=?) ORDER BY lower(e.name),e.id LIMIT ? OFFSET ?")).unwrap();
    stmt.query_map(params_from_iter(values), |r| r.get(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap()
}
fn legacy_counts(db: &Database, project: Option<&str>, media: Option<&str>, filter: &ConnectionFilter) -> Vec<(String, i64)> {
    let (condition, values) = filter.sql(project, media).unwrap();
    let gallery = filter.gallery(&condition);
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(&format!("WITH {gallery} SELECT f.id,(SELECT COUNT(*) FROM ranked_entries e WHERE e.folder_id=f.id AND e.rank=1) FROM connected_folders f JOIN connected_roots r ON r.id=f.root_id ORDER BY r.rowid,lower(f.name),f.id")).unwrap();
    stmt.query_map(params_from_iter(values), |r| Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<Vec<_>, _>>().unwrap()
}
fn legacy_resolve(db: &Database, ids: &[String]) -> Vec<ConnectionEntry> {
    let mut result = Vec::new();
    for id in ids {
        let row = db.conn.lock().unwrap().query_row("SELECT e.folder_id,e.asset_id,e.name,e.path,e.is_reference,e.available AND f.available AND r.available FROM connected_entries e JOIN connected_folders f ON f.id=e.folder_id JOIN connected_roots r ON r.id=f.root_id WHERE e.id=?1", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,bool>(4)?,r.get::<_,bool>(5)?))).optional().unwrap();
        if let Some((folder_id, asset_id, name, path, is_reference, available)) = row {
            if let Some(asset) = db.get_asset(&asset_id).unwrap() {
                let version = db.conn.lock().unwrap().query_row("SELECT COALESCE(e.fingerprint,f.sha256,(SELECT mtime||':'||size FROM connected_entries WHERE id=?2)) FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.id=?1", params![asset_id,id], |r| r.get(0)).unwrap();
                let available = available && asset.store_path.as_deref().is_some_and(|path| Path::new(path).is_file());
                result.push(ConnectionEntry { id:id.clone(),folder_id,asset_id,name,path,is_reference,available,asset,version,group:Vec::new() });
            }
        }
    }
    result
}
fn legacy_groups(db: &Database, entries: &mut [ConnectionEntry], project: Option<&str>, media: Option<&str>, filter: &ConnectionFilter) {
    if !filter.grouped || entries.is_empty() { return; }
    let (condition,mut values) = filter.sql(project,media).unwrap();
    let gallery = filter.gallery(&condition);
    values.extend(entries.iter().map(|entry| Value::Text(entry.id.clone())));
    let placeholders = vec!["?";entries.len()].join(",");
    let rows = {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("WITH {gallery} SELECT h.id,m.id FROM ranked_entries h JOIN entry_gallery m ON m.folder_id=h.folder_id AND m.group_key=h.group_key WHERE h.id IN ({placeholders}) ORDER BY m.created_at,m.asset_id,m.id")).unwrap();
        stmt.query_map(params_from_iter(values),|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap()
    };
    for entry in entries {
        let ids:Vec<_> = rows.iter().filter(|(head,_)|head==&entry.id).map(|(_,id)|id.clone()).collect();
        if ids.len()>1 { entry.group.extend(legacy_resolve(db,&ids)); }
    }
}

#[test]
fn batch_hydration_preserves_identity_order_versions_and_explicit_original_checks() {
    let f = ReadFixture::new(80, 200, 2);
    {
        let conn = f.db.conn.lock().unwrap();
        conn.execute("INSERT INTO external_assets(asset_id,fingerprint) VALUES('a-00000','external-version')", []).unwrap();
        conn.execute("INSERT INTO creative_file_fingerprints(asset_id,sha256) VALUES('a-00001','creative-version')", []).unwrap();
        conn.execute("INSERT INTO connected_entries(id,folder_id,asset_id,path,name,is_reference) VALUES('reference','current','a-00000','/fixture/ref.bowerbird','ref.bowerbird',1)", []).unwrap();
    }
    let ids = vec!["e-00001", "reference", "e-00000", "e-00002", "missing", "e-00001"].into_iter().map(str::to_owned).collect::<Vec<_>>();
    let baseline = legacy_resolve(&f.db, &ids);
    assert_eq!(serde_json::to_value(&baseline).unwrap(), serde_json::to_value(f.db.read_connection_entries(&ids).unwrap()).unwrap());
    assert_eq!(serde_json::to_value(&baseline).unwrap(), serde_json::to_value(f.db.resolve_connection_entries(&ids).unwrap()).unwrap());
    let original = f.db.get_asset("a-00000").unwrap().unwrap().store_path.unwrap();
    fs::remove_file(original).unwrap();
    assert!(f.db.read_connection_entries(&["e-00000".into()]).unwrap()[0].available, "listing uses indexed status without synchronous stat");
    assert!(!f.db.resolve_connection_entries(&["e-00000".into()]).unwrap()[0].available, "explicit operations verify the original");
    f.db.conn.lock().unwrap().execute("UPDATE connected_roots SET available=0 WHERE id='current'", []).unwrap();
    assert!(f.db.read_connection_entries(&ids).unwrap().iter().all(|e| !e.available));
    assert!(f.db.read_connection_entries(&[]).unwrap().is_empty());
    assert!(f.db.read_connection_entries(&vec!["e-00000".into();2001]).is_err());
    assert!(f.temp.path().is_dir());
}

#[test]
fn scoped_pages_and_aggregated_counts_match_legacy_with_history_filters_and_separation() {
    let f = ReadFixture::new(100, 600, 4);
    f.db.conn.lock().unwrap().execute("UPDATE assets SET generation_session_id='session' WHERE id IN ('a-00001','a-00002','a-00101')", []).unwrap();
    for separated in [false,true] {
        if separated { f.db.dissolve_generation_group(Some("a-00002"), None).unwrap(); }
        for project in [None, Some("scope")] {
            for media in [None, Some("images"), Some("texts")] {
                for filter in [ConnectionFilter::default(), ConnectionFilter { grouped:true, ..Default::default() }, ConnectionFilter { grouped:true, generated:Some(true), color:None }, ConnectionFilter { grouped:true, generated:Some(false), color:Some("red".into()) }] {
                    let counts = f.db.connection_folders_filtered(project,media,&filter).unwrap().into_iter().map(|f| (f.id,f.count)).collect::<Vec<_>>();
                    assert_eq!(counts, legacy_counts(&f.db,project,media,&filter));
                    for folder in [None, Some("current"), Some("other")] {
                        assert_eq!(f.db.connection_entry_ids_filtered(folder,project,media,7,60,&filter).unwrap(), legacy_ids(&f.db,folder,project,media,7,60,&filter));
                    }
                    let ids = legacy_ids(&f.db,Some("current"),project,media,0,60,&filter);
                    let mut old = legacy_resolve(&f.db,&ids);
                    let mut new = f.db.read_connection_entries(&ids).unwrap();
                    legacy_groups(&f.db,&mut old,project,media,&filter);
                    f.db.connection_entry_groups(&mut new,project,media,&filter).unwrap();
                    assert_eq!(serde_json::to_value(old).unwrap(),serde_json::to_value(new).unwrap());
                }
            }
        }
    }
    let point = f.db.connected_folder("current").unwrap();
    let list = f.db.connection_folders(None,None).unwrap().into_iter().find(|f| f.id=="current").unwrap();
    assert_eq!(serde_json::to_value(point).unwrap(),serde_json::to_value(list).unwrap());
    assert!(f.db.connected_folder("missing").is_err());
}

#[test]
#[ignore = "isolated performance comparison; run explicitly with --ignored --nocapture"]
fn compare_small_folder_reads_with_large_other_roots() {
    for (current,other,history) in [(80,200,0),(100,10_000,20)] {
        let f = ReadFixture::new(current,other,history);
        let filter = ConnectionFilter { grouped:true,..Default::default() };
        let ids = legacy_ids(&f.db,Some("current"),None,None,0,60,&filter);
        let measure = |name: &str, work: &mut dyn FnMut()| {
            work(); // warm SQLite/code paths equally; original file bytes are never decoded.
            let mut samples = Vec::new();
            for _ in 0..5 { let start=Instant::now(); work(); samples.push(start.elapsed().as_micros()); }
            samples.sort_unstable();
            println!("folder-read current={current} other={other} history_projects={history} step={name} median_us={}",samples[2]);
        };
        measure("legacy_counts", &mut || { legacy_counts(&f.db,None,None,&filter); });
        measure("counts", &mut || { f.db.connection_folders_filtered(None,None,&filter).unwrap(); });
        measure("legacy_page_ids", &mut || { legacy_ids(&f.db,Some("current"),None,None,0,60,&filter); });
        measure("page_ids", &mut || { f.db.connection_entry_ids_filtered(Some("current"),None,None,0,60,&filter).unwrap(); });
        measure("legacy_hydrate", &mut || { legacy_resolve(&f.db,&ids); });
        measure("hydrate", &mut || { f.db.read_connection_entries(&ids).unwrap(); });
        measure("legacy_groups", &mut || { let mut entries=f.db.read_connection_entries(&ids).unwrap(); legacy_groups(&f.db,&mut entries,None,None,&filter); });
        measure("groups", &mut || { let mut entries=f.db.read_connection_entries(&ids).unwrap(); f.db.connection_entry_groups(&mut entries,None,None,&filter).unwrap(); });
        measure("point_folder", &mut || { f.db.connected_folder("current").unwrap(); });
    }
}
