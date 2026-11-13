use super::*;
use crate::core::catalog_browser::CatalogFilter;

fn fixture() -> (tempfile::TempDir, Database) {
    let temp=tempfile::tempdir().unwrap();
    let db=Database::open(&temp.path().join("gallery.db")).unwrap();db.migrate().unwrap();
    db.create_project("p","Project","blank:p","blank:p","blank").unwrap();
    db.create_project("other","Other","blank:other","blank:other","blank").unwrap();
    db.conn.lock().unwrap().execute_batch(r#"
      INSERT INTO assets(id,name,ext,store_path,created_at,generation_session_id) VALUES
       ('a','A','png','/a.png',1,'s1'),('b','B','png','/b.png',2,'s2'),('c','C','png','/c.png',3,'s3'),
       ('plain','Plain','png','/plain.png',4,NULL),('plain2','Plain2','jpg','/plain2.jpg',5,NULL),('video','Video','mp4','/v.mp4',6,NULL);
      INSERT INTO generation_conversations(session_id,conversation_id) VALUES('s1','first'),('s2','first'),('s3','second');
      INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','a',1),('p','b',2),('p','c',3);
      INSERT INTO project_canvases(project_id,created_at,updated_at) VALUES('p',1,1);
      INSERT INTO creative_threads(id,project_id,title,origin,created_at,updated_at) VALUES('t','p','Thread','direct',1,1);
      INSERT INTO canvas_nodes(id,project_id,thread_id,kind,asset_id,role,payload_json,x,y,width,height,created_at,updated_at) VALUES
       ('gen-prompt:first','p','t','prompt',NULL,NULL,'{"schema_version":1,"job_id":"first","conversation_id":"first","turn_key":"one","text":"first","status":"done"}',0,0,260,148,1,1),
       ('gen-prompt:second','p','t','prompt',NULL,NULL,'{"schema_version":1,"job_id":"second","conversation_id":"second","turn_key":"two","text":"second","status":"done"}',600,0,260,148,2,2),
       ('gen-output:a','p','t','asset','a','output','{"schema_version":1,"execution":{"job_id":"first","turn_key":"one"}}',0,0,260,180,1,1),
       ('gen-output:c','p','t','asset','c','output','{"schema_version":1,"execution":{"job_id":"second","turn_key":"two"}}',600,0,260,180,2,2);
      INSERT INTO connected_roots(id,path) VALUES('folder','/gallery');
      INSERT INTO connected_folders(id,root_id,path,name) VALUES('folder','folder','/gallery','Gallery');
      INSERT INTO connected_entries(id,folder_id,asset_id,path,name,is_reference) VALUES
       ('e1','folder','a','/gallery/a.png','a.png',0),('e2','folder','c','/gallery/c.png','c.png',0);
    "#).unwrap();
    (temp,db)
}
fn merge(db: &Database, ids: &[&str]) -> GalleryMerge {
    db.merge_generation_galleries(GalleryMergeInput { asset_ids:ids.iter().map(|s|s.to_string()).collect(),..Default::default() }).unwrap()
}
fn filter() -> CatalogFilter { CatalogFilter { kind:"all".into(),media:"images".into(),..Default::default() } }

#[test]
fn manual_merge_preserves_provenance_and_survives_reopen_in_canvas_and_catalog() {
    let (temp,db)=fixture();
    let original=db.get_canvas_node("gen-prompt:first").unwrap().unwrap().payload_json;
    let edit=merge(&db,&["b","c"]);
    let members=db.list_generation_group("c",None).unwrap();
    assert_eq!(members.iter().map(|a|a.id.as_str()).collect::<Vec<_>>(),vec!["a","b","c"]);
    let snapshot=db.project_canvas_snapshot("p").unwrap();
    for node in &snapshot.nodes {
        let value:serde_json::Value=serde_json::from_str(&node.payload_json).unwrap();
        assert_eq!(value["generation_gallery_key"],edit.group_key);
    }
    assert_eq!(db.get_canvas_node("gen-prompt:first").unwrap().unwrap().payload_json,original);
    let folder=crate::core::folder_connections::ConnectionFilter {grouped:true,..Default::default()};
    assert_eq!(db.connection_entry_ids_filtered(Some("folder"),None,Some("images"),0,20,&folder).unwrap(),vec!["e2"]);
    drop(db);
    let db=Database::open(&temp.path().join("gallery.db")).unwrap();db.migrate().unwrap();
    assert_eq!(db.catalog_generation_groups(&filter(),&["c".into()]).unwrap()["c"].len(),3);
    db.undo_generation_gallery_merge(edit).unwrap();
    assert_eq!(db.list_generation_group("b",None).unwrap().len(),2);
    assert_eq!(db.list_generation_group("c",None).unwrap().len(),1);
}

#[test]
fn explicit_canvas_references_merge_but_copies_keep_their_own_display() {
    let (_temp,db)=fixture();
    db.conn.lock().unwrap().execute_batch(r#"
      INSERT INTO canvas_nodes(id,project_id,kind,asset_id,role,payload_json,x,y,width,height,created_at,updated_at) VALUES
       ('chosen-a','p','asset','plain','reference','{"schema_version":1}',0,0,100,100,1,1),
       ('chosen-b','p','asset','plain2','reference','{"schema_version":1}',200,0,100,100,2,2),
       ('copy','p','asset','plain','reference','{"schema_version":1}',400,0,100,100,3,3);
    "#).unwrap();
    let edit=db.merge_generation_galleries(GalleryMergeInput {asset_ids:vec!["plain".into(),"plain2".into()],node_ids:vec!["chosen-a".into(),"chosen-b".into()],project_id:Some("p".into()),..Default::default()}).unwrap();
    let snapshot=db.project_canvas_snapshot("p").unwrap();
    for node in snapshot.nodes.iter().filter(|n| ["chosen-a","chosen-b","copy"].contains(&n.id.as_str())) {
        let payload:serde_json::Value=serde_json::from_str(&node.payload_json).unwrap();
        assert_eq!(payload["manual_gallery_node"]==true,node.id!="copy");
    }
    db.undo_generation_gallery_merge(edit).unwrap();
    assert!(db.project_canvas_snapshot("p").unwrap().nodes.iter().all(|node| !node.payload_json.contains("manual_gallery_node")));
}

#[test]
fn plain_images_group_without_becoming_generated_and_invalid_selection_is_atomic() {
    let (_temp,db)=fixture();
    let edit=merge(&db,&["plain","plain2"]);
    assert_eq!(db.list_generation_group("plain",None).unwrap().len(),2);
    let mut ordinary=filter();ordinary.generated=Some(false);
    assert_eq!(db.catalog_generation_groups(&ordinary,&["plain2".into()]).unwrap()["plain2"].len(),2);
    ordinary.generated=Some(true);
    assert!(db.catalog_generation_groups(&ordinary,&["plain2".into()]).unwrap().is_empty());
    assert!(db.merge_generation_galleries(GalleryMergeInput {asset_ids:vec!["a".into(),"video".into()],..Default::default()}).is_err());
    assert_eq!(db.list_generation_group("a",None).unwrap().len(),2);
    db.undo_generation_gallery_merge(edit).unwrap();
    assert!(db.list_generation_group("plain",None).unwrap().is_empty());
}

#[test]
fn dissolve_remerge_and_undo_do_not_overwrite_later_edits() {
    let (_temp,db)=fixture();
    let first=merge(&db,&["a","c"]);
    let second=merge(&db,&["b","plain"]);
    assert!(db.undo_generation_gallery_merge(first).is_err());
    db.undo_generation_gallery_merge(second).unwrap();
    db.dissolve_generation_group(Some("a"),None).unwrap();
    assert_eq!(db.list_generation_group("a",None).unwrap().len(),1);
    let edit=merge(&db,&["a","c"]);
    assert_eq!(db.list_generation_group("a",None).unwrap().len(),2);
    assert_eq!(db.list_generation_group("b",None).unwrap().len(),1);
    db.undo_generation_gallery_merge(edit).unwrap();
    assert_eq!(db.list_generation_group("a",None).unwrap().len(),1);
}

#[test]
fn pending_jobs_join_by_exact_project_identity_and_late_results_keep_their_group() {
    let (_temp,db)=fixture();
    db.conn.lock().unwrap().execute_batch(r#"
      INSERT INTO task_queue(id,kind,payload,status,project_id,created_at) VALUES
       ('first','generation','{"conversation_id":"first","media":"image"}','done','p',10),
       ('second','generation','{"conversation_id":"second","media":"image"}','running','p',10),
       ('video','generation','{"media":"video"}','running','p',12),
       ('internal','generation','{"media":"image","internal_agent":true}','running','p',13),
       ('foreign','generation','{"media":"image"}','done','other',14);
    "#).unwrap();
    assert_eq!(db.previous_gallery_generation(Some("p")).unwrap().as_deref(),Some("second"));
    assert_eq!(db.previous_gallery_generation(None).unwrap(),None);
    db.conn.lock().unwrap().execute("UPDATE task_queue SET payload=json_set(payload,'$.created_at',15) WHERE id='first'",[]).unwrap();
    assert_eq!(db.previous_gallery_generation(Some("p")).unwrap().as_deref(),Some("first"),"a new turn on an older job is the latest submission");
    assert!(db.merge_generation_galleries(GalleryMergeInput {job_ids:vec!["first".into(),"foreign".into()],project_id:Some("p".into()),..Default::default()}).is_err());
    let edit=db.merge_generation_galleries(GalleryMergeInput {job_ids:vec!["first".into(),"second".into()],project_id:Some("p".into()),..Default::default()}).unwrap();
    db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,store_path,created_at,generation_session_id) VALUES('late','Late','png','/late.png',20,'s1')").unwrap();
    assert_eq!(db.list_generation_group("c",None).unwrap().len(),4);
    let payload:String=db.conn.lock().unwrap().query_row("SELECT payload FROM task_queue WHERE id='second'",[],|r|r.get(0)).unwrap();
    assert_eq!(payload,r#"{"conversation_id":"second","media":"image"}"#);
    db.undo_generation_gallery_merge(edit).unwrap();
}
