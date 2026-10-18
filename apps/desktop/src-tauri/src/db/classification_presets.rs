use super::Database;
use crate::error::AppResult;

impl Database {
    /// Called only for the main library, never for independent folder sessions.
    /// The marker and labels commit together so failures can safely retry.
    pub fn initialize_classification_presets(&self) -> AppResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let initialized: bool = tx.query_row(
            "SELECT presets_initialized FROM local_classification_state WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if !initialized {
            tx.execute_batch(include_str!("../../resources/classification-labels.sql"))?;
            tx.execute(
                "UPDATE local_classification_state SET presets_initialized=1 WHERE id=1",
                [],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_library_has_all_presets_without_enabling_scans() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        assert!(
            db.local_labels().unwrap().is_empty(),
            "schema migration must not seed folder sessions"
        );
        db.initialize_classification_presets().unwrap();
        let labels = db.local_labels().unwrap();
        let names = [
            "海报",
            "标志",
            "字体排版",
            "图案纹样",
            "包装展示图",
            "品牌应用图",
            "白底产品图",
            "场景产品图",
            "产品局部特写",
            "产品图解",
            "标题卡",
            "图文卡片",
            "信息图",
            "漫画页",
            "表情贴图",
            "分镜板",
            "角色设定图",
            "场景图",
            "道具图",
            "角色立绘",
            "面部特写",
            "半身人像",
            "全身人像",
            "群像",
            "静物",
            "材质纹理",
            "布光示意图",
        ];
        assert_eq!(labels.len(), names.len());
        for (i, name) in names.iter().enumerate() {
            let label = labels.iter().find(|l| l.name == *name).unwrap();
            assert_eq!(label.id, format!("preset_classification_{:02}", i + 1));
            assert!((100..=600).contains(&label.description.chars().count()));
            assert!(label.description.ends_with('。'));
            assert!(label.enabled);
            assert_eq!(label.dimension, None);
            assert_eq!(label.count, 0);
            assert!(!label.has_examples);
        }
        assert!(!db.local_enabled().unwrap());
        assert_eq!(db.local_revision().unwrap(), 0);
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM local_label_jobs", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn upgrade_preserves_existing_label_and_human_records() {
        let db = Database::open_in_memory().unwrap();
        {
            let mut conn = db.conn.lock().unwrap();
            super::super::migrations::migrations()
                .to_version(&mut conn, 36)
                .unwrap();
            conn.execute_batch("INSERT INTO tags(id,name,source,classification_description,classification_enabled,classification_dimension) VALUES('user-poster','海报','manual','我的说明',0,'other');
                INSERT INTO assets(id,name) VALUES('a','测试图');
                INSERT INTO asset_tags VALUES('a','user-poster','manual');
                INSERT INTO local_tag_rejections VALUES('a','user-poster');").unwrap();
        }
        db.migrate().unwrap();
        db.initialize_classification_presets().unwrap();
        let labels = db.local_labels().unwrap();
        assert_eq!(labels.len(), 27);
        let label = labels.iter().find(|l| l.name == "海报").unwrap();
        assert_eq!(label.id, "user-poster");
        assert_eq!(label.description, "我的说明");
        assert!(!label.enabled);
        assert_eq!(label.dimension.as_deref(), Some("other"));
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT origin FROM asset_tags WHERE tag_id='user-poster'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "manual"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM local_tag_rejections", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn restart_does_not_restore_deleted_or_edited_presets() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.initialize_classification_presets().unwrap();
        db.conn.lock().unwrap().execute_batch("DELETE FROM tags WHERE name='海报';
            UPDATE tags SET name='自定义标志',classification_description='修改后的说明',classification_enabled=0 WHERE name='标志';").unwrap();
        db.migrate().unwrap();
        db.initialize_classification_presets().unwrap();
        let labels = db.local_labels().unwrap();
        assert_eq!(labels.len(), 26);
        assert!(!labels.iter().any(|l| l.name == "海报" || l.name == "标志"));
        let edited = labels.iter().find(|l| l.name == "自定义标志").unwrap();
        assert_eq!(edited.description, "修改后的说明");
        assert!(!edited.enabled);
    }

    #[test]
    fn failed_initialization_rolls_back_and_can_retry() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_preset BEFORE INSERT ON tags WHEN NEW.name='布光示意图' BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(db.initialize_classification_presets().is_err());
        assert!(db.local_labels().unwrap().is_empty());
        db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_preset;")
            .unwrap();
        db.initialize_classification_presets().unwrap();
        assert_eq!(db.local_labels().unwrap().len(), 27);
    }
}
