use super::*;

static QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

pub(super) async fn load(root: PathBuf, id: String, project: String) -> AppResult<Value> {
    let permit = QUEUE.acquire().await.map_err(|_| error("封面队列不可用"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        ensure(&root, &id, &project, |source, destination| crate::media::thumb::generate_video(source, destination, 480)).map(|path| json!(path))
    }).await.map_err(|_| error("读取视频首帧失败"))?
}

fn ensure(root: &Path, id: &str, project: &str, generate: impl FnOnce(&Path, &Path) -> AppResult<()>) -> AppResult<PathBuf> {
    // Reference copies belong to a task, not the assets table. Verify their owner and hash.
    let (_, source) = verified_reference(root, id, project)?;
    let destination = folder(root, id)?.join("first-frame.jpg");
    if !image::open(&destination).is_ok_and(|image| image.width() > 0 && image.height() > 0) {
        generate(&source, &destination)?;
    }
    Ok(destination)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn reference_poster_is_cached_repaired_and_project_scoped() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = folder(&root, &id).unwrap(); fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mp4"); fs::write(&source, b"reference video").unwrap();
        save(&root, &json!({"id":id,"kind":"reference","projectId":"p","path":source,"hash":hash(&source).unwrap()})).unwrap();
        let generate = |input: &Path, output: &Path| -> AppResult<()> {
            assert_eq!(input, source); image::RgbImage::new(32,18).save(output)?; Ok(())
        };
        let poster = ensure(&root, &id, "p", generate).unwrap();
        assert_eq!(ensure(&root, &id, "p", |_,_| panic!("cached poster decoded again")).unwrap(), poster);
        fs::write(&poster, b"corrupt").unwrap();
        ensure(&root, &id, "p", generate).unwrap();
        assert!(ensure(&root, &id, "other", |_,_| panic!("wrong project decoded")).is_err());
        fs::write(&source, b"changed video").unwrap();
        assert!(ensure(&root, &id, "p", |_,_| panic!("changed reference decoded")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
