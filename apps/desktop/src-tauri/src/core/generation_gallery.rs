//! Generation provenance and display preferences shared by canvas and catalog.
// Preserve execution IDs and files. Only exact producer/request relationships
// establish galleries; copied references and ambiguous ownership do not.
#[path = "generation_gallery_manual.rs"]
mod manual;
pub use manual::{GalleryMerge, GalleryMergeInput};

pub(crate) const WORKFLOW_GALLERY_CTE: &str = r#"
workflow_steps AS MATERIALIZED (
  SELECT w.project_id,s.key AS source_id,s.value AS step
  FROM canvas_workflows w,json_each(COALESCE(json_extract(w.document_json,'$.runs'),json_array(json_extract(w.document_json,'$.run')))) r,
    json_each(r.value,'$.steps') s
),
workflow_job_roots AS (
  SELECT project_id,source_id,json_extract(step,'$.jobId') AS job_id FROM workflow_steps
  UNION
  SELECT s.project_id,s.source_id,json_extract(g.value,'$.jobId') FROM workflow_steps s,json_each(s.step,'$.localDsGenerations') g
),
workflow_jobs AS (
  SELECT * FROM workflow_job_roots
  UNION
  SELECT n.project_id,j.source_id,json_extract(n.payload_json,'$.job_id') FROM workflow_job_roots j
  JOIN canvas_nodes origin ON origin.project_id=j.project_id AND origin.kind='prompt'
    AND json_extract(origin.payload_json,'$.job_id')=j.job_id
  JOIN canvas_nodes n ON n.project_id=j.project_id AND n.kind='prompt' AND n.id LIKE 'gen-prompt:%'
    AND json_extract(n.payload_json,'$.conversation_id')=json_extract(origin.payload_json,'$.conversation_id')
),
workflow_output_sources AS (
  SELECT n.id AS node_id,n.asset_id,n.project_id,json_extract(n.payload_json,'$.workflow_source') AS source_id
  FROM canvas_nodes n WHERE n.kind='asset' AND n.role='output' AND (n.id LIKE 'workflow-comfy:%' OR n.id LIKE 'workflow-video:%')
    AND json_type(n.payload_json,'$.workflow_source')='text'
  UNION
  SELECT n.id,n.asset_id,n.project_id,s.source_id FROM workflow_steps s
  JOIN canvas_nodes n ON n.project_id=s.project_id AND
    (n.id='workflow-comfy:'||json_extract(s.step,'$.jobId') OR n.id='workflow-video:'||json_extract(s.step,'$.localDsRequestId'))
  WHERE n.kind='asset' AND n.role='output' AND json_extract(n.payload_json,'$.workflow_source') IS NULL
  UNION
  SELECT n.id,n.asset_id,n.project_id,j.source_id FROM workflow_jobs j
  JOIN canvas_nodes n ON n.project_id=j.project_id AND
    ((n.kind='prompt' AND n.id LIKE 'gen-prompt:%' AND json_extract(n.payload_json,'$.job_id')=j.job_id) OR
     (n.kind='asset' AND n.role='output' AND n.id LIKE 'gen-output:%' AND json_extract(n.payload_json,'$.execution.job_id')=j.job_id))
  UNION
  SELECT n.id,n.asset_id,n.project_id,s.source_id FROM workflow_steps s
  JOIN cloud_agent_runs origin ON origin.run_id=json_extract(s.step,'$.agentRunId') AND origin.project_id=s.project_id
  JOIN cloud_agent_runs r ON r.conversation_id=origin.conversation_id AND r.project_id=s.project_id
  JOIN canvas_nodes n ON n.project_id=s.project_id AND n.kind='asset' AND n.role='final' AND n.id LIKE 'agent-artifact:%'
    AND json_extract(n.payload_json,'$.execution.run_id')=r.run_id
),
workflow_outputs AS (
  SELECT node_id,asset_id,project_id,'workflow:'||json_array(project_id,source_id) AS group_key FROM workflow_output_sources
),
canvas_generation_groups AS (
  SELECT node_id,project_id,CASE WHEN asset_id IN (SELECT asset_id FROM workflow_agent_image_assets)
    OR (node_id LIKE 'gen-prompt:%' AND group_key IN (SELECT group_key FROM workflow_agent_groups))
    THEN 'asset:'||node_id ELSE MIN(group_key) END AS group_key FROM workflow_outputs
  GROUP BY node_id,project_id HAVING COUNT(DISTINCT group_key)=1
  UNION ALL
  SELECT n.id,n.project_id,'generation:'||r.conversation_id FROM canvas_nodes n
  JOIN cloud_agent_runs r ON r.run_id=json_extract(n.payload_json,'$.execution.run_id') AND r.project_id=n.project_id
  WHERE n.kind='asset' AND n.role='final' AND n.id LIKE 'agent-artifact:%'
    AND NOT EXISTS(SELECT 1 FROM workflow_outputs w WHERE w.node_id=n.id)
),
workflow_asset_sources AS (
  SELECT asset_id,group_key FROM workflow_outputs WHERE asset_id IS NOT NULL
  UNION
  SELECT a.asset_id,'workflow:'||json_array(j.project_id,j.source_id) FROM analyses a
  JOIN workflow_jobs j ON json_extract(a.payload,'$.job_id')=j.job_id
  WHERE a.kind='generation_meta' AND json_valid(a.payload)
  UNION
  SELECT a.value,'workflow:'||json_array(s.project_id,s.source_id)
  FROM workflow_steps s,json_each(COALESCE(json_extract(s.step,'$.generatedAssetIds'),
    CASE WHEN json_extract(s.step,'$.localDsRequestId') IS NOT NULL AND COALESCE(json_array_length(s.step,'$.agentOutputTargets'),0)=0
      THEN json_extract(s.step,'$.agentOutputs.image.assetIds') END)) a
),
workflow_agent_groups AS (
  SELECT DISTINCT 'workflow:'||json_array(project_id,source_id) AS group_key FROM workflow_steps
  WHERE json_extract(step,'$.localDsRequestId') IS NOT NULL OR json_extract(step,'$.localDsGenerations') IS NOT NULL
    OR json_extract(step,'$.agentRunId') IS NOT NULL
),
workflow_agent_image_assets AS (
  SELECT DISTINCT w.asset_id FROM workflow_asset_sources w JOIN assets a ON a.id=w.asset_id
  WHERE w.group_key IN (SELECT group_key FROM workflow_agent_groups)
    AND lower(COALESCE(a.ext,'')) IN ('png','jpg','jpeg','webp','gif','bmp','svg','avif','tif','tiff')
),
workflow_asset_groups AS (
  SELECT asset_id,CASE WHEN asset_id IN (SELECT asset_id FROM workflow_agent_image_assets)
    THEN 'asset:'||asset_id ELSE MIN(group_key) END AS group_key FROM workflow_asset_sources
  GROUP BY asset_id HAVING COUNT(DISTINCT group_key)=1
),
other_generated_sources AS (
  SELECT a.asset_id,'generation:'||COALESCE(json_extract(a.payload,'$.conversation_id'),json_extract(a.payload,'$.session_id'),json_extract(a.payload,'$.job_id')) AS group_key
  FROM analyses a JOIN assets t ON t.id=a.asset_id AND t.generation_session_id IS NULL
  WHERE a.kind='generation_meta' AND json_valid(a.payload)
  UNION
  SELECT a.value,'chat:'||m.conversation_id FROM local_chat_messages m,json_each(m.reference_asset_ids) a
  WHERE m.role='tool' AND m.status='done' AND m.id=m.turn_id||'-video'
),
other_generated_groups AS (
  SELECT asset_id,MIN(group_key) AS group_key FROM other_generated_sources WHERE group_key IS NOT NULL
  GROUP BY asset_id HAVING COUNT(DISTINCT group_key)=1
)
"#;

impl crate::db::Database {
    pub fn dissolve_generation_group(&self, asset_id: Option<&str>, group_key: Option<&str>) -> crate::error::AppResult<()> {
        use rusqlite::OptionalExtension;
        use super::catalog_browser::{gallery_eligible, generation_resolved_group};
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let key = if let Some(id) = asset_id {
            tx.query_row(&format!("WITH {WORKFLOW_GALLERY_CTE} SELECT {} FROM assets a WHERE a.id=?1 AND {}", generation_resolved_group(), gallery_eligible()),
                [id], |row| row.get::<_, String>(0)).optional()?
        } else { group_key.map(str::to_owned) };
        let key = key.filter(|key| !key.is_empty() && !key.starts_with("asset:"))
            .ok_or_else(|| crate::error::AppError::Other("这项素材已独立显示".into()))?;
        let changed = tx.execute("INSERT OR IGNORE INTO generation_gallery_separations(group_key) VALUES (?1)", [&key])?;
        if changed > 0 { super::project_canvas::separate_generation_gallery(&tx, &key)?; }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{db::Database, core::catalog_browser::CatalogFilter};

    #[test]
    fn dissolve_survives_reopen_and_continuation_with_exact_assets_sessions_and_edges() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("gallery.sqlite");
        let db = Database::open(&path).unwrap();
        db.migrate().unwrap();
        db.create_project("p", "Project", "blank:p", "blank:p", "blank").unwrap();
        db.conn.lock().unwrap().execute_batch(r#"
            INSERT INTO assets(id,name,ext,created_at,generation_session_id) VALUES
                ('old','old','png',1,'s1'),('new','new','png',2,'s2'),('other','other','png',3,'other');
            INSERT INTO generation_conversations(session_id,conversation_id) VALUES('s1','conversation'),('s2','conversation');
            INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','old',1),('p','new',2);
            INSERT INTO connected_roots(id,path) VALUES('folder','/gallery');
            INSERT INTO connected_folders(id,root_id,path,name) VALUES('folder','folder','/gallery','Gallery');
            INSERT INTO connected_entries(id,folder_id,asset_id,path,name,is_reference) VALUES
                ('e1','folder','old','/gallery/a.png','a.png',0),
                ('e2','folder','old','/gallery/b.bowerbird','b.bowerbird',1),
                ('e3','folder','new','/gallery/c.png','c.png',0);
            INSERT INTO project_canvases(project_id,created_at,updated_at) VALUES('p',1,1);
            INSERT INTO creative_threads(id,project_id,title,origin,created_at,updated_at) VALUES('t','p','Thread','direct',1,1);
            INSERT INTO canvas_nodes(id,project_id,thread_id,kind,asset_id,role,payload_json,x,y,width,height,created_at,updated_at) VALUES
              ('session','p','t','prompt',NULL,NULL,'{"schema_version":1,"job_id":"job","conversation_id":"conversation","turn_key":"one","text":"prompt","status":"done"}',100,100,260,148,1,1),
              ('gen-output:old','p','t','asset','old','output','{"schema_version":1,"execution":{"job_id":"job","turn_key":"one"}}',100,100,260,200,2,2),
              ('gen-output:new','p','t','asset','new','output','{"schema_version":1,"execution":{"job_id":"job","turn_key":"two"}}',100,100,260,200,3,3),
              ('copy','p',NULL,'asset','old','reference','{"schema_version":1}',1000,400,260,200,4,4);
            INSERT INTO canvas_edges(id,project_id,thread_id,from_node_id,to_node_id,kind,ordinal,created_at)
                VALUES('wire','p','t','session','gen-output:old','produced',0,1);
        "#).unwrap();
        let filter = CatalogFilter { kind: "all".into(), media: "images".into(), ..Default::default() };
        assert_eq!(db.catalog_ids(&filter, 0, 20).unwrap().len(), 2);
        let folders = super::super::folder_connections::ConnectionFilter { grouped: true, ..Default::default() };
        assert_eq!(db.connection_entry_ids_filtered(Some("folder"), None, None, 0, 20, &folders).unwrap().len(), 1);
        let original = db.get_canvas_node("gen-output:old").unwrap().unwrap().payload_json;
        db.dissolve_generation_group(Some("new"), None).unwrap();
        db.dissolve_generation_group(Some("old"), None).unwrap(); // Idempotent; no repeated layout shift.
        let before = db.list_canvas_nodes("p").unwrap();
        assert_eq!(db.catalog_ids(&filter, 0, 20).unwrap(), vec!["other", "new", "old"]);
        assert_eq!(db.catalog_overview(&filter, None).unwrap().total, 3);
        assert_eq!(db.catalog_page(&filter, 1, 1).unwrap()[0].id, "new");
        assert_eq!(db.list_generation_group("old", None).unwrap().len(), 1);
        assert_eq!(db.connection_entry_ids_filtered(Some("folder"), None, None, 0, 20, &folders).unwrap(), vec!["e1", "e2", "e3"]);
        assert_eq!(db.get_canvas_node("gen-output:old").unwrap().unwrap().payload_json, original);
        for id in ["session", "gen-output:old", "gen-output:new"] {
            assert_eq!(serde_json::from_str::<serde_json::Value>(&before.iter().find(|n| n.id == id).unwrap().payload_json).unwrap()["generation_group_dissolved"], true);
        }
        let positions: Vec<_> = before.iter().filter(|n| n.id != "copy").map(|n| n.x).collect();
        assert!(positions.iter().enumerate().all(|(i,x)| positions.iter().skip(i+1).all(|y| (x-y).abs() >= 284.0)));
        assert_eq!(before.iter().find(|n| n.id == "copy").unwrap().x, 1000.0);
        drop(db);
        let db = Database::open(&path).unwrap();
        db.migrate().unwrap();
        assert_eq!(db.catalog_ids(&filter, 0, 20).unwrap().len(), 3);
        assert_eq!(db.list_canvas_nodes("p").unwrap().iter().map(|n| (&n.id,n.x)).collect::<Vec<_>>(), before.iter().map(|n| (&n.id,n.x)).collect::<Vec<_>>());
        db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,created_at,generation_session_id) VALUES('continued','continued','png',4,'s2');").unwrap();
        assert_eq!(db.catalog_ids(&filter, 0, 20).unwrap().len(), 4);
        assert_eq!(db.catalog_generation_groups(&filter, &["continued".into()]).unwrap()["continued"].len(), 1);
        let conn = db.conn.lock().unwrap();
        assert_eq!(conn.query_row("SELECT to_node_id FROM canvas_edges WHERE id='wire'", [], |r| r.get::<_,String>(0)).unwrap(), "gen-output:old");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM generation_conversations", [], |r| r.get::<_,i64>(0)).unwrap(), 2);
    }
}
