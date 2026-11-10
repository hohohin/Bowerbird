use super::*;

impl CreatedTextDocument {
    fn document(&self) -> &TextDocument {
        match self {
            Self::Collection { document } => document,
            Self::Project { .. } => panic!("expected collection original"),
        }
    }
    fn node_id(&self) -> Option<&String> {
        match self {
            Self::Project { node_id } => Some(node_id),
            Self::Collection { .. } => None,
        }
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    paths: LibraryPaths,
    db: Database,
    folder: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let mut paths = LibraryPaths::init(root.join("library")).unwrap();
        paths.files = Some(Arc::new(
            crate::core::file_workspace::FileWorkspace::open(
                root.join("files.json"),
                root.join("files"),
            )
            .unwrap(),
        ));
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        let directory = root.join("我的脚本");
        fs::create_dir(&directory).unwrap();
        let folder = db.connect_directory(&directory, None).unwrap();
        Self {
            _temp: temp,
            paths,
            db,
            folder,
        }
    }
    fn request(&self) -> CreateTextDocument {
        CreateTextDocument {
            request_id: "create-document-one".into(),
            title: "秋日剧本".into(),
            text: "# 开场\n\n**光线**\n".into(),
            destination: DocumentDestination::Collection {
                folder_id: self.folder.clone(),
            },
        }
    }
}

#[test]
fn creates_markdown_in_selected_collection_and_replays_once() {
    let f = Fixture::new();
    let request = f.request();
    let first = create(&f.paths, &f.db, &request).unwrap();
    let folder = f.db.connected_folder(&f.folder).unwrap();
    assert_eq!(
        Path::new(&first.document().path).parent().unwrap(),
        Path::new(&folder.path)
    );
    assert_eq!(
        fs::read_to_string(&first.document().path).unwrap(),
        request.text
    );
    assert_eq!(first.document().format, "markdown");
    assert!(first.node_id().is_none());
    assert_eq!(
        f.db.connection_entry_ids(Some(&f.folder), None, Some("texts"), 0, 20)
            .unwrap()
            .len(),
        1
    );
    let again = create(&f.paths, &f.db, &request).unwrap();
    assert_eq!(again.document().asset_id, first.document().asset_id);
    assert_eq!(fs::read_dir(&folder.path).unwrap().count(), 1);
}

#[test]
fn replay_preserves_later_edits_and_rejects_changed_request() {
    let f = Fixture::new();
    let request = f.request();
    let first = create(&f.paths, &f.db, &request).unwrap();
    fs::write(&first.document().path, "外部编辑").unwrap();
    let again = create(&f.paths, &f.db, &request).unwrap();
    assert_eq!(again.document().text, "外部编辑");
    let mut changed = request.clone();
    changed.text = "另一次请求".into();
    assert!(create(&f.paths, &f.db, &changed).is_err());
    assert_eq!(
        fs::read_to_string(&first.document().path).unwrap(),
        "外部编辑"
    );
    fs::remove_file(&first.document().path).unwrap();
    assert!(
        create(&f.paths, &f.db, &request).is_err(),
        "completed request must not resurrect a removed original"
    );
}

#[test]
fn distinct_requests_do_not_overwrite_same_named_document() {
    let f = Fixture::new();
    let mut request = f.request();
    let first = create(&f.paths, &f.db, &request).unwrap();
    request.request_id = "create-document-two".into();
    request.text = "second".into();
    let second = create(&f.paths, &f.db, &request).unwrap();
    assert_ne!(first.document().path, second.document().path);
    assert_eq!(
        fs::read_to_string(&first.document().path).unwrap(),
        "# 开场\n\n**光线**\n"
    );
}

#[test]
fn rejects_invalid_destination_filename_and_oversized_text_before_writing() {
    let f = Fixture::new();
    let original = f.request();
    for title in ["../outside", "..", "CON", "file:", "ending."] {
        let mut request = original.clone();
        request.title = title.into();
        assert!(create(&f.paths, &f.db, &request).is_err(), "{title}");
    }
    let mut request = original.clone();
    request.text = "x".repeat(MAX_BYTES + 1);
    assert!(create(&f.paths, &f.db, &request).is_err());
    request.text = "text\0binary".into();
    assert!(create(&f.paths, &f.db, &request).is_err());
    request.text = original.text;
    request.destination = DocumentDestination::Collection {
        folder_id: "absent".into(),
    };
    assert!(create(&f.paths, &f.db, &request).is_err());
    request.destination = DocumentDestination::Project {
        project_id: "absent".into(),
    };
    assert!(create(&f.paths, &f.db, &request).is_err());
    assert_eq!(
        fs::read_dir(f.db.connected_folder(&f.folder).unwrap().path)
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn retries_index_failure_without_writing_another_original() {
    let f = Fixture::new();
    let request = f.request();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_new_text BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT,'test indexing failure'); END").unwrap();
    assert!(create(&f.paths, &f.db, &request).is_err());
    let folder = f.db.connected_folder(&f.folder).unwrap().path;
    assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
    f.db.conn
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_new_text")
        .unwrap();
    let saved = create(&f.paths, &f.db, &request).unwrap();
    assert_eq!(fs::read_dir(&folder).unwrap().count(), 1);
    assert_eq!(saved.document().text, request.text);
}

#[test]
fn project_delivery_resumes_with_one_card_and_no_second_document_file() {
    let f = Fixture::new();
    let mut request = f.request();
    f.db.create_project(
        "project-doc",
        "剧本项目",
        "test-project",
        "test-project",
        "user",
    )
    .unwrap();
    request.destination = DocumentDestination::Project {
        project_id: "project-doc".into(),
    };
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_document_node BEFORE INSERT ON canvas_nodes BEGIN SELECT RAISE(ABORT,'test node failure'); END").unwrap();
    assert!(create(&f.paths, &f.db, &request).is_err());
    f.db.conn
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_document_node")
        .unwrap();
    let saved = create(&f.paths, &f.db, &request).unwrap();
    let node =
        f.db.get_canvas_node(saved.node_id().as_ref().unwrap())
            .unwrap()
            .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&node.payload_json).unwrap();
    assert_eq!(payload["note_type"], "document");
    assert_eq!(node.width / node.height, 3.0 / 4.0);
    assert_eq!(payload["text"], request.text);
    assert_eq!(payload["cells"], serde_json::json!([]));
    assert_eq!(
        f.db.get_project("project-doc")
            .unwrap()
            .unwrap()
            .asset_count,
        0
    );
    assert_eq!(f.db.list_canvas_nodes("project-doc").unwrap().len(), 1);
    let again = create(&f.paths, &f.db, &request).unwrap();
    assert_eq!(again.node_id(), saved.node_id());
    assert!(f
        .paths
        .files
        .as_ref()
        .unwrap()
        .snapshot()
        .projects
        .is_empty());
}

#[test]
fn project_titles_allow_punctuation_while_collection_filenames_remain_safe() {
    let f = Fixture::new();
    let mut request = f.request();
    request.title = "Scene 1: Dawn?".into();
    assert!(create(&f.paths, &f.db, &request).is_err());
    assert_eq!(
        fs::read_dir(f.db.connected_folder(&f.folder).unwrap().path)
            .unwrap()
            .count(),
        0
    );
    f.db.create_project(
        "project-title",
        "剧本项目",
        "test-project",
        "test-project",
        "user",
    )
    .unwrap();
    request.destination = DocumentDestination::Project {
        project_id: "project-title".into(),
    };
    let saved = create(&f.paths, &f.db, &request).unwrap();
    let node =
        f.db.get_canvas_node(saved.node_id().unwrap())
            .unwrap()
            .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&node.payload_json).unwrap();
    assert_eq!(payload["title"], "Scene 1: Dawn?");
    assert_eq!(payload["text"], request.text);
    request.request_id = "project-title-at-limit".into();
    request.title = "a".repeat(100);
    assert!(create(&f.paths, &f.db, &request).is_ok());
    request.request_id = "project-title-over-limit".into();
    request.title.push('a');
    assert!(create(&f.paths, &f.db, &request).is_err());
}

#[test]
fn concurrent_replays_share_one_original_and_asset() {
    let f = Arc::new(Fixture::new());
    let threads: Vec<_> = (0..5)
        .map(|_| {
            let f = f.clone();
            std::thread::spawn(move || {
                create(&f.paths, &f.db, &f.request())
                    .unwrap()
                    .document()
                    .asset_id
                    .clone()
            })
        })
        .collect();
    let ids: std::collections::HashSet<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(ids.len(), 1);
    assert_eq!(
        fs::read_dir(f.db.connected_folder(&f.folder).unwrap().path)
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn completed_project_request_does_not_claim_a_deleted_card_was_saved() {
    let f = Fixture::new();
    let mut request = f.request();
    f.db.create_project(
        "project-doc",
        "剧本项目",
        "test-project",
        "test-project",
        "user",
    )
    .unwrap();
    request.destination = DocumentDestination::Project {
        project_id: "project-doc".into(),
    };
    let saved = create(&f.paths, &f.db, &request).unwrap();
    f.db.remove_canvas_node(saved.node_id().as_ref().unwrap())
        .unwrap();
    assert!(create(&f.paths, &f.db, &request).is_err());
    assert!(f.db.list_canvas_nodes("project-doc").unwrap().is_empty());
    assert!(f
        .paths
        .files
        .as_ref()
        .unwrap()
        .snapshot()
        .projects
        .is_empty());
}

#[test]
fn pending_original_changed_externally_is_never_replaced() {
    let f = Fixture::new();
    let request = f.request();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_new_text BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT,'test indexing failure'); END").unwrap();
    assert!(create(&f.paths, &f.db, &request).is_err());
    let folder = f.db.connected_folder(&f.folder).unwrap().path;
    let path = fs::read_dir(&folder)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(&path, "external").unwrap();
    f.db.conn
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_new_text")
        .unwrap();
    assert!(create(&f.paths, &f.db, &request).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "external");
}
