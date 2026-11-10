//! Replace an explicitly selected original while retaining its material identity.
use std::{fs, io::{BufReader, Write}, path::Path};
use image::ImageFormat;
use rusqlite::params;
use serde::Deserialize;
use serde_json::Value;
use crate::{core::{external_files::fingerprint, library::Asset, paths::LibraryPaths}, db::Database, error::{AppError, AppResult}, media};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overwrite { pub asset_id: String, pub source_hash: String }

fn changed() -> AppError { AppError::Other("原图片已变化，请重新打开后再保存".into()) }

fn original_format(path: &Path) -> AppResult<ImageFormat> {
    let format = ImageFormat::from_path(path).map_err(|_| AppError::Other("此格式不能覆盖原文件，请保存到素材库".into()))?;
    let file = || fs::File::open(path).map(BufReader::new);
    let supported = match format {
        ImageFormat::Jpeg | ImageFormat::Bmp => true,
        ImageFormat::Png => !image::codecs::png::PngDecoder::new(file()?)?.is_apng()?,
        ImageFormat::WebP => !image::codecs::webp::WebPDecoder::new(file()?)?.has_animation(),
        _ => false,
    };
    if !supported { return Err(AppError::Other("此图片格式或动画不能覆盖原文件，请保存到素材库".into())); }
    Ok(format)
}

pub fn overwrite(paths: &LibraryPaths, db: &Database, request: &Overwrite, bytes: &[u8], annotation: &str) -> AppResult<Asset> {
    let asset = db.get_asset(&request.asset_id)?.ok_or_else(changed)?;
    let stored = asset.store_path.as_deref().ok_or_else(changed)?;
    let path = fs::canonicalize(stored)?;
    let mut record: Value = serde_json::from_str(annotation)?;
    let image = image::load_from_memory(bytes)?;
    if record["source_asset_id"] != asset.id || record["source_store_path"] != stored
        || record["schema_version"] != 1 || !record["shapes"].is_array()
        || record["image"]["width"] != image.width() || record["image"]["height"] != image.height() {
        return Err(AppError::Other("标注记录与原图片不一致，未覆盖".into()));
    }
    if fingerprint(&path)? != request.source_hash { return Err(changed()); }
    let metadata = fs::metadata(&path)?;
    if metadata.permissions().readonly() { return Err(AppError::Other("原文件为只读，请修改文件权限后重试".into())); }
    let format = original_format(&path)?;
    let parent = path.parent().ok_or_else(changed)?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    // Keep the original extension and encoding; never put PNG bytes in a WebP/BMP file.
    if image::guess_format(bytes)? == format { output.write_all(bytes)?; }
    else { image.write_to(output.as_file_mut(), format)?; }
    output.as_file().set_permissions(metadata.permissions())?;
    output.as_file().sync_all()?;
    let output_hash = fingerprint(output.path())?;
    record["save_mode"] = "overwrite".into();
    record["source_sha256"] = request.source_hash.clone().into();
    record["output_sha256"] = output_hash.clone().into();
    let thumbnail = paths.thumb_path(&ulid::Ulid::new().to_string());
    let result = (|| -> AppResult<()> {
        media::thumb::generate_from_image(&image, &thumbnail, 480)?;
        let mut backup = tempfile::NamedTempFile::new_in(parent)?;
        std::io::copy(&mut fs::File::open(&path)?, backup.as_file_mut())?;
        backup.as_file().set_permissions(metadata.permissions())?;
        backup.as_file().sync_all()?;
        let names = crate::core::external_files::connection_path_spellings(Path::new(stored), &path);
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: String = tx.query_row("SELECT store_path FROM assets WHERE id=?1", [&asset.id], |r| r.get(0))?;
        if current != stored || fs::canonicalize(&current)? != path || fingerprint(&path)? != request.source_hash
            || fingerprint(backup.path())? != request.source_hash { return Err(changed()); }
        // Same original can have legacy identities or connected aliases. Refresh each,
        // without changing membership, manual descriptions, tags, or canvas instances.
        let ids = tx.prepare("SELECT id FROM assets WHERE store_path IN (?1,?2,?3)")?
            .query_map(params![names[0], names[1], names[2]], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let size = output.as_file().metadata()?.len() as i64;
        let mtime = output.as_file().metadata()?.modified()?.duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| AppError::Other(e.to_string()))?.as_secs() as i64;
        for id in ids {
            tx.execute("UPDATE assets SET size=?2,width=?3,height=?4,thumb_path=?5,file_mtime=?6,phash=NULL,colors=NULL WHERE id=?1",
                params![id,size,image.width(),image.height(),thumbnail.to_string_lossy(),mtime])?;
            tx.execute("DELETE FROM asset_colors WHERE asset_id=?1", [&id])?;
            tx.execute("UPDATE external_assets SET fingerprint=?2 WHERE asset_id=?1", params![id,output_hash])?;
            tx.execute("INSERT INTO creative_file_fingerprints(asset_id,sha256,asset_size,asset_mtime) VALUES(?1,?2,?3,?4) ON CONFLICT(asset_id) DO UPDATE SET sha256=excluded.sha256,asset_size=excluded.asset_size,asset_mtime=excluded.asset_mtime", params![id,output_hash,size,mtime])?;
            tx.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'annotation',?3,strftime('%s','now'))",
                params![ulid::Ulid::new().to_string(),id,record.to_string()])?;
        }
        output.persist(&path).map_err(|e| AppError::Other(format!("文件未保存，请检查文件占用及目录权限：{}", e.error)))?;
        if let Err(error) = tx.commit() {
            if let Err(restore) = backup.persist(&path) {
                let (_, retained) = restore.file.keep().map_err(|e| AppError::Other(e.to_string()))?;
                return Err(AppError::Other(format!("保存与恢复失败，原文件备份保留在 {}：{error}", retained.display())));
            }
            return Err(error.into());
        }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&thumbnail); }
    result?;
    db.get_asset(&asset.id)?.ok_or_else(changed)
}

#[cfg(test)]
#[path = "library_annotation_tests.rs"]
mod tests;
