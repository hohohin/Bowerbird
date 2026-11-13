use super::*;

#[test]
fn create_folder_uses_current_files_root_or_picked_parent_and_refuses_collisions() {
    let f = Fixture::new();
    let default = f._temp.path().join("BowerbirdLibrary");
    let files = super::super::file_workspace::FileWorkspace::open(f._temp.path().join("files.json"), default.clone()).unwrap();
    assert!(!default.exists());
    let first = f.db.create_connected_directory(&files, None, None, "作品", None).unwrap();
    assert_eq!(Path::new(&f.db.connected_folder(&first).unwrap().path), directory(&default.join("作品")).unwrap());
    assert!(!f.paths.root.join("作品").exists());
    files.configure(&f.source).unwrap();
    let second = f.db.create_connected_directory(&files, None, None, "作品", None).unwrap();
    assert_eq!(Path::new(&f.db.connected_folder(&second).unwrap().path), f.source.join("作品"));
    let picked = f.db.create_connected_directory(&files, None, Some(&f.target), "外部", None).unwrap();
    assert_eq!(Path::new(&f.db.connected_folder(&picked).unwrap().path), f.target.join("外部"));
    fs::write(f.target.join("外部").join("keep.txt"), "existing").unwrap();
    assert!(f.db.create_connected_directory(&files, None, Some(&f.target), "外部", None).unwrap_err().to_string().contains("同名"));
    assert!(f.target.join("外部").join("keep.txt").is_file());
    assert_eq!(files.proposed_root(), f.source);
    assert!(f.db.create_connected_directory(&files, None, Some(&f.target.join("absent")), "外部", None).unwrap_err().to_string().contains("父目录不可访问"));
}

#[test]
fn create_folder_in_connected_tree_registers_unscanned_ancestors_and_rolls_back_failed_project_link() {
    let f = Fixture::new();
    let files = super::super::file_workspace::FileWorkspace::open(f._temp.path().join("files.json"), f._temp.path().join("unused")).unwrap();
    let root = f.connect(&f.source);
    let nested = f.source.join("unscanned").join("parent");
    fs::create_dir_all(&nested).unwrap();
    f.db.create_project("p", "测试", "blank:p", "blank:p", "blank").unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TEMP TRIGGER fail_link BEFORE INSERT ON connected_folder_projects BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    for base in [&f.target, &nested] {
        assert!(f.db.create_connected_directory(&files, None, Some(base), "子目录", Some("p")).is_err());
        assert!(!base.join("子目录").exists());
    }
    assert_eq!(f.db.connected_root_ids().unwrap(), vec![root.clone()]);
    assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 1);
    f.db.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_link").unwrap();
    let id = f.db.create_connected_directory(&files, None, Some(&nested), "子目录", Some("p")).unwrap();
    let folder = f.db.connected_folder(&id).unwrap();
    assert_eq!(folder.root_id, root);
    let parent = f.db.connected_folder(&folder.parent_id.unwrap()).unwrap();
    assert_eq!(Path::new(&parent.path), nested);
    let linked: bool = f.db.conn.lock().unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM connected_folder_projects WHERE folder_id=?1 AND project_id='p')",
        [&id], |row| row.get(0)).unwrap();
    assert!(linked);
    let child = f.db.create_connected_directory(&files, Some(&id), None, "另一个", None).unwrap();
    assert_eq!(f.db.connected_folder(&child).unwrap().parent_id.as_deref(), Some(id.as_str()));
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert_eq!(f.db.connected_root_ids().unwrap(), vec![root]);
    assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 5);
}

fn original_canvas_fixture() -> (Fixture, Vec<AssetOriginal>) {
    use crate::core::{creative_session_contract::{CreativeNodeKind, CreativeNodeRole, CreativeThreadOrigin, CreativeEdgeKind}, project_canvas::{NewCanvasNode, NewCreativeThread, NewCanvasEdge}};
    let mut f = Fixture::new();
    f.db = Database::open(&f._temp.path().join("canvas.sqlite")).unwrap();
    f.db.migrate().unwrap();
    image::RgbImage::from_pixel(8, 8, image::Rgb([90, 40, 60])).save(f.source.join("two.png")).unwrap();
    let root = f.connect(&f.source);
    let ids: Vec<_> = f.entries(&root).into_iter().map(|entry| entry.asset_id).collect();
    let originals = f.db.preview_asset_originals(&ids).unwrap();
    for project in ["delete-main", "delete-other"] {
        f.db.create_project(project, project, &format!("blank:{project}"), project, "blank").unwrap();
        f.db.ensure_project_canvas(project).unwrap();
        f.db.create_creative_thread(&NewCreativeThread { id: project.into(), project_id: project.into(), title: "history".into(), origin: CreativeThreadOrigin::Direct }).unwrap();
    }
    let prompt = NewCanvasNode { id: "delete-prompt".into(), project_id: "delete-main".into(), thread_id: Some("delete-main".into()), kind: CreativeNodeKind::Prompt, asset_id: None, role: None,
        payload_json: r#"{"schema_version":1,"job_id":"delete-job","text":"保留生成历史","status":"done"}"#.into(),
        x: 10., y: 20., width: 200., height: 160., z_index: 1, position_locked: false };
    f.db.create_canvas_node(&prompt).unwrap();
    for (index, original) in originals.iter().enumerate() {
        let node = NewCanvasNode { id: format!("delete-output-{index}"), kind: CreativeNodeKind::Asset, asset_id: Some(original.asset_id.clone()), role: Some(CreativeNodeRole::Output),
            payload_json: r#"{"schema_version":1,"snapshot":{"name":"generated"}}"#.into(), ..prompt.clone() };
        f.db.create_canvas_node(&node).unwrap();
        f.db.create_canvas_edge(&NewCanvasEdge { id: format!("delete-edge-{index}"), project_id: prompt.project_id.clone(), thread_id: "delete-main".into(),
            from_node_id: prompt.id.clone(), to_node_id: node.id.clone(), kind: CreativeEdgeKind::Produced, ordinal: index as i64 }).unwrap();
    }
    // One physical file can have multiple registered identities and project instances.
    f.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,source,store_path) SELECT 'delete-alias',name,ext,source,store_path FROM assets WHERE id=?1", [&originals[0].asset_id]).unwrap();
    f.db.create_canvas_node(&NewCanvasNode { id: "delete-copy".into(), project_id: "delete-other".into(), thread_id: None, kind: CreativeNodeKind::Asset, asset_id: Some("delete-alias".into()), role: Some(CreativeNodeRole::Reference),
        payload_json: r#"{"schema_version":1,"snapshot":{"name":"copy"}}"#.into(), ..prompt }).unwrap();
    (f, originals)
}

#[test]
fn original_canvas_trash_hides_instances_and_last_output_but_keeps_history() {
    let (f, originals) = original_canvas_fixture();
    let before = f.db.list_canvas_nodes("delete-main").unwrap();
    assert!(f.db.trash_asset_original_with(&originals[0], |_| Err(invalid("recycle failure"))).is_err());
    assert_eq!(f.db.list_canvas_nodes("delete-main").unwrap(), before, "failed recycling rolls back canvas visibility too");
    for (index, original) in originals.iter().enumerate() {
        f.db.trash_asset_original_with(original, |path| { fs::remove_file(path)?; Ok(()) }).unwrap();
        assert!(f.db.get_canvas_node(&format!("delete-output-{index}")).unwrap().unwrap().hidden_at.is_some());
        assert_eq!(f.db.get_canvas_node("delete-prompt").unwrap().unwrap().hidden_at.is_some(), index == 1, "keep a generation card while another original remains");
        assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
    }
    assert!(f.db.get_canvas_node("delete-copy").unwrap().unwrap().hidden_at.is_some(), "same-file aliases in other projects disappear too");
    let snapshot = f.db.project_canvas_snapshot("delete-main").unwrap();
    assert_eq!(snapshot.nodes.len(), before.len());
    assert!(snapshot.nodes.iter().all(|node| node.hidden_at.is_some()));
    assert_eq!(snapshot.nodes.iter().find(|node| node.id == "delete-prompt").unwrap().payload_json,
        before.iter().find(|node| node.id == "delete-prompt").unwrap().payload_json);
    assert_eq!(snapshot.edges.len(), 2, "history edges are retained");
    let reopened = Database::open(&f._temp.path().join("canvas.sqlite")).unwrap();
    assert!(reopened.project_canvas_snapshot("delete-main").unwrap().nodes.iter().all(|node| node.hidden_at.is_some()));
}

#[test]
fn original_canvas_missing_cleanup_repairs_old_residue_and_is_idempotent() {
    let (f, originals) = original_canvas_fixture();
    for original in &originals {
        fs::remove_file(&original.path).unwrap();
        // Simulate a previous version that marked the file missing but left visible nodes.
        f.db.conn.lock().unwrap().execute("INSERT INTO removed_missing_asset_originals(asset_id,path) VALUES(?1,?2)", params![original.asset_id, original.path]).unwrap();
    }
    for original in &originals {
        let missing = f.db.preview_asset_originals(&[original.asset_id.clone()]).unwrap().remove(0);
        f.db.trash_asset_original_with(&missing, |_| panic!("missing cleanup must not recycle files")).unwrap();
        f.db.trash_asset_original_with(&missing, |_| panic!("repeat cleanup must not recycle files")).unwrap();
    }
    assert!(f.db.project_canvas_snapshot("delete-main").unwrap().nodes.iter().all(|node| node.hidden_at.is_some()));
    assert!(f.db.get_canvas_node("delete-copy").unwrap().unwrap().hidden_at.is_some());
    assert_eq!(f.db.project_canvas_snapshot("delete-main").unwrap().edges.len(), 2);
}

#[test]
fn gallery_counts_pages_filters_and_members_keep_folder_entry_identity() {
    let f = Fixture::new();
    for (name, color) in [("a-old.png", 80), ("b-new.png", 140)] {
        image::RgbImage::from_pixel(8, 8, image::Rgb([color, 40, 60])).save(f.source.join(name)).unwrap();
    }
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let entries = f.entries(&root);
    let old = entries.iter().find(|e| e.name == "a-old.png").unwrap();
    let new = entries.iter().find(|e| e.name == "b-new.png").unwrap();
    let ordinary = entries.iter().find(|e| e.name == "one.png").unwrap();
    for (entry, session, time, color) in [(old, "first", 10, "red"), (new, "second", 20, "blue")] {
        f.db.conn.lock().unwrap().execute("UPDATE assets SET generation_session_id=?2,created_at=?3 WHERE id=?1", params![entry.asset_id, session, time]).unwrap();
        f.db.conn.lock().unwrap().execute("INSERT INTO asset_colors(asset_id,bucket) VALUES(?1,?2)", params![entry.asset_id, color]).unwrap();
        f.db.record_generation_conversation(session, "one-conversation").unwrap();
    }
    f.db.create_material_references(&f.paths, &[old.asset_id.clone()], &target).unwrap();
    let grouped = ConnectionFilter { grouped: true, ..Default::default() };
    let folders = f.db.connection_folders_filtered(None, Some("images"), &grouped).unwrap();
    assert_eq!(folders.iter().find(|f| f.id == root).unwrap().count, 2);
    assert_eq!(folders.iter().find(|f| f.id == target).unwrap().count, 1);
    let ids = f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 0, 1, &grouped).unwrap();
    assert_eq!(ids, vec![new.id.clone()]); // Latest member, still sorted by filename.
    assert_eq!(f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 1, 1, &grouped).unwrap(), vec![ordinary.id.clone()]);
    let mut page = f.db.resolve_connection_entries(&ids).unwrap();
    f.db.connection_entry_groups(&mut page, None, Some("images"), &grouped).unwrap();
    assert_eq!(page[0].group.iter().map(|e| &e.id).collect::<Vec<_>>(), vec![&old.id, &new.id]);
    assert!(page[0].group.iter().all(|e| e.folder_id == root));
    let red = ConnectionFilter { color: Some("red".into()), grouped: true, ..Default::default() };
    assert_eq!(f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 0, 20, &red).unwrap(), vec![old.id.clone()]);
    assert_eq!(f.db.connection_folders_filtered(None, Some("images"), &red).unwrap().iter().find(|f| f.id == root).unwrap().count, 1);
    let source = ConnectionFilter { generated: Some(false), grouped: true, ..Default::default() };
    assert_eq!(f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 0, 20, &source).unwrap(), vec![ordinary.id.clone()]);
    f.db.dissolve_generation_group(Some(&new.asset_id), None).unwrap();
    assert_eq!(f.db.connection_folders_filtered(None, Some("images"), &grouped).unwrap().iter().find(|folder| folder.id == root).unwrap().count, 3);
    assert_eq!(f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 0, 1, &grouped).unwrap(), vec![old.id.clone()]);
    assert_eq!(f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 1, 1, &grouped).unwrap(), vec![new.id.clone()]);
    let mut separated = f.db.resolve_connection_entries(&[old.id.clone(), new.id.clone()]).unwrap();
    f.db.connection_entry_groups(&mut separated, None, Some("images"), &grouped).unwrap();
    assert!(separated.iter().all(|entry| entry.group.len() <= 1));
    // The same images belong to an Agent card: each stays visible even with a
    // shared generation conversation, and keeps its original folder entry ID.
    f.db.create_project("agent-project", "Agent", "blank:agent", "blank:agent", "blank").unwrap();
    let history = serde_json::json!({"schema_version":1,"nodes":[],"runs":[{"steps":{"agent":{
        "localDsRequestId":"request","generatedAssetIds":[old.asset_id,new.asset_id]
    }}}]});
    f.db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('agent-project',1,?1)", [history.to_string()]).unwrap();
    assert_eq!(f.db.connection_folders_filtered(None, Some("images"), &grouped).unwrap().iter().find(|f| f.id == root).unwrap().count, 3);
    let generated = ConnectionFilter { generated: Some(true), grouped: true, ..Default::default() };
    assert_eq!(f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 0, 1, &generated).unwrap(), vec![old.id.clone()]);
    assert_eq!(f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 1, 1, &generated).unwrap(), vec![new.id.clone()]);
    let mut page = f.db.resolve_connection_entries(&[old.id.clone(), new.id.clone()]).unwrap();
    f.db.connection_entry_groups(&mut page, None, Some("images"), &generated).unwrap();
    assert_eq!(page.iter().map(|entry| &entry.id).collect::<Vec<_>>(), vec![&old.id, &new.id]);
    assert!(page.iter().all(|entry| entry.group.is_empty()), "standalone files have no gallery members");
    assert_eq!(f.db.connection_entry_ids_filtered(Some(&root), None, Some("images"), 0, 20, &source).unwrap(), vec![ordinary.id.clone()]);
    assert_eq!(f.entries(&root).len(), 3, "physical operations still enumerate every original");
    assert!(f.source.join("a-old.png").exists() && f.source.join("b-new.png").exists());
}

#[test]
fn original_trash_preview_resolves_registered_original_once_without_copying() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let asset = f.entries(&root).pop().unwrap().asset;
    let bytes = fs::read(f.source.join("one.png")).unwrap();
    let preview =
        f.db.preview_asset_originals(&[asset.id.clone(), asset.id.clone()])
            .unwrap();
    assert_eq!(preview.len(), 1);
    assert!(!preview[0].missing);
    assert_eq!(preview[0].asset_id, asset.id);
    assert_eq!(preview[0].name, "one.png");
    assert_eq!(preview[0].path, string(&f.source.join("one.png")));
    assert_eq!(
        preview[0].fingerprint,
        external_files::fingerprint(&f.source.join("one.png")).unwrap()
    );
    assert_eq!(fs::read(f.source.join("one.png")).unwrap(), bytes);
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
}

#[test]
fn original_trash_preview_rejects_unknown_and_non_media_targets() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let asset = f.entries(&root).pop().unwrap().asset;
    assert!(f.db.preview_asset_originals(&[]).is_err());
    assert!(f
        .db
        .preview_asset_originals(&[asset.id.clone(), "unknown".into()])
        .is_err());
    let invalid_file = f.source.join("reference.bowerbird");
    fs::write(&invalid_file, b"{}").unwrap();
    for path in [&f.source, &invalid_file] {
        f.db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET store_path=?2 WHERE id=?1",
                params![asset.id, string(path)],
            )
            .unwrap();
        assert!(f.db.preview_asset_originals(&[asset.id.clone()]).is_err());
    }
    f.db.conn.lock().unwrap().execute("UPDATE assets SET store_path=NULL WHERE id=?1", [&asset.id]).unwrap();
    assert!(f.db.preview_asset_originals(&[asset.id]).is_err());
}

#[test]
fn original_trash_keeps_creative_identity_and_reference_files_but_marks_them_missing() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    f.db.create_project(
        "trash-project",
        "project",
        f.source.to_str().unwrap(),
        "project",
        "user",
    )
    .unwrap();
    f.db.add_assets_to_project("trash-project", &[original.asset_id.clone()])
        .unwrap();
    let reference = f.entries(&target).pop().unwrap();
    let expected = fs::read(&original.path).unwrap();
    let preview =
        f.db.preview_asset_originals(&[reference.asset_id.clone()])
            .unwrap();
    let recycled = f._temp.path().join("recycled.png");
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, &recycled)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(fs::read(&recycled).unwrap(), expected);
    assert!(Path::new(&reference.path).is_file());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
    assert!(!f.entries(&target)[0].available);
    assert!(f.entries(&root).is_empty());
    let membership: i64 = f
        .db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM project_assets WHERE project_id='trash-project' AND asset_id=?1",
            [&original.asset_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(membership, 1);
}

#[test]
fn original_preview_keeps_valid_items_and_reports_unavailable_records() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let selection = [entry.asset_id.clone(), "gone".into(), entry.asset_id.clone()];
    let previews = f.db.preview_original_selection(&selection).unwrap();
    assert!(matches!(previews.as_slice(), [OriginalPreview::Ready(_), OriginalPreview::Unavailable { asset_id, .. }] if asset_id == "gone"));
    fs::write(&entry.path, b"replacement at the registered path").unwrap();
    let OriginalPreview::Ready(preview) = &previews[0] else { unreachable!() };
    assert!(f.db.trash_asset_original_with(preview, |_| panic!("replacement must stay in place")).is_err());
    assert!(f.db.preview_asset_originals(&[entry.asset_id]).is_err(), "maintenance verifies the actual bytes");
}

#[test]
fn original_recycling_allows_database_reads_while_the_shell_is_busy() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let original = f.db.preview_asset_originals(&[entry.asset_id]).unwrap().pop().unwrap();
    f.db.trash_asset_original_with(&original, |path| {
        assert!(f.db.conn.try_lock().is_ok(), "system recycle must release the database");
        fs::rename(path, f._temp.path().join("recycled.png"))?;
        Ok(())
    }).unwrap();
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "moves a generated temporary PNG to the real Windows recycle bin"]
fn windows_recycle_temporary_original_and_verify_catalog() {
    let f = Fixture::new();
    fs::rename(f.source.join("one.png"), f.source.join(format!("bowerbird-recycle-test-{}.png", id()))).unwrap();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let original = f.db.preview_asset_originals(&[entry.asset_id.clone()]).unwrap().pop().unwrap();
    f.db.trash_asset_original(&original).unwrap();
    assert!(!Path::new(&original.path).exists());
    assert!(f.db.get_asset(&entry.asset_id).unwrap().unwrap().library_hidden);
    assert!(f.entries(&root).is_empty());
}

#[test]
#[ignore = "timing comparison for the original confirmation, run explicitly"]
fn measure_registered_original_preview() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let path = Path::new(&entry.path);
    fs::OpenOptions::new().write(true).open(path).unwrap().set_len(64 * 1024 * 1024).unwrap();
    let fingerprint = external_files::fingerprint(path).unwrap();
    f.db.conn.lock().unwrap().execute("UPDATE external_assets SET fingerprint=?2 WHERE asset_id=?1",
        params![entry.asset_id, fingerprint]).unwrap();
    let ids = [entry.asset_id];
    let start = std::time::Instant::now();
    let verified = f.db.preview_asset_originals(&ids).unwrap();
    let full_read = start.elapsed();
    let start = std::time::Instant::now();
    let displayed = f.db.preview_original_selection(&ids).unwrap();
    let registered = start.elapsed();
    assert!(matches!(&displayed[0], OriginalPreview::Ready(item) if item.fingerprint == verified[0].fingerprint));
    println!("64 MiB original, full hash preview: {full_read:?}, registered preview: {registered:?}");
}

#[test]
fn original_trash_rechecks_the_confirmed_path_and_bytes() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    f.db.rename_connection_entry(&entry.id, "moved.png")
        .unwrap();
    assert!(f
        .db
        .trash_asset_original_with(&preview[0], |_| panic!("stale path must not recycle"))
        .is_err());
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    fs::write(&preview[0].path, b"replaced while confirming").unwrap();
    assert!(f
        .db
        .trash_asset_original_with(&preview[0], |_| panic!("stale bytes must not recycle"))
        .is_err());
    assert!(Path::new(&preview[0].path).is_file());
}

#[test]
fn original_trash_failure_preserves_files_and_connection_availability() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    assert!(f
        .db
        .trash_asset_original_with(&preview[0], |_| Err(invalid("recycle unavailable")))
        .is_err());
    assert!(Path::new(&entry.path).is_file());
    assert!(f.entries(&root)[0].available);
    assert!(f.db.get_asset(&entry.asset_id).unwrap().is_some());
}

#[test]
fn original_trash_sql_preflight_failure_never_touches_the_file() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER refuse_original_trash BEFORE UPDATE OF library_hidden ON assets BEGIN SELECT RAISE(ABORT,'synthetic SQL failure'); END;").unwrap();
    assert!(f
        .db
        .trash_asset_original_with(&preview[0], |_| panic!("SQL failure must precede recycle"))
        .is_err());
    assert!(Path::new(&entry.path).is_file());
    assert!(f.entries(&root)[0].available);
    assert_eq!(
        f.db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM trashed_asset_originals", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn original_trash_commit_failure_reports_that_the_original_is_already_recycled() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TABLE fail_commit(id TEXT REFERENCES assets(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER defer_original_trash_failure AFTER INSERT ON trashed_asset_originals BEGIN INSERT INTO fail_commit VALUES('absent'); END;").unwrap();
    let recycled = f._temp.path().join("recycled.png");
    let error =
        f.db.trash_asset_original_with(&preview[0], |path| {
            fs::rename(path, &recycled)?;
            Ok(())
        })
        .unwrap_err();
    assert!(error.to_string().contains("原文件已放入回收站"));
    assert!(!Path::new(&entry.path).exists());
    assert!(recycled.is_file());
    assert!(f.db.get_asset(&entry.asset_id).unwrap().is_some());
}

#[test]
fn original_trash_updates_all_registered_identities_for_the_same_file() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let entry = f.entries(&root).pop().unwrap();
    let mut duplicate = entry.asset.clone();
    duplicate.id = "same-original".into();
    f.db.insert_asset(&duplicate).unwrap();
    f.db.create_material_references(&f.paths, &[duplicate.id.clone()], &target)
        .unwrap();
    let preview =
        f.db.preview_asset_originals(&[entry.asset_id.clone()])
            .unwrap();
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, f._temp.path().join("recycled.png"))?;
        Ok(())
    })
    .unwrap();
    assert!(
        f.db.get_asset(&entry.asset_id)
            .unwrap()
            .unwrap()
            .library_hidden
    );
    assert!(
        f.db.get_asset(&duplicate.id)
            .unwrap()
            .unwrap()
            .library_hidden
    );
    assert!(!f.entries(&target)[0].available);
    assert_eq!(
        f.db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM trashed_asset_originals", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn original_trash_supports_unconnected_registered_files() {
    let f = Fixture::new();
    let asset =
        f.db.index_connected_file(&f.paths, &f.source.join("one.png"), None)
            .unwrap();
    assert!(!f.db.has_connected_asset(&asset.id).unwrap());
    let preview = f.db.preview_asset_originals(&[asset.id.clone()]).unwrap();
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, f._temp.path().join("recycled.png"))?;
        Ok(())
    })
    .unwrap();
    assert!(!f.source.join("one.png").exists());
    assert!(f.db.get_asset(&asset.id).unwrap().is_some());
}

#[test]
fn original_trash_supports_managed_generated_assets_without_external_registration() {
    let f = Fixture::new();
    let asset =
        f.db.index_connected_file(&f.paths, &f.source.join("one.png"), None)
            .unwrap();
    f.db.conn
        .lock()
        .unwrap()
        .execute("DELETE FROM external_assets WHERE asset_id=?1", [&asset.id])
        .unwrap();
    f.db.conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE assets SET source='generated' WHERE id=?1",
            [&asset.id],
        )
        .unwrap();
    let preview = f.db.preview_asset_originals(&[asset.id.clone()]).unwrap();
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, f._temp.path().join("recycled.png"))?;
        Ok(())
    })
    .unwrap();
    assert!(!f.source.join("one.png").exists());
    assert!(f.db.get_asset(&asset.id).unwrap().unwrap().library_hidden);
}

#[test]
fn reference_removal_rejects_originals_before_touching_any_selected_file() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    let reference = f.entries(&target).pop().unwrap();
    assert!(f
        .db
        .remove_connection_references_with(&[reference.id.clone(), original.id], |_| panic!(
            "mixed removal must not recycle"
        ))
        .is_err());
    assert!(Path::new(&reference.path).is_file());
    assert!(Path::new(&original.path).is_file());
    f.db.remove_connection_references_with(&[reference.id.clone(), reference.id], |path| {
        fs::rename(path, f._temp.path().join("recycled.bowerbird"))?;
        Ok(())
    })
    .unwrap();
    assert!(f.entries(&target).is_empty());
    assert!(Path::new(&original.path).is_file());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
}

#[test]
fn reference_removal_can_retry_after_partial_failure_without_touching_originals() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    fs::copy(
        &f.entries(&target)[0].path,
        f.target.join("second.bowerbird"),
    )
    .unwrap();
    f.db.scan_connection(&f.paths, &target).unwrap();
    let entries = f.entries(&target);
    let ids = entries
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 2);
    let count = std::cell::Cell::new(0);
    assert!(f
        .db
        .remove_connection_references_with(&ids, |path| {
            count.set(count.get() + 1);
            if count.get() == 2 {
                return Err(invalid("synthetic locked file"));
            }
            fs::rename(path, f._temp.path().join("first.bowerbird"))?;
            Ok(())
        })
        .is_err());
    assert_eq!(f.entries(&target).len(), 1);
    f.db.remove_connection_references_with(&ids, |path| {
        fs::rename(path, f._temp.path().join("second.bowerbird"))?;
        Ok(())
    })
    .unwrap();
    assert!(f.entries(&target).is_empty());
    assert!(Path::new(&original.path).is_file());
}
struct Fixture {
    _temp: tempfile::TempDir,
    db: Database,
    paths: LibraryPaths,
    source: PathBuf,
    target: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(temp.path().join("library")).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        image::RgbImage::from_pixel(8, 8, image::Rgb([20, 40, 60]))
            .save(source.join("one.png"))
            .unwrap();
        Self {
            _temp: temp,
            db,
            paths,
            source: directory(&source).unwrap(),
            target: directory(&target).unwrap(),
        }
    }
    fn connect(&self, path: &Path) -> String {
        let id = self.db.connect_directory(path, None).unwrap();
        self.db.scan_connection(&self.paths, &id).unwrap();
        id
    }
    fn entries(&self, id: &str) -> Vec<ConnectionEntry> {
        let ids = self.db.every_entry_id(Some(id)).unwrap();
        self.db.resolve_connection_entries(&ids).unwrap()
    }
    fn duplicate_folder_path(&self, folder: &FolderConnection, duplicate: &str) {
        let conn = self.db.conn.lock().unwrap();
        conn.execute(
            "UPDATE connected_folders SET path=?2,available=0 WHERE id=?1",
            params![folder.id, string(&Path::new(&folder.path).join(""))],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO connected_folders(id,root_id,parent_id,path,name) VALUES(?1,?2,?3,?4,?5)",
            params![duplicate, folder.root_id, folder.parent_id, folder.path, folder.name],
        )
        .unwrap();
    }
}
#[test]
fn connects_without_copy_and_keeps_identity_on_incremental_refresh() {
    let f = Fixture::new();
    let bytes = fs::read(f.source.join("one.png")).unwrap();
    let root = f.connect(&f.source);
    let before = f.entries(&root);
    assert_eq!(before.len(), 1);
    assert_eq!(
        before[0].asset.store_path.as_deref(),
        f.source.join("one.png").to_str()
    );
    assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
    f.db.scan_connection(&f.paths, &root).unwrap();
    let after = f.entries(&root);
    assert_eq!(after[0].id, before[0].id);
    assert_eq!(after[0].asset_id, before[0].asset_id);
    assert_eq!(fs::read(f.source.join("one.png")).unwrap(), bytes);
}
#[test]
fn refresh_checks_selected_directory_before_other_cached_directories() {
    let f = Fixture::new();
    let child = f.source.join("selected");
    fs::create_dir(&child).unwrap();
    let root = f.connect(&f.source);
    let selected =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|folder| folder.path == string(&child))
            .unwrap()
            .id;
    fs::copy(f.source.join("one.png"), f.source.join("root-new.png")).unwrap();
    fs::copy(f.source.join("one.png"), child.join("selected-new.png")).unwrap();
    let mut selected_seen_first = false;
    f.db.scan_connection_prioritized(&f.paths, &root, Some(&selected), || {
        let selected_count = f.entries(&selected).len();
        let root_count = f.entries(&root).len();
        if selected_count == 1 && root_count == 1 {
            selected_seen_first = true;
        }
    })
    .unwrap();
    assert!(selected_seen_first);
    assert_eq!(f.entries(&root).len(), 2);
    assert_eq!(f.entries(&selected).len(), 1);
}

#[test]
fn unchanged_scan_does_not_rewrite_entries_or_report_catalog_changes() {
    let f = Fixture::new();
    fs::create_dir(f.source.join("nested")).unwrap();
    let root = f.connect(&f.source);
    f.db.conn.lock().unwrap().execute_batch("CREATE TABLE scan_write_audit(value INTEGER);
        CREATE TRIGGER audit_entry_scan AFTER UPDATE ON connected_entries BEGIN INSERT INTO scan_write_audit VALUES(1); END;
        CREATE TRIGGER audit_folder_scan AFTER UPDATE ON connected_folders BEGIN INSERT INTO scan_write_audit VALUES(1); END;").unwrap();
    let mut changes = 0;
    f.db.scan_connection_changes(&f.paths, &root, None, |changed| changes += usize::from(changed)).unwrap();
    assert_eq!(changes, 0, "scan progress alone must not invalidate the catalog");
    let writes: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM scan_write_audit", [], |row| row.get(0)).unwrap();
    assert_eq!(writes, 0, "unchanged entries and folders need no UPDATE");
    fs::copy(f.source.join("one.png"), f.source.join("new.png")).unwrap();
    f.db.scan_connection_changes(&f.paths, &root, None, |changed| changes += usize::from(changed)).unwrap();
    assert!(changes > 0);
    changes = 0;
    fs::remove_file(f.source.join("new.png")).unwrap();
    f.db.scan_connection_changes(&f.paths, &root, None, |changed| changes += usize::from(changed)).unwrap();
    assert!(changes > 0, "completed deletion reconciliation must notify");
}

#[test]
fn scan_reports_offline_and_restore_once_without_discarding_cached_entries() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let saved = f._temp.path().join("offline");
    fs::rename(&f.source, &saved).unwrap();
    let mut changes = 0;
    assert!(f.db.scan_connection_changes(&f.paths, &root, None, |changed| changes += usize::from(changed)).is_err());
    assert!(changes > 0);
    changes = 0;
    assert!(f.db.scan_connection_changes(&f.paths, &root, None, |changed| changes += usize::from(changed)).is_err());
    assert_eq!(changes, 0, "unchanged offline state is progress, not new content");
    fs::rename(&saved, &f.source).unwrap();
    f.db.scan_connection_changes(&f.paths, &root, None, |changed| changes += usize::from(changed)).unwrap();
    assert!(changes > 0);
    assert_eq!(f.entries(&root).len(), 1);
}
#[test]
fn scan_excludes_only_its_own_generated_cache_and_database_paths() {
    let f = Fixture::new();
    let library = fs::canonicalize(&f.paths.root).unwrap();
    let preview = library.join("external-previews");
    fs::create_dir(&preview).unwrap();
    fs::copy(f.source.join("one.png"), preview.join("cache.png")).unwrap();
    fs::copy(
        f.source.join("one.png"),
        f.paths.thumbnails.join("cache.png"),
    )
    .unwrap();
    fs::copy(f.source.join("one.png"), library.join("original.png")).unwrap();
    let ignored = generated_connection_paths(&f.paths);
    assert!(ignored.contains(&library.join("library.db-wal")));
    assert!(!ignored
        .iter()
        .any(|path| library.join("images").starts_with(path)));
    let root = f.connect(&library);
    assert_eq!(f.entries(&root).len(), 1);
    assert!(!f
        .db
        .connection_folders(None, None)
        .unwrap()
        .iter()
        .any(|folder| folder.path == string(&preview)));
    let user_named_cache = f.source.join("external-previews");
    fs::create_dir(&user_named_cache).unwrap();
    fs::copy(
        f.source.join("one.png"),
        user_named_cache.join("original.png"),
    )
    .unwrap();
    f.connect(&f.source);
    let user_folder =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|folder| folder.path == string(&user_named_cache))
            .unwrap();
    assert_eq!(f.entries(&user_folder.id).len(), 1);
}
#[test]
fn cached_reference_tracks_changed_original_outside_connected_roots() {
    let f = Fixture::new();
    let source = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&source).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    f.db.scan_connection(&f.paths, &target).unwrap();
    f.db.disconnect_directory(&f.paths, &source).unwrap();
    image::RgbImage::from_pixel(11, 6, image::Rgb([90, 70, 25]))
        .save(f.source.join("one.png"))
        .unwrap();
    f.db.scan_connection(&f.paths, &target).unwrap();
    let updated = f.entries(&target).pop().unwrap();
    assert!(updated.available);
    assert_eq!(updated.asset_id, original.asset_id);
    assert_ne!(updated.version, original.version);
    assert_eq!(updated.asset.width, Some(11));
    let reference = load_reference(Path::new(&updated.path)).unwrap();
    assert_eq!(Some(reference.sha256), updated.version);
}
#[test]
fn references_have_independent_entries_and_reference_deletion_preserves_original() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    let entry = f.entries(&target).pop().unwrap();
    assert!(entry.is_reference);
    assert_ne!(entry.id, original.id);
    assert_eq!(entry.asset_id, original.asset_id);
    assert!(fs::metadata(&entry.path).unwrap().len() < 2048);
    f.db.rename_connection_entry(&entry.id, "alternate")
        .unwrap();
    assert!(f.target.join("alternate.bowerbird").is_file());
    let recycle = f._temp.path().join("test-trash");
    fs::create_dir(&recycle).unwrap();
    f.db.trash_entries_with(&[entry.id], |path| {
        fs::rename(path, recycle.join(name(path)))?;
        Ok(())
    })
    .unwrap();
    assert!(f.source.join("one.png").exists());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
    assert_eq!(f.entries(&target).len(), 0);
}
#[test]
fn adding_a_reference_publishes_only_after_index_preflight_and_recovers_an_unindexed_copy() {
    let f = Fixture::new();
    let source = f.connect(&f.source);
    let target = f.connect(&f.target);
    let asset = f.entries(&source).pop().unwrap().asset_id;
    let invalid_neighbor = f.target.join("unrelated.bowerbird");
    fs::write(&invalid_neighbor, b"unrelated unreadable reference").unwrap();
    f.db.conn.lock().unwrap().execute_batch(
        "CREATE TEMP TRIGGER fail_new_ref BEFORE INSERT ON connected_entries BEGIN SELECT RAISE(ABORT, 'test'); END"
    ).unwrap();
    assert!(f.db.add_material_reference(&asset, &target).is_err());
    assert_eq!(fs::read_dir(&f.target).unwrap().count(), 1);
    f.db.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_new_ref").unwrap();
    assert!(f.db.add_material_reference(&asset, &target).unwrap());
    assert!(!f.db.add_material_reference(&asset, &target).unwrap());
    let reference = f.entries(&target).pop().unwrap();
    f.db.conn.lock().unwrap().execute("DELETE FROM connected_entries WHERE id=?1", [&reference.id]).unwrap();
    assert!(f.db.add_material_reference(&asset, &target).unwrap());
    assert_eq!(f.entries(&target)[0].path, reference.path);
    assert_eq!(fs::read_dir(&f.target).unwrap().count(), 2);
    assert_eq!(fs::read(invalid_neighbor).unwrap(), b"unrelated unreadable reference");
}

#[test]
fn original_move_rejects_replaced_bytes_before_and_after_reindexing() {
    let f = Fixture::new();
    let source = f.connect(&f.source);
    let target = f.connect(&f.target);
    let selected = f.entries(&source).pop().unwrap();
    image::RgbImage::from_pixel(3, 7, image::Rgb([7, 18, 29])).save(&selected.path).unwrap();
    for refresh in [false, true] {
        if refresh { f.db.scan_connection(&f.paths, &source).unwrap(); }
        assert!(f.db.move_connection_entry_verified(&selected.id, &target, selected.version.as_deref()).is_err());
        assert!(Path::new(&selected.path).is_file());
        assert!(!f.target.join(&selected.name).exists());
    }
}

#[test]
fn asset_move_indexes_an_unconnected_original_and_preserves_shared_identity_and_projects() {
    let f = Fixture::new();
    let source = f.source.join("one.png");
    let asset = f.db.index_connected_file(&f.paths, &source, None).unwrap();
    let mut alternate = asset.clone();
    alternate.id = "same-path-second-id".into();
    alternate.name = "另一个素材名称".into();
    f.db.insert_asset(&alternate).unwrap();
    f.db.create_project("existing", "existing", "existing", "existing", "project").unwrap();
    f.db.create_project("target", "target", "target", "target", "project").unwrap();
    f.db.conn.lock().unwrap().execute("INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('existing',?1,1)",[&alternate.id]).unwrap();
    let target = f.db.connect_directory(&f.target, Some("target")).unwrap();
    let refs = f._temp.path().join("refs");
    fs::create_dir(&refs).unwrap();
    let refs = f.connect(&refs);
    f.db.add_material_reference(&alternate.id, &refs).unwrap();
    assert!(f.entries(&target).is_empty());
    let selected = f.db.preview_asset_originals(std::slice::from_ref(&asset.id)).unwrap().pop().unwrap();
    assert!(f.db.move_asset_original(&selected, &target).unwrap());
    let dest = f.target.join("one.png");
    assert!(!source.exists());
    assert_eq!(f.db.get_asset(&asset.id).unwrap().unwrap().store_path.as_deref(), dest.to_str());
    let moved = f.db.get_asset(&alternate.id).unwrap().unwrap();
    assert_eq!(moved.store_path.as_deref(), dest.to_str());
    assert_eq!(moved.name, alternate.name);
    let projects: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE asset_id=?1", [&alternate.id], |r| r.get(0)).unwrap();
    assert_eq!(projects, 2);
    let aliases: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(DISTINCT asset_id) FROM external_asset_paths WHERE path=?1", [string(&dest)], |r| r.get(0)).unwrap();
    assert_eq!(aliases, 2);
    assert_eq!(load_reference(Path::new(&f.entries(&refs)[0].path)).unwrap().target_path, string(&dest));
    assert_eq!(f.entries(&target).len(), 1);
    let refreshed = f.db.preview_asset_originals(&[alternate.id]).unwrap().pop().unwrap();
    assert!(!f.db.move_asset_original(&refreshed, &target).unwrap());
    assert!(f.db.move_asset_original(&selected, &target).is_err());
}

#[test]
fn asset_move_handles_managed_files_and_refuses_alias_collisions_or_changed_originals() {
    let f = Fixture::new();
    let template = f.db.index_connected_file(&f.paths, &f.source.join("one.png"), None).unwrap();
    let source = f.paths.images.join("managed.png");
    fs::copy(f.source.join("one.png"), &source).unwrap();
    let source = fs::canonicalize(source).unwrap();
    let mut managed = template.clone();
    managed.id = "managed-generated".into();
    managed.store_path = Some(string(&source));
    managed.origin_path = Some(string(&source));
    f.db.insert_asset(&managed).unwrap();
    let target = f.connect(&f.target);
    let dest = f.target.join("managed.png");
    let selected = f.db.preview_asset_originals(std::slice::from_ref(&managed.id)).unwrap().pop().unwrap();
    f.db.conn.lock().unwrap().execute("INSERT INTO external_asset_paths(asset_id,path) VALUES(?1,?2)", params![template.id,string(&dest)]).unwrap();
    assert!(f.db.move_asset_original(&selected, &target).is_err());
    assert!(source.exists());
    assert!(!dest.exists());
    f.db.conn.lock().unwrap().execute("DELETE FROM external_asset_paths WHERE path=?1", [string(&dest)]).unwrap();
    fs::write(&source, b"replaced before queued move").unwrap();
    assert!(f.db.move_asset_original(&selected, &target).is_err());
    assert!(source.exists());
    fs::copy(f.source.join("one.png"), &source).unwrap();
    assert!(f.db.move_asset_original(&selected, &target).unwrap());
    let moved = f.db.get_asset(&managed.id).unwrap().unwrap();
    assert_eq!(moved.store_path.as_deref(), dest.to_str());
    assert_eq!(moved.origin_path.as_deref(), dest.to_str());
    assert!(!f.db.is_external_asset(&managed.id).unwrap());
    assert_eq!(f.entries(&target)[0].asset_id, managed.id);
    assert!(!source.exists());
}

#[test]
fn offline_original_allows_only_the_selected_reference_to_move() {
    let f = Fixture::new();
    let source = f.connect(&f.source);
    let target = f.connect(&f.target);
    let asset = f.entries(&source)[0].asset_id.clone();
    f.db.add_material_reference(&asset, &target).unwrap();
    let selected = f.entries(&target).pop().unwrap();
    let offline = f._temp.path().join("saved.png");
    fs::rename(f.source.join("one.png"), &offline).unwrap();
    assert!(!f.entries(&target)[0].available);
    assert!(f.db.move_connection_entry_verified(&selected.id, &source, selected.version.as_deref()).unwrap());
    assert!(!Path::new(&selected.path).exists());
    assert!(f.source.join("one.png.bowerbird").is_file());
    assert!(offline.is_file());
    assert!(!f.source.join("one.png").exists());
    assert_eq!(f.db.get_asset(&asset).unwrap().unwrap().store_path.as_deref(), f.source.join("one.png").to_str());
}

#[test]
fn offline_reference_rejoins_moved_original_on_refresh_without_repeating_move() {
    let f = Fixture::new();
    let source = f.connect(&f.source);
    let destination = f.connect(&f.target);
    let refs_path = f._temp.path().join("refs");
    fs::create_dir(&refs_path).unwrap();
    let refs = f.connect(&refs_path);
    let original = f.entries(&source).pop().unwrap();
    f.db.add_material_reference(&original.asset_id, &refs).unwrap();
    let offline = f._temp.path().join("offline");
    fs::rename(&refs_path, &offline).unwrap();
    assert!(matches!(f.db.move_connection_entry(&original.id, &destination), Err(AppError::FileOperationNeedsReview(_))));
    fs::rename(offline, &refs_path).unwrap();
    f.db.scan_connection(&f.paths, &refs).unwrap();
    assert_eq!(load_reference(&refs_path.join("one.png.bowerbird")).unwrap().target_path, string(&f.target.join("one.png")));
    assert!(!Path::new(&original.path).exists());
}

#[test]
fn moving_one_original_repairs_only_its_own_references_and_reports_late_failure() {
    let f = Fixture::new();
    fs::copy(f.source.join("one.png"), f.source.join("other.png")).unwrap();
    let source = f.connect(&f.source);
    let target = f.connect(&f.target);
    let sources = f.entries(&source);
    let original = sources.iter().find(|e| e.name == "one.png").unwrap();
    let other = sources.iter().find(|e| e.name == "other.png").unwrap();
    for asset in [original, other] {
        f.db.add_material_reference(&asset.asset_id, &target).unwrap();
    }
    let unrelated = f.target.join("other.png.bowerbird");
    fs::write(&unrelated, b"concurrent user edit").unwrap();
    assert!(f.db.move_connection_entry(&original.id, &target).unwrap());
    assert_eq!(fs::read(&unrelated).unwrap(), b"concurrent user edit");
    let rewritten = load_reference(&f.target.join("one.png.bowerbird")).unwrap();
    assert_eq!(rewritten.target_relative.as_deref(), Some("one.png"));
    assert!(matches!(f.db.move_connection_entry(&other.id, &target), Err(AppError::FileOperationNeedsReview(_))));
    assert!(f.target.join("other.png").is_file());
    assert!(!f.source.join("other.png").exists());
    assert_eq!(fs::read(unrelated).unwrap(), b"concurrent user edit");
}

#[test]
fn original_moves_update_references_without_changing_creative_identity() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    f.db.rename_connection_entry(&original.id, "renamed.png")
        .unwrap();
    let reference = f.entries(&target).pop().unwrap();
    let data = load_reference(Path::new(&reference.path)).unwrap();
    assert!(data.target_path.ends_with("renamed.png"));
    assert_eq!(data.asset_id, original.asset_id);
    assert!(reference.available);
    assert!(!f.source.join("one.png").exists());
    f.db.move_connection_entries(&[original.id.clone()], &target)
        .unwrap();
    assert_eq!(f.entries(&target).len(), 2);
    assert!(f.target.join("renamed.png").exists());
    assert!(
        f.db.get_asset(&original.asset_id)
            .unwrap()
            .unwrap()
            .store_path
            .unwrap()
            .ends_with("target\\renamed.png")
            || cfg!(not(windows))
    );
}
#[test]
fn cached_entries_survive_offline_and_disconnect_does_not_delete_assets() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let original = f.entries(&root).pop().unwrap();
    let moved = f.source.with_file_name("offline");
    fs::rename(&f.source, &moved).unwrap();
    assert!(f.db.scan_connection(&f.paths, &root).is_err());
    assert_eq!(f.entries(&root).len(), 1);
    assert!(!f.db.connected_folder(&root).unwrap().available);
    f.db.relocate_connected_directory(&root, &moved).unwrap();
    assert!(f.entries(&root)[0].available);
    for _ in 0..2 {
        f.db.scan_connection(&f.paths, &root).unwrap();
        assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 1);
        assert_eq!(f.db.connected_folder(&root).unwrap().path, string(&moved));
        assert_eq!(f.entries(&root)[0].id, original.id);
        assert_eq!(f.entries(&root)[0].asset_id, original.asset_id);
    }
    f.db.disconnect_directory(&f.paths, &root).unwrap();
    assert!(moved.join("one.png").is_file());
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
}
#[test]
fn disconnected_child_can_be_removed_without_deleting_originals_or_assets() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/nested")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/nested/item.png")).unwrap();
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let child = folders.iter().find(|v| v.name == "child").unwrap();
    let nested = folders.iter().find(|v| v.name == "nested").unwrap();
    let asset = f.entries(&nested.id)[0].asset_id.clone();
    assert!(f.db.disconnect_directory(&f.paths, &child.id).is_err());
    let offline = f.target.join("offline");
    fs::rename(f.source.join("child"), &offline).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    f.db.disconnect_directory(&f.paths, &child.id).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 1);
    assert!(f.db.get_asset(&asset).unwrap().is_some());
    assert!(offline.join("nested/item.png").is_file());
    assert!(f.source.join("one.png").is_file());
}
#[test]
fn disconnected_child_rechecks_disk_before_removing_cached_collection() {
    let f = Fixture::new();
    fs::create_dir(f.source.join("child")).unwrap();
    let root = f.connect(&f.source);
    let child = f.db.connection_folders(None, None).unwrap().into_iter().find(|v| v.name == "child").unwrap();
    let offline = f.target.join("offline");
    fs::rename(f.source.join("child"), &offline).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    fs::rename(&offline, f.source.join("child")).unwrap();
    assert!(f.db.disconnect_directory(&f.paths, &child.id).is_err());
    assert!(f.db.connected_folder(&child.id).is_ok());
}
#[test]
fn nested_directories_are_direct_only_and_move_as_a_subtree() {
    let f = Fixture::new();
    fs::create_dir(f.source.join("child")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/two.png")).unwrap();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let child =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "child")
            .unwrap();
    assert_eq!(f.entries(&root).len(), 1);
    assert_eq!(f.entries(&child.id).len(), 1);
    let before = f.entries(&child.id).pop().unwrap();
    assert!(f.db.move_connected_directory(&root, &child.id).is_err());
    f.db.move_connected_directory(&child.id, &target).unwrap();
    let after = f.entries(&child.id).pop().unwrap();
    assert_eq!(before.asset_id, after.asset_id);
    assert!(f.target.join("child/two.png").is_file());
    assert_eq!(f.db.connected_folder(&child.id).unwrap().root_id, target);
    for _ in 0..2 {
        f.db.scan_connection(&f.paths, &root).unwrap();
        f.db.scan_connection(&f.paths, &target).unwrap();
        assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 3);
        assert_eq!(f.entries(&child.id)[0].id, before.id);
        assert_eq!(f.entries(&child.id)[0].asset_id, before.asset_id);
        assert!(f.entries(&child.id)[0].available);
    }
}
#[test]
fn renamed_collection_keeps_one_identity_after_repeated_refreshes() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/nested")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/nested/two.png")).unwrap();
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let child = folders.iter().find(|v| v.name == "child").unwrap();
    let nested = folders.iter().find(|v| v.name == "nested").unwrap();
    let original = f.entries(&nested.id).pop().unwrap();

    f.db.rename_connected_directory(&child.id, "改名后").unwrap();
    for _ in 0..2 {
        f.db.scan_connection(&f.paths, &root).unwrap();
        let after = f.db.connection_folders(None, None).unwrap();
        assert_eq!(after.len(), folders.len(), "rename must not create an offline duplicate");
        assert!(after.iter().all(|folder| folder.available));
        let renamed = after.iter().find(|folder| folder.id == child.id).unwrap();
        assert_eq!(renamed.name, "改名后");
        assert_eq!(renamed.path, string(&f.source.join("改名后")));
        assert_eq!(f.entries(&nested.id)[0].id, original.id);
        assert_eq!(f.entries(&nested.id)[0].asset_id, original.asset_id);
    }
}
#[test]
fn refresh_repairs_duplicate_ancestor_paths_without_losing_entries_or_projects() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/nested/leaf")).unwrap();
    for folder in ["child", "child/nested"] {
        for file in ["first.png", "second.png"] {
            fs::copy(f.source.join("one.png"), f.source.join(folder).join(file)).unwrap();
        }
    }
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let child = folders.iter().find(|v| v.name == "child").unwrap();
    let nested = folders.iter().find(|v| v.name == "nested").unwrap();
    let leaf = folders.iter().find(|v| v.name == "leaf").unwrap();
    for project in ["old-project", "new-project"] {
        f.db.create_project(project, project, project, project, "project").unwrap();
    }
    let mut originals = Vec::new();
    for (folder, duplicate) in [(child, "duplicate-child"), (nested, "duplicate-nested")] {
        let entries = f.entries(&folder.id);
        f.duplicate_folder_path(folder, duplicate);
        let conn = f.db.conn.lock().unwrap();
        conn.execute("UPDATE connected_entries SET folder_id=?2 WHERE id=?1", params![entries[0].id, duplicate]).unwrap();
        for (id, project) in [(&folder.id[..], "old-project"), (duplicate, "new-project"), (duplicate, "old-project")] {
            conn.execute("INSERT INTO connected_folder_projects(folder_id,project_id) VALUES(?1,?2)", params![id, project]).unwrap();
        }
        originals.push((folder.id.clone(), entries));
    }
    f.db.conn.lock().unwrap().execute(
        "UPDATE connected_folders SET parent_id=CASE WHEN id=?1 THEN 'duplicate-child' ELSE 'duplicate-nested' END WHERE id IN (?1,?2)",
        params![nested.id, leaf.id],
    ).unwrap();

    for _ in 0..2 {
        f.db.scan_connection_prioritized(&f.paths, &root, Some(&nested.id), || {}).unwrap();
        let after = f.db.connection_folders(None, None).unwrap();
        assert_eq!(after.len(), folders.len());
        assert!(after.iter().all(|folder| folder.available));
        assert_eq!(f.db.connected_folder(&nested.id).unwrap().parent_id.as_deref(), Some(child.id.as_str()));
        assert_eq!(f.db.connected_folder(&leaf.id).unwrap().parent_id.as_deref(), Some(nested.id.as_str()));
        for (folder_id, before) in &originals {
            let entries = f.entries(folder_id);
            assert_eq!(entries.len(), before.len());
            for entry in before {
                let current = entries.iter().find(|value| value.id == entry.id).unwrap();
                assert_eq!(current.asset_id, entry.asset_id);
                assert_eq!(current.path, entry.path);
                assert!(current.available);
                assert!(Path::new(&current.path).is_file());
            }
            let conn = f.db.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT project_id FROM connected_folder_projects WHERE folder_id=?1 ORDER BY project_id").unwrap();
            let projects = stmt.query_map([folder_id], |r| r.get::<_, String>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            assert_eq!(projects, ["new-project", "old-project"]);
        }
    }
}
#[test]
fn refresh_repairs_only_equal_paths_and_keeps_offline_collections() {
    let f = Fixture::new();
    for path in ["first/same", "second/same"] {
        fs::create_dir_all(f.source.join(path)).unwrap();
        fs::copy(f.source.join("one.png"), f.source.join(path).join("item.png")).unwrap();
    }
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let affected = folders.iter().find(|v| v.path == string(&f.source.join("first/same"))).unwrap();
    let other = folders.iter().find(|v| v.path == string(&f.source.join("second/same"))).unwrap();
    let original = f.entries(&affected.id).pop().unwrap();
    f.duplicate_folder_path(affected, "duplicate-offline");
    fs::rename(&f.source, f.source.with_file_name("offline")).unwrap();

    for _ in 0..2 {
        assert!(f.db.scan_connection(&f.paths, &root).is_err());
        let after = f.db.connection_folders(None, None).unwrap();
        assert_eq!(after.len(), folders.len());
        assert_eq!(after.iter().filter(|v| v.name == "same").count(), 2);
        assert_eq!(f.db.connected_folder(&affected.id).unwrap().path, affected.path);
        assert_eq!(f.db.connected_folder(&other.id).unwrap().path, other.path);
        assert!(after.iter().all(|folder| !folder.available));
        assert_eq!(f.entries(&affected.id)[0].id, original.id);
        assert_eq!(f.entries(&affected.id)[0].asset_id, original.asset_id);
        assert!(!f.entries(&affected.id)[0].available);
    }
}
#[test]
fn duplicate_path_repair_failure_rolls_back_all_relationships() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/leaf")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/item.png")).unwrap();
    let root = f.connect(&f.source);
    let folders = f.db.connection_folders(None, None).unwrap();
    let child = folders.iter().find(|v| v.name == "child").unwrap();
    let leaf = folders.iter().find(|v| v.name == "leaf").unwrap();
    let entry = f.entries(&child.id).pop().unwrap();
    f.db.create_project("repair-project", "project", "project", "project", "project").unwrap();
    f.duplicate_folder_path(child, "duplicate-rollback");
    {
        let conn = f.db.conn.lock().unwrap();
        conn.execute("UPDATE connected_entries SET folder_id='duplicate-rollback' WHERE id=?1", [&entry.id]).unwrap();
        conn.execute("UPDATE connected_folders SET parent_id='duplicate-rollback' WHERE id=?1", [&leaf.id]).unwrap();
        conn.execute("INSERT INTO connected_folder_projects(folder_id,project_id) VALUES('duplicate-rollback','repair-project')", []).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_repair BEFORE UPDATE OF path ON connected_folders BEGIN SELECT RAISE(ABORT,'test repair failure'); END;").unwrap();
    }
    assert!(f.db.scan_connection(&f.paths, &root).is_err());
    assert_eq!(f.db.connection_folders(None, None).unwrap().len(), folders.len() + 1);
    assert_eq!(f.db.connected_folder(&child.id).unwrap().path, string(&Path::new(&child.path).join("")));
    assert_eq!(f.db.connected_folder("duplicate-rollback").unwrap().path, child.path);
    assert_eq!(f.db.connected_folder(&leaf.id).unwrap().parent_id.as_deref(), Some("duplicate-rollback"));
    assert!(f.entries(&child.id).is_empty());
    assert_eq!(f.entries("duplicate-rollback")[0].id, entry.id);
    let conn = f.db.conn.lock().unwrap();
    let project_folder: String = conn.query_row("SELECT folder_id FROM connected_folder_projects WHERE project_id='repair-project'", [], |r| r.get(0)).unwrap();
    assert_eq!(project_folder, "duplicate-rollback");
    assert!(Path::new(&entry.path).is_file());
}
#[test]
fn project_covers_follow_detach_and_recycle_across_shared_projects() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let ids = vec![entry.asset_id.clone()];
    for project in ["first", "second"] {
        f.db.create_project(project, project, project, project, "blank").unwrap();
        f.db.add_assets_to_project(project, &ids).unwrap();
    }
    let cached = f.paths.thumbnails.join("retained-cover.jpg");
    fs::write(&cached, b"cached thumbnail").unwrap();
    f.db.conn.lock().unwrap().execute("UPDATE assets SET thumb_path=?2 WHERE id=?1", params![entry.asset_id, string(&cached)]).unwrap();
    assert_eq!(f.db.project_covers().unwrap()["first"].paths, vec![string(&cached)]);
    f.db.remove_assets_from_project("first", &ids).unwrap();
    let covers = f.db.project_covers().unwrap();
    assert!(!covers.contains_key("first"));
    assert_eq!(covers["second"].paths, vec![string(&cached)]);
    assert_eq!(covers["second"].asset_count, 1);
    let preview = f.db.preview_asset_originals(&ids).unwrap();
    f.db.trash_asset_original_with(&preview[0], |path| {
        fs::rename(path, f._temp.path().join("recycled.png"))?;
        Ok(())
    }).unwrap();
    assert!(f.db.project_covers().unwrap().is_empty());
    assert!(cached.is_file());
}

#[test]
fn deleted_original_keeps_creative_record_and_other_references_are_missing() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id.clone()], &target)
        .unwrap();
    let recycle = f._temp.path().join("one-recycled.png");
    f.db.trash_entries_with(&[original.id], |path| {
        fs::rename(path, &recycle)?;
        Ok(())
    })
    .unwrap();
    assert!(f.db.get_asset(&original.asset_id).unwrap().is_some());
    assert!(!f.entries(&target)[0].available);
}
#[test]
fn foreign_reference_is_verified_and_resolves_relative_location() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let original = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[original.asset_id], &target)
        .unwrap();
    let entry = f.entries(&target).pop().unwrap();
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    let root = db.connect_directory(&f.target, None).unwrap();
    db.scan_connection(&f.paths, &root).unwrap();
    let ids = db.every_entry_id(Some(&root)).unwrap();
    let entries = db.resolve_connection_entries(&ids).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].is_reference);
    assert!(entries[0].available);
    assert_eq!(entries[0].asset_id, entry.asset_id);
    let mut data = load_reference(Path::new(&entry.path)).unwrap();
    data.sha256 = "0".repeat(64);
    super::super::file_workspace::write_json(Path::new(&entry.path), &data).unwrap();
    let other = Database::open_in_memory().unwrap();
    other.migrate().unwrap();
    let root = other.connect_directory(&f.target, None).unwrap();
    assert!(other.scan_connection(&f.paths, &root).is_err());
    assert!(other.every_entry_id(Some(&root)).unwrap().is_empty());
}

#[test]
fn reconnecting_to_projects_associates_cached_and_new_entries() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    for project in ["first", "second"] {
        f.db.create_project(project, project, project, project, "project")
            .unwrap();
        assert_eq!(
            f.db.connect_directory(&f.source, Some(project)).unwrap(),
            root
        );
        assert_eq!(
            f.db.connection_entry_ids(Some(&root), Some(project), None, 0, 10)
                .unwrap()
                .len(),
            1
        );
    }
    fs::copy(f.source.join("one.png"), f.source.join("new.png")).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    for project in ["first", "second"] {
        assert_eq!(
            f.db.connection_entry_ids(Some(&root), Some(project), None, 0, 10)
                .unwrap()
                .len(),
            2
        );
    }
}
#[test]
fn missing_child_marks_all_descendants_offline_without_forgetting_entries() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child/grandchild")).unwrap();
    fs::copy(
        f.source.join("one.png"),
        f.source.join("child/grandchild/two.png"),
    )
    .unwrap();
    let root = f.connect(&f.source);
    let nested =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "grandchild")
            .unwrap();
    fs::rename(f.source.join("child"), f._temp.path().join("offline-child")).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert!(!f.db.connected_folder(&nested.id).unwrap().available);
    assert_eq!(f.entries(&nested.id).len(), 1);
    assert!(!f.entries(&nested.id)[0].available);
}
#[test]
fn moving_a_root_under_another_root_preserves_every_descendant() {
    let f = Fixture::new();
    fs::create_dir_all(f.source.join("child")).unwrap();
    fs::copy(f.source.join("one.png"), f.source.join("child/two.png")).unwrap();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let child =
        f.db.connection_folders(None, None)
            .unwrap()
            .into_iter()
            .find(|v| v.name == "child")
            .unwrap();
    let before = f.entries(&child.id).pop().unwrap();
    f.db.move_connected_directory(&root, &target).unwrap();
    assert_eq!(f.db.connected_root_ids().unwrap(), vec![target.clone()]);
    assert_eq!(
        f.db.connected_folder(&root).unwrap().parent_id,
        Some(target.clone())
    );
    assert_eq!(f.entries(&child.id)[0].id, before.id);
    assert!(f.entries(&child.id)[0].available);
    assert!(f.target.join("source/child/two.png").exists());
    for _ in 0..2 {
        f.db.scan_connection(&f.paths, &target).unwrap();
        assert_eq!(f.db.connection_folders(None, None).unwrap().len(), 3);
        assert!(f.db.connected_folder(&root).unwrap().available);
        assert_eq!(f.entries(&child.id)[0].id, before.id);
        assert_eq!(f.entries(&child.id)[0].asset_id, before.asset_id);
        assert!(f.entries(&child.id)[0].available);
    }
}
#[test]
fn directory_database_failure_rolls_back_the_disk_rename_and_all_paths() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let original = f.entries(&root).pop().unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_folder_update BEFORE UPDATE OF path ON connected_folders BEGIN SELECT RAISE(ABORT,'test injected failure'); END;").unwrap();
    assert!(f.db.rename_connected_directory(&root, "renamed").is_err());
    assert!(f.source.join("one.png").exists());
    assert!(!f.source.with_file_name("renamed").exists());
    assert_eq!(f.entries(&root)[0].path, original.path);
    assert_eq!(
        f.entries(&root)[0].asset.store_path,
        original.asset.store_path
    );
}
#[test]
fn cross_volume_copy_checks_bytes_before_committing_and_deleting_source() {
    let f = Fixture::new();
    let original = f.source.join("one.png");
    let target = f.target.join("moved.png");
    let expected = fs::read(&original).unwrap();
    copy_move_with(&original, &target, || {
        assert_eq!(fs::read(&target).unwrap(), expected);
        assert!(original.exists());
        Ok(())
    })
    .unwrap();
    assert!(!original.exists());
    assert_eq!(fs::read(&target).unwrap(), expected);
}
#[test]
fn cross_volume_conflict_and_database_failure_keep_the_complete_source() {
    let f = Fixture::new();
    let original = f.source.join("one.png");
    let target = f.target.join("existing.png");
    fs::write(&target, b"existing").unwrap();
    assert!(copy_move_with(&original, &target, || panic!("must not commit a collision")).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"existing");
    assert!(original.exists());
    let next = f.target.join("next.png");
    assert!(copy_move_with(&original, &next, || Err(invalid(
        "injected database failure"
    )))
    .is_err());
    assert_eq!(fs::read(&next).unwrap(), fs::read(&original).unwrap());
}
#[test]
fn cross_volume_cleanup_refuses_changed_source_and_keeps_verified_destination() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let source = PathBuf::from(&entry.path);
    let destination = f.target.join("moved.png");
    let expected = fs::read(&source).unwrap();
    let result = copy_move_with(&source, &destination, || {
        f.db.repoint_asset(&entry.asset_id, &source, &destination)?;
        fs::write(&source, b"new contents")?;
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&destination).unwrap(), expected);
    assert_eq!(fs::read(&source).unwrap(), b"new contents");
    assert_eq!(
        f.db.get_asset(&entry.asset_id).unwrap().unwrap().store_path,
        Some(string(&destination))
    );
}
#[test]
fn cross_volume_new_files_block_directory_cleanup_without_losing_the_copy() {
    let f = Fixture::new();
    let destination = f.target.join("source");
    let expected = fs::read(f.source.join("one.png")).unwrap();
    let result = copy_move_with(&f.source, &destination, || {
        fs::write(f.source.join("arrived-later.txt"), b"retain me")?;
        Ok(())
    });
    assert!(result.is_err());
    assert!(f.source.join("arrived-later.txt").exists());
    assert_eq!(fs::read(destination.join("one.png")).unwrap(), expected);
}
#[test]
fn failed_recycle_retains_original_entry_and_all_creative_identity() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    assert!(f
        .db
        .trash_entries_with(&[entry.id.clone()], |_| Err(invalid("recycle unavailable")))
        .is_err());
    assert!(Path::new(&entry.path).exists());
    assert_eq!(f.entries(&root)[0].id, entry.id);
    assert!(f.db.get_asset(&entry.asset_id).unwrap().is_some());
}

#[test]
fn cross_volume_changed_destination_never_causes_source_deletion() {
    let f = Fixture::new();
    let source = f.source.join("one.png");
    let destination = f.target.join("moved.png");
    let expected = fs::read(&source).unwrap();
    assert!(copy_move_with(&source, &destination, || {
        fs::write(&destination, b"changed target")?;
        Ok(())
    })
    .is_err());
    assert_eq!(fs::read(&source).unwrap(), expected);
}
#[test]
fn reference_cannot_reassign_a_missing_known_original_to_different_bytes() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let asset = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[asset.asset_id.clone()], &target)
        .unwrap();
    let reference = f.entries(&target).pop().unwrap();
    fs::rename(&asset.path, f._temp.path().join("offline.png")).unwrap();
    let replacement = f.target.join("other.png");
    image::RgbImage::from_pixel(8, 8, image::Rgb([90, 60, 30]))
        .save(&replacement)
        .unwrap();
    let mut data = load_reference(Path::new(&reference.path)).unwrap();
    data.target_relative = Some("other.png".into());
    data.target_path = string(&replacement);
    data.sha256 = external_files::fingerprint(&replacement).unwrap();
    super::super::file_workspace::write_json(Path::new(&reference.path), &data).unwrap();
    assert!(f.db.scan_connection(&f.paths, &target).is_err());
    assert_eq!(
        f.db.get_asset(&asset.asset_id).unwrap().unwrap().store_path,
        asset.asset.store_path
    );
    assert!(f
        .entries(&target)
        .iter()
        .any(|e| e.id == reference.id && !e.available));
}

#[test]
fn connected_assets_reject_legacy_and_raw_deletion_without_losing_records() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    f.db.conn.lock().unwrap().execute("INSERT INTO analyses(id,asset_id,kind,payload,provider,created_at) VALUES('analysis',?1,'caption','{}','test',0)",[&entry.asset_id]).unwrap();
    assert!(f.db.has_connected_asset(&entry.asset_id).unwrap());
    assert!(f.db.delete_asset(&entry.asset_id).is_err());
    assert!(f
        .db
        .conn
        .lock()
        .unwrap()
        .execute("DELETE FROM assets WHERE id=?1", [&entry.asset_id])
        .is_err());
    assert!(Path::new(&entry.path).is_file());
    assert_eq!(f.entries(&root)[0].asset_id, entry.asset_id);
    let count: i64 =
        f.db.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM analyses WHERE asset_id=?1",
                [&entry.asset_id],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(count, 1);
}
#[test]
fn shared_detail_rename_updates_connected_original_and_reference_identity() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let target = f.connect(&f.target);
    let entry = f.entries(&root).pop().unwrap();
    f.db.create_material_references(&f.paths, &[entry.asset_id.clone()], &target)
        .unwrap();
    assert!(f
        .db
        .rename_connected_asset_if_present(&entry.asset_id, "named.v2")
        .unwrap());
    assert!(f.source.join("named.v2.png").exists());
    assert_eq!(f.entries(&root)[0].id, entry.id);
    let reference = f.entries(&target).pop().unwrap();
    assert_eq!(reference.asset_id, entry.asset_id);
    assert!(load_reference(Path::new(&reference.path))
        .unwrap()
        .target_path
        .ends_with("named.v2.png"));
}

#[test]
fn foreign_reference_rejects_unsafe_asset_identifiers_before_indexing() {
    let f = Fixture::new();
    let root = f.db.connect_directory(&f.target, None).unwrap();
    let original = f.source.join("one.png");
    let path = f.target.join("unsafe.bowerbird");
    let mut data = MaterialReference {
        version: 1,
        kind: "bowerbird-reference".into(),
        asset_id: String::new(),
        target_relative: relative(&f.target, &original),
        target_path: string(&original),
        sha256: external_files::fingerprint(&original).unwrap(),
    };
    for malicious in [
        "../escape".to_owned(),
        "..\\escape".to_owned(),
        "bad\nidentifier".to_owned(),
        "bad\0identifier".to_owned(),
        "非ASCII".to_owned(),
        "a".repeat(129),
    ] {
        data.asset_id = malicious.clone();
        super::super::file_workspace::write_json(&path, &data).unwrap();
        assert!(load_reference(&path).is_err());
        assert!(f.db.scan_connection(&f.paths, &root).is_err());
        assert!(f.db.get_asset(&malicious).unwrap().is_none());
        assert!(f.entries(&root).is_empty());
    }
    assert!(original.is_file());
    data.asset_id = "safe_ID-0123".into();
    super::super::file_workspace::write_json(&path, &data).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert_eq!(f.entries(&root)[0].asset_id, data.asset_id);
}

#[test]
fn refresh_preserves_project_removal_until_explicit_reconnect() {
    let f = Fixture::new();
    let project = "connected-project";
    f.db.create_project(project, project, project, project, "project")
        .unwrap();
    let root = f.db.connect_directory(&f.source, Some(project)).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    let original = f.entries(&root).pop().unwrap();
    let project_entries = || {
        f.db.connection_entry_ids(Some(&root), Some(project), None, 0, 10)
            .unwrap()
    };
    assert_eq!(project_entries(), vec![original.id.clone()]);

    f.db.delete_asset_with_mode(
        &original.asset_id,
        super::super::projects::AssetDeleteMode::Keep,
        Some(project),
    )
    .unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert!(project_entries().is_empty());

    // A metadata change also takes the slow path without undoing the user's project choice.
    fs::OpenOptions::new()
        .write(true)
        .open(&original.path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60))
        .unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert!(project_entries().is_empty());

    fs::copy(&original.path, f.source.join("new.png")).unwrap();
    f.db.scan_connection(&f.paths, &root).unwrap();
    let added = project_entries();
    assert_eq!(added.len(), 1);
    assert_ne!(added[0], original.id);
    assert!(Path::new(&original.path).is_file());

    assert_eq!(
        f.db.connect_directory(&f.source, Some(project)).unwrap(),
        root
    );
    assert_eq!(project_entries().len(), 2);
    assert!(project_entries().contains(&original.id));
}
#[test]
fn disconnect_hides_global_catalog_but_keeps_original_identity_and_project_membership() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let bytes = fs::read(&entry.path).unwrap();
    f.db.create_project("kept-project", "project", f.source.to_str().unwrap(), "project", "user").unwrap();
    f.db.add_assets_to_project("kept-project", &[entry.asset_id.clone()]).unwrap();
    f.db.disconnect_directory(&f.paths, &root).unwrap();
    assert!(f.db.material_catalog_assets("tags", None, None).unwrap().is_empty(), "disconnected source must leave global catalog");
    assert_eq!(f.db.material_catalog_assets("tags", None, Some("kept-project")).unwrap().len(), 1, "explicit project membership remains available there");
    assert!(f.db.list_assets(None, None, 100, 0).unwrap().is_empty());
    assert_eq!(f.db.list_assets(None, Some("kept-project"), 100, 0).unwrap().len(), 1);
    f.db.conn.lock().unwrap().execute("UPDATE assets SET library_hidden=0 WHERE id=?1", [&entry.asset_id]).unwrap();
    assert!(f.db.material_catalog_assets("tags", None, None).unwrap().is_empty(), "last canvas removal must not revive global membership");
    assert_eq!(f.db.get_asset(&entry.asset_id).unwrap().unwrap().store_path.as_deref(), Some(entry.path.as_str()));
    assert_eq!(fs::read(&entry.path).unwrap(), bytes);
    let reconnected = f.connect(&f.source);
    assert_eq!(f.entries(&reconnected)[0].asset_id, entry.asset_id);
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
}

#[test]
fn disconnect_preserves_other_connections_and_explicitly_collected_originals() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let target = f.connect(&f.target);
    f.db.create_material_references(&f.paths, &[entry.asset_id.clone()], &target).unwrap();
    f.db.disconnect_directory(&f.paths, &root).unwrap();
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
    f.db.link_external_to_library(&entry.asset_id).unwrap();
    f.db.disconnect_directory(&f.paths, &target).unwrap();
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1, "independent collection remains after last directory disconnects");
}

#[test]
fn disconnect_filters_all_catalog_reads_and_retains_metadata_until_reconnected() {
    use crate::core::catalog_browser::CatalogFilter;
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let tag = f.db.get_or_create_tag("disconnect-tag", "manual").unwrap();
    f.db.set_asset_tags(&entry.asset_id, &[tag.clone()], "manual").unwrap();
    f.db.conn.lock().unwrap().execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('disconnect-analysis',?1,'caption','kept caption')", [&entry.asset_id]).unwrap();
    let filter = CatalogFilter { kind: "tags".into(), media: "images".into(), ..Default::default() };
    assert_eq!(f.db.catalog_page(&filter, 0, 50).unwrap().len(), 1);
    assert_eq!(f.db.search_assets("one", None, 10).unwrap().len(), 1);
    f.db.disconnect_directory(&f.paths, &root).unwrap();
    assert_eq!(f.db.catalog_overview(&filter, None).unwrap().total, 0);
    assert!(f.db.catalog_page(&filter, 0, 50).unwrap().is_empty());
    assert!(f.db.catalog_ids(&filter, 0, 50).unwrap().is_empty());
    assert!(f.db.catalog_graph_page(&filter, None, 50).unwrap().assets.is_empty());
    assert_eq!(f.db.count_assets(None).unwrap(), 0);
    assert!(f.db.search_assets("one", None, 10).unwrap().is_empty());
    for query in ["tag:disconnect-tag", "source:!generated", "ext:png"] {
        assert!(f.db.list_assets_smart(query, None, 50, 0).unwrap().is_empty(), "{query}");
    }
    assert!(f.db.palette_overview(None).unwrap().is_empty());
    assert_eq!(f.db.list_tags_with_count("all", None).unwrap().iter().find(|t| t.id == tag).unwrap().count, 0);
    assert_eq!(f.db.list_asset_tags(&entry.asset_id).unwrap().len(), 1);
    let caption: String = f.db.conn.lock().unwrap().query_row("SELECT payload FROM analyses WHERE id='disconnect-analysis'", [], |r| r.get(0)).unwrap();
    assert_eq!(caption, "kept caption");
    // Reading an original for an existing canvas must not silently collect it again.
    f.db.index_external(&f.paths, Path::new(&entry.path)).unwrap();
    assert!(f.db.catalog_page(&filter, 0, 50).unwrap().is_empty());
    f.db.link_external_to_library(&entry.asset_id).unwrap();
    assert_eq!(f.db.catalog_page(&filter, 0, 50).unwrap().len(), 1);
    let root = f.connect(&f.source);
    f.db.disconnect_directory(&f.paths, &root).unwrap();
    assert_eq!(f.db.catalog_page(&filter, 0, 50).unwrap().len(), 1, "explicitly collected identity keeps its membership");
}

#[test]
fn disconnect_visibility_and_directory_removal_commit_together() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    f.db.conn.lock().unwrap().execute_batch("CREATE TEMP TRIGGER fail_disconnect BEFORE INSERT ON disconnected_library_assets BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
    assert!(f.db.disconnect_directory(&f.paths, &root).is_err());
    assert_eq!(f.entries(&root).len(), 1);
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
    assert!(f.source.join("one.png").is_file());
}

#[test]
fn disconnect_visibility_migration_0051_preserves_v50_records_and_independent_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("migration.db");
    let db = Database::open(&path).unwrap();
    crate::db::migrations::migrations().to_version(&mut db.conn.lock().unwrap(), 50).unwrap();
    db.conn.lock().unwrap().execute_batch(
        "INSERT INTO assets(id,name,ext,source,store_path,library_hidden,name_manual) VALUES('connected','手动命名','png','external','original.png',0,1),('independent','独立素材','png','external','other.png',0,0);
         INSERT INTO external_assets(asset_id,fingerprint,library_member) VALUES('connected','hash-1',1),('independent','hash-2',1);
         INSERT INTO connected_roots(id,path) VALUES('root','folder');
         INSERT INTO connected_folders(id,root_id,path,name) VALUES('root','root','folder','folder');
         INSERT INTO connected_entries(id,folder_id,asset_id,path,name,is_reference) VALUES('entry','root','connected','original.png','original.png',0);
         INSERT INTO tags(id,name) VALUES('tag','保留标签');
         INSERT INTO asset_tags(asset_id,tag_id) VALUES('connected','tag');
         INSERT INTO analyses(id,asset_id,kind,payload) VALUES('analysis','connected','caption','retained');"
    ).unwrap();
    let before = serde_json::to_value(db.get_asset("connected").unwrap()).unwrap();
    db.migrate().unwrap();
    db.disconnect_directory(&LibraryPaths::init(temp.path().join("data")).unwrap(), "root").unwrap();
    drop(db);
    for _ in 0..2 {
        let db = Database::open(&path).unwrap();
        db.migrate().unwrap();
        assert_eq!(serde_json::to_value(db.get_asset("connected").unwrap()).unwrap(), before);
        let catalog = db.material_catalog_assets("tags", None, None).unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].id, "independent");
        assert_eq!(db.list_asset_tags("connected").unwrap().len(), 1);
        let conn = db.conn.lock().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM independent_library_assets", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "upgrade must not infer independent membership for connected assets");
        let payload: String = conn.query_row("SELECT payload FROM analyses WHERE id='analysis'", [], |r| r.get(0)).unwrap();
        assert_eq!(payload, "retained");
    }
}

#[test]
fn disconnect_visibility_survives_last_canvas_instance_removal() {
    use crate::core::{creative_session_contract::{CreativeNodeKind, CreativeNodeRole}, project_canvas::NewCanvasNode};
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    f.db.create_project("canvas-project", "project", "blank:project", "project", "blank").unwrap();
    f.db.ensure_project_canvas("canvas-project").unwrap();
    f.db.create_canvas_node(&NewCanvasNode {
        id: "kept-node".into(), project_id: "canvas-project".into(), thread_id: None,
        kind: CreativeNodeKind::Asset, asset_id: Some(entry.asset_id.clone()), role: Some(CreativeNodeRole::Reference),
        payload_json: r#"{"schema_version":1,"snapshot":{"name":"one"}}"#.into(),
        x: 10., y: 20., width: 100., height: 80., z_index: 1, position_locked: false,
    }).unwrap();
    let nodes = serde_json::to_value(f.db.list_canvas_nodes("canvas-project").unwrap()).unwrap();
    f.db.disconnect_directory(&f.paths, &root).unwrap();
    assert_eq!(serde_json::to_value(f.db.list_canvas_nodes("canvas-project").unwrap()).unwrap(), nodes);
    assert!(f.db.material_catalog_assets("tags", None, None).unwrap().is_empty(), "canvas references are not global membership");
    f.db.remove_canvas_node("kept-node").unwrap();
    assert!(f.db.material_catalog_assets("tags", None, None).unwrap().is_empty());
    assert!(f.db.list_assets(None, None, 10, 0).unwrap().is_empty());
    assert!(Path::new(&entry.path).is_file());
}

#[test]
fn disconnect_keeps_existing_workspace_inbox_original_without_independent_marker() {
    use crate::core::file_workspace::FileWorkspace;
    use std::sync::Arc;
    let mut f = Fixture::new();
    let workspace = f._temp.path().join("BowerbirdLibrary");
    f.paths.files = Some(Arc::new(FileWorkspace::open(f._temp.path().join("files.json"), workspace.clone()).unwrap()));
    f.paths.files.as_ref().unwrap().ensure_root().unwrap();
    let inbox = workspace.join("收集箱");
    fs::create_dir_all(&inbox).unwrap();
    fs::copy(f.source.join("one.png"), inbox.join("kept.png")).unwrap();
    let root = f.connect(&inbox);
    let entry = f.entries(&root).pop().unwrap();
    assert!(f.db.is_external_asset(&entry.asset_id).unwrap(), "managed folder scans still use external indexing");
    let independent: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM independent_library_assets WHERE asset_id=?1", [&entry.asset_id], |r| r.get(0)).unwrap();
    assert_eq!(independent, 0, "legacy workspace original has no explicit collection fact");
    f.db.disconnect_directory(&f.paths, &root).unwrap();
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
    assert!(Path::new(&entry.path).is_file());
}

#[test]
fn missing_original_cleanup_preserves_identity_metadata_cache_and_project_membership() {
    use crate::core::catalog_browser::CatalogFilter;
    use crate::core::canvas_frequent_assets::CanvasFrequentAssetsPreferences;
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let cached = f.paths.thumbnails.join("retained.jpg");
    fs::write(&cached, b"cached preview").unwrap();
    f.db.conn.lock().unwrap().execute("UPDATE assets SET thumb_path=?2 WHERE id=?1", params![entry.asset_id, string(&cached)]).unwrap();
    let tag = f.db.get_or_create_tag("kept missing tag", "manual").unwrap();
    f.db.set_asset_tags(&entry.asset_id, &[tag], "manual").unwrap();
    f.db.create_project("missing-project", "project", "blank:missing", "project", "blank").unwrap();
    f.db.add_assets_to_project("missing-project", &[entry.asset_id.clone()]).unwrap();
    f.db.conn.lock().unwrap().execute("UPDATE assets SET generation_session_id='missing-session' WHERE id=?1", [&entry.asset_id]).unwrap();
    let pins = CanvasFrequentAssetsPreferences { pinned_asset_ids: vec![entry.asset_id.clone()], ..Default::default() };
    assert_eq!(f.db.list_generation_group(&entry.asset_id, None).unwrap().len(), 1);
    assert_eq!(f.db.canvas_frequent_assets(&pins, None).unwrap().pinned.len(), 1);
    let before = serde_json::to_value(f.db.get_asset(&entry.asset_id).unwrap()).unwrap();
    let moved = f.target.join("moved.png");
    fs::rename(&entry.path, &moved).unwrap();
    let preview = f.db.preview_asset_originals(&[entry.asset_id.clone()]).unwrap();
    assert_eq!(serde_json::to_value(&preview[0]).unwrap()["missing"], true);
    assert_eq!(preview[0].path, entry.path);
    f.db.trash_asset_original_with(&preview[0], |_| panic!("missing original must never invoke recycling")).unwrap();
    assert_eq!(serde_json::to_value(f.db.get_asset(&entry.asset_id).unwrap()).unwrap(), before);
    assert!(f.db.material_catalog_assets("tags", None, None).unwrap().is_empty());
    assert!(f.db.list_assets(None, None, 50, 0).unwrap().is_empty());
    assert!(f.db.list_generation_group(&entry.asset_id, None).unwrap().is_empty());
    assert!(f.db.list_generation_group(&entry.asset_id, Some("missing-project")).unwrap().is_empty());
    assert!(f.db.canvas_frequent_assets(&pins, None).unwrap().pinned.is_empty());
    assert_eq!(f.db.get_assets_by_ids(&[entry.asset_id.clone()]).unwrap().len(), 1);
    assert!(!f.db.project_covers().unwrap().contains_key("missing-project"));
    let filter = CatalogFilter { kind: "all".into(), media: "images".into(), ..Default::default() };
    assert_eq!(f.db.catalog_overview(&filter, None).unwrap().total, 0);
    assert!(f.db.catalog_page(&filter, 0, 50).unwrap().is_empty());
    assert!(f.db.material_catalog_assets("tags", None, Some("missing-project")).unwrap().is_empty());
    assert!(f.db.list_assets(None, Some("missing-project"), 50, 0).unwrap().is_empty());
    let project_filter = CatalogFilter { project_id: Some("missing-project".into()), ..filter.clone() };
    let overview = f.db.catalog_overview(&project_filter, Some("missing-project")).unwrap();
    assert_eq!(overview.total, 0);
    assert!(overview.catalog.tags.iter().all(|tag| tag.count == 0 && tag.project_count == 0));
    assert!(f.db.material_catalog(Some("missing-project")).unwrap().tags.iter().all(|tag| tag.count == 0 && tag.project_count == 0));
    let member: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='missing-project' AND asset_id=?1", [&entry.asset_id], |r| r.get(0)).unwrap();
    assert_eq!(member, 1);
    assert_eq!(f.db.list_asset_tags(&entry.asset_id).unwrap().len(), 1);
    assert_eq!(fs::read(&cached).unwrap(), b"cached preview");
    assert!(moved.is_file());
    let recycled: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM trashed_asset_originals WHERE asset_id=?1", [&entry.asset_id], |r| r.get(0)).unwrap();
    assert_eq!(recycled, 0, "cleaned missing original is not a recycled file");
    f.db.link_external_to_library(&entry.asset_id).unwrap();
    assert!(f.db.material_catalog_assets("tags", None, None).unwrap().is_empty(), "membership alone cannot verify a returned original");
    fs::rename(&moved, &entry.path).unwrap();
    let restored = f.db.index_connected_file(&f.paths, Path::new(&entry.path), None).unwrap();
    assert_eq!(restored.id, entry.asset_id);
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
}

#[test]
fn missing_original_cleanup_rechecks_recovery_and_registered_path_before_hiding() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let moved = f.target.join("moved.png");
    fs::rename(&entry.path, &moved).unwrap();
    let preview = f.db.preview_asset_originals(&[entry.asset_id.clone()]).unwrap();
    fs::rename(&moved, &entry.path).unwrap();
    assert!(f.db.trash_asset_original_with(&preview[0], |_| panic!("recovered original requires a new confirmation")).is_err());
    assert!(Path::new(&entry.path).is_file());
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
    fs::rename(&entry.path, &moved).unwrap();
    f.db.conn.lock().unwrap().execute("UPDATE assets SET store_path=?2 WHERE id=?1", params![entry.asset_id, string(&f.target.join("another-missing.png"))]).unwrap();
    assert!(f.db.trash_asset_original_with(&preview[0], |_| panic!("changed original requires a new confirmation")).is_err());
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
}

#[test]
fn folder_display_hides_only_cleaned_references_and_restores_only_matching_originals() {
    fn assert_display(db: &Database, folder: &str, reference: &str, visible: bool) {
        let expected: Vec<String> = if visible { vec![reference.to_owned()] } else { Vec::new() };
        for grouped in [false, true] {
            let filter = ConnectionFilter { grouped, ..Default::default() };
            let rows = db.connection_folders_filtered(None, Some("images"), &filter).unwrap();
            assert_eq!(rows.iter().find(|row| row.id == folder).unwrap().count, i64::from(visible));
            assert_eq!(db.connection_entry_ids_filtered(Some(folder), None, Some("images"), 0, 60, &filter).unwrap(), expected);
            let all = db.connection_entry_ids_filtered(None, None, None, 0, 2000, &filter).unwrap();
            assert_eq!(all.iter().any(|id| id == reference), visible);
        }
        assert_eq!(db.connected_folder(folder).unwrap().count, i64::from(visible));
        let stale = vec![reference.to_owned()];
        assert_eq!(db.visible_connection_entries(&stale).unwrap().len(), expected.len());
        assert_eq!(db.resolve_visible_connection_entries(&stale).unwrap().len(), expected.len());
        assert_eq!(db.every_entry_id(Some(folder)).unwrap(), stale);
        assert_eq!(db.read_connection_entries(&stale).unwrap().len(), 1);
    }
    for (trashed, cleaned) in [(false,false), (true,false), (false,true), (true,true)] {
        let mut f = Fixture::new();
        f.db = Database::open(&f.paths.db).unwrap();
        f.db.migrate().unwrap();
        let source = f.connect(&f.source);
        let asset = f.entries(&source).pop().unwrap();
        let folder = f.connect(&f.target);
        let ids = vec![asset.asset_id.clone()];
        f.db.create_project("audit", "audit", "blank:audit", "blank:audit", "blank").unwrap();
        f.db.add_assets_to_project("audit", &ids).unwrap();
        f.db.create_material_references(&f.paths, &ids, &folder).unwrap();
        let reference = f.entries(&folder).pop().unwrap();
        let moved = f._temp.path().join("retained.png");
        if trashed {
            let present = f.db.preview_asset_originals(&ids).unwrap();
            f.db.trash_asset_original_with(&present[0], |path| { fs::rename(path,&moved)?; Ok(()) }).unwrap();
        } else {
            fs::rename(&asset.path, &moved).unwrap();
        }
        if cleaned {
            let missing = f.db.preview_asset_originals(&ids).unwrap();
            f.db.cleanup_missing_original(&missing[0]).unwrap();
        }
        assert_display(&f.db, &folder, &reference.id, !cleaned);
        let drawer = external_files::references(&f.db, "audit").unwrap();
        assert_eq!(drawer.len(), usize::from(!cleaned));
        if !cleaned { assert_eq!(drawer[0].status, "missing"); }
        // Unplugging the folder only changes availability. Its index is still browsable.
        f.db.conn.lock().unwrap().execute("UPDATE connected_roots SET available=0 WHERE id=?1", [&folder]).unwrap();
        assert_display(&f.db, &folder, &reference.id, !cleaned);
        f.db = Database::open(&f.paths.db).unwrap();
        assert_display(&f.db, &folder, &reference.id, !cleaned);
        f.db.conn.lock().unwrap().execute("UPDATE connected_roots SET available=1 WHERE id=?1", [&folder]).unwrap();
        let scan = f.db.scan_connection(&f.paths, &folder);
        if cleaned { scan.unwrap(); }
        assert_display(&f.db, &folder, &reference.id, !cleaned);
        assert!(Path::new(&reference.path).is_file());
        if cleaned {
            image::RgbImage::from_pixel(8, 8, image::Rgb([80u8, 60, 40])).save(&asset.path).unwrap();
            assert!(f.db.scan_connection(&f.paths, &folder).is_err());
            assert!(f.db.scan_connection(&f.paths, &source).is_err());
            assert_display(&f.db, &folder, &reference.id, false);
            fs::remove_file(&asset.path).unwrap();
            fs::rename(&moved, &asset.path).unwrap();
            f.db.scan_connection(&f.paths, &folder).unwrap();
            assert_display(&f.db, &folder, &reference.id, true);
            assert!(f.entries(&folder)[0].available);
            let drawer = external_files::references(&f.db,"audit").unwrap();
            assert_eq!(drawer[0].asset.id, asset.asset_id);
            assert_eq!(drawer[0].status, "available");
        }
    }
}

#[test]
fn missing_original_cleanup_matches_registered_path_duplicates_and_scan_restores_original() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let target = f.connect(&f.target);
    f.db.create_material_references(&f.paths, &[entry.asset_id.clone()], &target).unwrap();
    let reference = f.entries(&target).pop().unwrap();
    let ordinary = external_files::connection_path_spellings(Path::new(&entry.path), Path::new(&entry.path))[2].clone();
    let hash = external_files::fingerprint(Path::new(&entry.path)).unwrap();
    f.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,store_path,source) VALUES('missing-duplicate','duplicate','png',?1,'external')", [&ordinary]).unwrap();
    f.db.conn.lock().unwrap().execute("INSERT INTO external_assets(asset_id,fingerprint,library_member) VALUES('missing-duplicate',?1,1)", [&hash]).unwrap();
    let moved = f._temp.path().join("moved.png");
    fs::rename(&entry.path, &moved).unwrap();
    // Confirm through an ordinary path; its verbatim spelling must be included too.
    let preview = f.db.preview_asset_originals(&["missing-duplicate".into()]).unwrap();
    f.db.trash_asset_original_with(&preview[0], |_| panic!("missing path must not reach recycle")).unwrap();
    assert!(f.db.material_catalog_assets("tags", None, None).unwrap().is_empty());
    assert!(f.entries(&root).is_empty());
    let missing_ref = f.entries(&target).pop().unwrap();
    assert_eq!(missing_ref.id, reference.id);
    assert!(!missing_ref.available);
    assert!(Path::new(&reference.path).is_file());
    let removed: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM removed_missing_asset_originals", [], |r| r.get(0)).unwrap();
    assert_eq!(removed, 2);
    // Rename back preserves bytes/mtime. The invalidated reference stamp must force re-indexing.
    fs::rename(&moved, &entry.path).unwrap();
    f.db.scan_connection(&f.paths, &target).unwrap();
    assert!(f.entries(&target)[0].available);
    let restored: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM removed_missing_asset_originals WHERE asset_id=?1", [&entry.asset_id], |r| r.get(0)).unwrap();
    assert_eq!(restored, 0);
    f.db.scan_connection(&f.paths, &root).unwrap();
    assert_eq!(f.entries(&root)[0].asset_id, entry.asset_id);
}

#[test]
fn missing_original_cleanup_sql_failure_keeps_visibility_entries_and_cached_bytes() {
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    let cached = f.paths.thumbnails.join("kept.jpg");
    fs::write(&cached, b"preview bytes").unwrap();
    let moved = f.target.join("moved.png");
    fs::rename(&entry.path, &moved).unwrap();
    let preview = f.db.preview_asset_originals(&[entry.asset_id.clone()]).unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TEMP TRIGGER fail_missing_cleanup BEFORE INSERT ON removed_missing_asset_originals BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
    assert!(f.db.trash_asset_original_with(&preview[0], |_| panic!("no physical operation for missing originals")).is_err());
    assert_eq!(f.db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
    assert_eq!(f.entries(&root).len(), 1);
    assert_eq!(fs::read(cached).unwrap(), b"preview bytes");
    assert!(moved.is_file());
    let removed: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM removed_missing_asset_originals", [], |r| r.get(0)).unwrap();
    assert_eq!(removed, 0);
}

#[test]
fn missing_original_cleanup_migration_0052_preserves_v51_identity_and_reopens() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("migration.db");
    let db = Database::open(&path).unwrap();
    crate::db::migrations::migrations().to_version(&mut db.conn.lock().unwrap(), 51).unwrap();
    db.conn.lock().unwrap().execute_batch(
        "INSERT INTO assets(id,name,ext,source,store_path,library_hidden,name_manual) VALUES('missing','保留名称','png','external','missing-original.png',0,1);
         INSERT INTO external_assets(asset_id,fingerprint,library_member) VALUES('missing','registered-fingerprint',1);
         INSERT INTO tags(id,name) VALUES('kept-tag','保留标签');
         INSERT INTO asset_tags(asset_id,tag_id) VALUES('missing','kept-tag');
         INSERT INTO analyses(id,asset_id,kind,payload) VALUES('kept-analysis','missing','caption','retained');"
    ).unwrap();
    let before = serde_json::to_value(db.get_asset("missing").unwrap()).unwrap();
    db.migrate().unwrap();
    assert_eq!(db.material_catalog_assets("tags", None, None).unwrap().len(), 1, "migration alone cannot hide existing assets");
    let preview = db.preview_asset_originals(&["missing".into()]).unwrap();
    assert!(preview[0].missing);
    assert_eq!(preview[0].fingerprint, "registered-fingerprint");
    db.trash_asset_original_with(&preview[0], |_| panic!("missing cleanup is metadata only")).unwrap();
    drop(db);
    for _ in 0..2 {
        let db = Database::open(&path).unwrap();
        db.migrate().unwrap();
        assert_eq!(serde_json::to_value(db.get_asset("missing").unwrap()).unwrap(), before);
        assert!(db.material_catalog_assets("tags", None, None).unwrap().is_empty());
        assert_eq!(db.list_asset_tags("missing").unwrap().len(), 1);
        let conn = db.conn.lock().unwrap();
        let payload: String = conn.query_row("SELECT payload FROM analyses WHERE id='kept-analysis'", [], |r| r.get(0)).unwrap();
        assert_eq!(payload, "retained");
        let removed: i64 = conn.query_row("SELECT COUNT(*) FROM removed_missing_asset_originals WHERE asset_id='missing'", [], |r| r.get(0)).unwrap();
        assert_eq!(removed, 1);
    }
}

#[test]
fn missing_original_cleanup_hides_canvas_nodes_but_preserves_data_and_cannot_revive_on_last_node_removal() {
    use crate::core::{creative_session_contract::{CreativeNodeKind, CreativeNodeRole}, project_canvas::NewCanvasNode};
    let f = Fixture::new();
    let root = f.connect(&f.source);
    let entry = f.entries(&root).pop().unwrap();
    f.db.create_project("missing-canvas", "project", "blank:missing-canvas", "project", "blank").unwrap();
    f.db.ensure_project_canvas("missing-canvas").unwrap();
    f.db.create_canvas_node(&NewCanvasNode {
        id: "missing-node".into(), project_id: "missing-canvas".into(), thread_id: None,
        kind: CreativeNodeKind::Asset, asset_id: Some(entry.asset_id.clone()), role: Some(CreativeNodeRole::Reference),
        payload_json: r#"{"schema_version":1,"snapshot":{"name":"one"}}"#.into(),
        x: 10., y: 20., width: 100., height: 80., z_index: 1, position_locked: false,
    }).unwrap();
    let before = f.db.list_canvas_nodes("missing-canvas").unwrap();
    let moved = f.target.join("moved.png");
    fs::rename(&entry.path, &moved).unwrap();
    let preview = f.db.preview_asset_originals(&[entry.asset_id.clone()]).unwrap();
    f.db.trash_asset_original_with(&preview[0], |_| panic!("missing original cannot be recycled")).unwrap();
    let mut after = f.db.list_canvas_nodes("missing-canvas").unwrap();
    assert!(after[0].hidden_at.is_some());
    after[0].hidden_at = before[0].hidden_at;
    after[0].updated_at = before[0].updated_at;
    assert_eq!(after, before, "only visibility changes; card identity, position and payload remain");
    f.db.remove_canvas_node("missing-node").unwrap();
    assert!(f.db.material_catalog_assets("tags", None, None).unwrap().is_empty());
    assert!(f.db.get_asset(&entry.asset_id).unwrap().is_some());
    assert!(moved.is_file());
}
