//! 首启预置示例图：新用户首次打开应用时把 6 张图随包注入素材库，
//! 每张预填 caption（11 维度）+ auto tag + 主色（ingest 自动），破解空状态。
//! 全程不调 codex（caption 由 manifest 预填，符合离线降级约定 7）。
//!
//! 数据驱动：加图 / 改文案只动下方的 `SAMPLES` const 表与 `CAPTION_*` 文本，
//! 注入逻辑（`seed_if_first_launch` / `seed_one`）不变。
//!
//! caption 维度顺序刻意把「构图」放在「ratio」前：两者都别名映射到 composition，
//! `map_dimensions` 用 or_insert_with 先到先得，让 composition 取「构图」正文
//! （创作板 `@图+构图` chip 更有意义），ratio 段落只进 sections。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::core::caption;
use crate::core::ingest;
use crate::core::library::Analysis;
use crate::core::paths::LibraryPaths;
use crate::core::settings::SettingsState;
use crate::db::Database;
use crate::error::AppResult;

/// 预置图写入 `assets.source` 的标记值（未来前端可按 `source:sample` 筛选/角标，MVP 不做）。
const SAMPLE_SOURCE: &str = "sample";
/// caption payload 的 instruction 字段（标识这是示例预填，非 codex 反推）。
const SEED_INSTRUCTION: &str = "示例预填";

/// 一张示例图的 manifest 项。
#[derive(Clone)]
struct SampleSpec {
    /// 对应 resources/samples/<filename>（随安装包内嵌）。
    filename: &'static str,
    /// 11 维度 markdown 文本，由 caption::parse 解析为 sections + dimensions。
    caption: &'static str,
    /// auto tag 名（须在 0005 seed 词表内：人像/风景/静物/美食/动物/建筑/抽象/插画/室内/街景）。
    tags: &'static [&'static str],
}

const SAMPLES: &[SampleSpec] = &[
    SampleSpec {
        filename: "portrait-soft.jpg",
        caption: CAPTION_PORTRAIT,
        tags: &["人像"],
    },
    SampleSpec {
        filename: "landscape-fog.jpg",
        caption: CAPTION_LANDSCAPE,
        tags: &["风景"],
    },
    SampleSpec {
        filename: "food-warm.jpg",
        caption: CAPTION_FOOD,
        tags: &["美食"],
    },
    SampleSpec {
        filename: "animal-running.jpg",
        caption: CAPTION_ANIMAL,
        tags: &["动物"],
    },
    SampleSpec {
        filename: "interior-minimal.jpg",
        caption: CAPTION_INTERIOR,
        tags: &["室内"],
    },
    SampleSpec {
        filename: "street-neon.jpg",
        caption: CAPTION_STREET,
        tags: &["街景"],
    },
];

// 注：以下 6 份 caption 为通用占位文案（图未到位时即可生效，能被 caption::parse
// 解析为 parse_status="structured"）。用户的示例图就位后，照实际图改写正文即可，
// 维度段落起首格式（`- **维度名**`）与顺序不要动。

const CAPTION_PORTRAIT: &str = r#"
- **类型**
人像摄影，半身近景。

- **构图**
竖幅，主体居中略偏左，视线回望镜头。

- **ratio**
3 比 4 竖幅。

- **光影**
柔和侧光，左上方主光，阴影过渡平滑。

- **色调**
低饱和蓝灰背景配暖肤色，整体偏冷调。

- **主体动作**
人物侧身回头，发丝微飘。

- **材质 / 笔触**
照片级质感，皮肤细腻，背景虚化。

- **背景**
虚化的城市夜景，散景光斑。

- **氛围 / 情绪**
安静、克制、带一点怀旧。

- **反推提示词**
portrait of a person looking back, soft side lighting, shallow depth of field, cool blue-grey background, warm skin tone.

- **负面提示词**
oversaturated, cartoon, deformed hands, low quality.
"#;

const CAPTION_LANDSCAPE: &str = r#"
- **类型**
自然风光，远山雾景。

- **构图**
横幅三分法，地平线压低，山体占画面下三分之二。

- **ratio**
16 比 9 横幅。

- **光影**
清晨漫射光，无强阴影，整体通透。

- **色调**
冷青绿主调，远山带淡紫雾气。

- **主体动作**
静态风光，无人物，视线沿山脊引导。

- **材质 / 笔触**
写实摄影，细节锐利，雾气柔和过渡。

- **背景**
层叠远山逐渐隐入雾中。

- **氛围 / 情绪**
宁静、辽阔、空灵。

- **反推提示词**
foggy mountain landscape at dawn, layered ridges, soft diffused light, cool teal and lavender palette, wide angle.

- **负面提示词**
oversaturated, people, text, low quality.
"#;

const CAPTION_FOOD: &str = r#"
- **类型**
美食摄影，俯拍静物。

- **构图**
顶视平铺，主体居中，餐具环绕点缀。

- **ratio**
1 比 1 方幅。

- **光影**
暖侧光，右上方主光，食物表面质感清晰。

- **色调**
暖黄棕主调，配新鲜绿色点缀。

- **主体动作**
静态摆盘，蒸汽微起。

- **材质 / 笔触**
照片级质感，食物纹理细腻，器皿哑光。

- **背景**
深色木桌面，衬出食物暖色。

- **氛围 / 情绪**
温暖、诱人、家常。

- **反推提示词**
top-down food photography, warm side light, rustic wooden table, fresh garnish, appetizing, 1:1.

- **负面提示词**
plastic look, dim, messy, low quality.
"#;

const CAPTION_ANIMAL: &str = r#"
- **类型**
动物摄影，奔跑瞬间。

- **构图**
横向跟随构图，主体偏左，前方留出运动空间。

- **ratio**
3 比 2 横幅。

- **光影**
顺光，毛发边缘有光晕，阴影短促。

- **色调**
自然饱和，棕黄主调配绿色环境。

- **主体动作**
动物四足腾空奔跑，动态强烈。

- **材质 / 笔触**
照片级质感，毛发清晰，背景动态模糊。

- **背景**
虚化的草地或荒野。

- **氛围 / 情绪**
充满活力、自由、野性。

- **反推提示词**
running animal in motion, freezing the stride, golden fur rim light, blurred grassland background, dynamic.

- **负面提示词**
static pose, indoors, oversaturated, low quality.
"#;

const CAPTION_INTERIOR: &str = r#"
- **类型**
室内设计摄影，极简客厅。

- **构图**
单点透视，对称构图，视觉中心落在远方家具。

- **ratio**
4 比 3 横幅。

- **光影**
自然窗光，左侧主光，柔和阴影。

- **色调**
中性灰白主调，配原木暖色。

- **主体动作**
无人物，静物陈设。

- **材质 / 笔触**
写实摄影，材质纹理清晰，反光自然。

- **背景**
纵深递进的墙面与家具。

- **氛围 / 情绪**
克制、整洁、安静。

- **反推提示词**
minimalist living room interior, one-point perspective, natural window light, neutral grey and warm wood palette.

- **负面提示词**
cluttered, people, oversaturated, low quality.
"#;

const CAPTION_STREET: &str = r#"
- **类型**
街拍摄影，雨夜霓虹。

- **构图**
中心对称，主体位于画面中央，霓虹招牌框住视线。

- **ratio**
2 比 3 竖幅。

- **光影**
霓虹点光源，水面反光，高对比。

- **色调**
青紫粉霓虹主调，暗部偏蓝。

- **主体动作**
行人撑伞经过，轻微动态模糊。

- **材质 / 笔触**
照片级质感，湿润路面反光细腻。

- **背景**
雨幕与远处模糊的店铺灯光。

- **氛围 / 情绪**
赛博朋克、孤寂、电影感。

- **反推提示词**
rainy neon street at night, reflections on wet pavement, cyberpunk mood, pink and cyan palette, cinematic.

- **负面提示词**
daytime, flat lighting, oversaturated, low quality.
"#;

/// 首启注入入口：异步、不阻塞启动窗口。双 gate（旗标 + 空库）判定是否注入。
/// 必须在 `app.manage(settings_state)` 之后调用（spawn 内经 `app.state::<SettingsState>()` 读写旗标）。
pub fn seed_if_first_launch(app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>) {
    tauri::async_runtime::spawn(async move {
        let settings_state = app.state::<SettingsState>();

        // gate 1：旗标已写 → 已注入过，跳过。
        if settings_state.inner().get().samples_seeded {
            return;
        }
        // gate 2：库非空 → 用户已有数据（settings 损坏/复制/手动重置 flag），不污染。
        match db_call(&db, |db| db.count_assets(None)).await {
            Ok(n) if n > 0 => return,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("samples seed: count check failed: {e}");
                return;
            }
        }
        // dev 图未放 / release resource 缺失 → 优雅跳过，不写旗标（下次启动重试）。
        let Some(dir) = resolve_samples_dir(&app) else {
            tracing::warn!("samples resource dir not found, skipping seed");
            return;
        };

        let mut ok = 0usize;
        for spec in SAMPLES {
            let path = dir.join(spec.filename);
            if !path.exists() {
                tracing::warn!("sample missing: {}", path.display());
                continue;
            }
            let path_display = path.display().to_string();
            let db = db.clone();
            let paths = paths.clone();
            let caption_text = spec.caption.to_string();
            let tag_names: Vec<String> = spec.tags.iter().map(|s| s.to_string()).collect();
            match tokio::task::spawn_blocking(move || {
                seed_one(&paths, &db, &path, &caption_text, &tag_names)
            })
            .await
            {
                Ok(Ok(())) => ok += 1,
                Ok(Err(e)) => tracing::warn!("seed_one failed for {path_display}: {e}"),
                Err(e) => tracing::warn!("seed_one panicked for {path_display}: {e}"),
            }
        }

        // 任一成功才写旗标（避免每次启动重跑已注入的）；全失败保持 false 下次重试。
        if ok > 0 {
            // 重读最新设置再合并，最小化 TOCTOU 覆盖用户并发改动。
            let mut latest = settings_state.inner().get();
            latest.samples_seeded = true;
            if let Err(e) = settings_state.inner().update(latest) {
                tracing::warn!("samples_seeded flag persist failed: {e}");
            }
            let _ = app.emit("library://assets-changed", ());
            tracing::info!("samples seeded: {ok}/{}", SAMPLES.len());
        } else {
            tracing::warn!("samples seeding: 0 succeeded, flag not set (will retry next launch)");
        }
    });
}

/// 注入单张示例图：ingest 入库 → 改 source=sample → 预填 caption + auto tag。
/// 同步函数，须在 `spawn_blocking` 内跑（ingest_file 含 image decode + DB 写）。
fn seed_one(
    paths: &LibraryPaths,
    db: &Database,
    source: &Path,
    caption_text: &str,
    tag_names: &[String],
) -> AppResult<()> {
    // 1) 入库（完整 probe/copy/thumb/pHash/colors/dedup）。ingest_file 硬编码 source="imported"，
    //    仿 ingest_from_bytes 在其后手写 UPDATE 改成 sample。
    let asset = ingest::ingest_file(paths, db, source)?;
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET source=?1 WHERE id=?2",
            rusqlite::params![SAMPLE_SOURCE, asset.id],
        )?;
    }
    // 主色：ingest_file 内部已调 link_colors，无需额外处理。

    // 2) caption 预填：不调 codex，纯文本 parse + build_payload + insert。
    //    phash dedup 命中已存 sample 时跳过，避免重复 caption 行。
    if db.has_analysis(&asset.id, "caption")? {
        return Ok(());
    }
    let analysis = caption::parse(caption_text);
    let payload = caption::build_payload(
        caption_text,
        SEED_INSTRUCTION,
        None,
        SAMPLE_SOURCE,
        &analysis,
    );
    let row = Analysis {
        id: ulid::Ulid::new().to_string(),
        asset_id: asset.id.clone(),
        kind: "caption".to_string(),
        payload,
        provider: Some(SAMPLE_SOURCE.to_string()),
        created_at: None,
    };
    db.insert_analysis(&row)?;

    // 3) auto tag：用名字（不硬编码 seed id），get_or_create_tag 幂等命中已 seed 的固定 id。
    let tag_ids: Vec<String> = tag_names
        .iter()
        .filter_map(|n| db.get_or_create_tag(n, "auto").ok())
        .collect();
    if !tag_ids.is_empty() {
        db.set_asset_tags(&asset.id, &tag_ids, "auto")?;
    }

    Ok(())
}

/// 解析示例图目录：dev 走源码 `src-tauri/resources/samples`，release 走 resource_dir/samples。
/// 抄 commands/collect.rs::extension_folder_path 的双分支范式。
fn resolve_samples_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = .../apps/desktop/src-tauri
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("samples")
    } else {
        app.path().resource_dir().ok()?.join("samples")
    };
    dir.is_dir().then_some(dir)
}

/// 在 spawn_blocking 里跑一次 DB 调用（ingest/DB 操作是同步阻塞的）。
/// 抄 core/autoname.rs::db_call 范式。
async fn db_call<T, F>(db: &Arc<Database>, f: F) -> Result<T, String>
where
    F: FnOnce(&Arc<Database>) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let db = db.clone();
    tokio::task::spawn_blocking(move || f(&db))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::LibraryPaths;
    use crate::db::Database;
    use crate::media::phash::testutil::make_photo_file;
    use std::path::PathBuf;
    use ulid::Ulid;

    struct Tmp {
        dir: PathBuf,
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn setup() -> (Tmp, LibraryPaths, Database) {
        let dir = std::env::temp_dir().join(format!("bb-samples-{}", Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = LibraryPaths::init(dir.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        (Tmp { dir }, paths, db)
    }

    #[test]
    fn caption_manifest_parses_as_structured() {
        // 每张示例图的 caption 都应解析为 parse_status="structured"
        // （即 5 个标准维度 composition/light/palette/action/mood 全部映射成功）。
        for spec in SAMPLES {
            let a = caption::parse(spec.caption);
            assert_eq!(
                a.parse_status, "structured",
                "caption for {} did not parse as structured: dims = {:?}",
                spec.filename, a.dimensions
            );
            for key in caption::DIMENSION_KEYS {
                assert!(
                    a.dimensions.contains_key(key),
                    "{} missing dimension {key}",
                    spec.filename
                );
            }
        }
    }

    #[test]
    fn tags_are_in_seed_vocab() {
        // 校验所有 SampleSpec.tags 都在 0005 seed 词表内（防侧栏词表意外膨胀）。
        let vocab = [
            "人像", "风景", "静物", "美食", "动物", "建筑", "抽象", "插画", "室内", "街景",
        ];
        for spec in SAMPLES {
            for t in spec.tags {
                assert!(vocab.contains(t), "tag {t} not in seed vocab",);
            }
        }
    }

    #[test]
    fn seed_one_end_to_end_and_idempotent() {
        let (tmp, paths, db) = setup();
        // make_photo_file 造高熵照片级图（确保能被 find_asset_by_phash dedup）。name 须带扩展名。
        let img = make_photo_file(&tmp.dir, "portrait.png", 256, 7);

        let tags = vec!["人像".to_string()];
        seed_one(&paths, &db, &img, CAPTION_PORTRAIT, &tags).unwrap();

        // 校验入库 + source=sample + caption + auto tag。
        assert_eq!(db.count_assets(None).unwrap(), 1);
        let id: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM assets WHERE source='sample'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(db.has_analysis(&id, "caption").unwrap());
        assert!(db.has_auto_tag(&id).unwrap());

        // 再次 seed 同图：phash dedup 命中已存 sample + has_analysis 跳过 → 不产生重复 caption。
        seed_one(&paths, &db, &img, CAPTION_PORTRAIT, &tags).unwrap();
        assert_eq!(db.count_assets(None).unwrap(), 1);
        let caption_count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM analyses WHERE asset_id=?1 AND kind='caption'",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(caption_count, 1, "重复 seed 不应新增 caption 行");
    }
}
