//! 核心运行时：库路径 / 导入流水线 / 资源库 CRUD / 任务队列。

pub mod autoname;
pub mod caption;
pub mod creative_session_contract;
pub mod generation_worker;
pub mod ingest;
pub mod library;
pub mod library_view;
pub mod local_classification;
pub mod migrate;
pub mod onboarding_pack;
pub mod paths;
pub mod preset;
pub mod project_canvas;
pub mod project_canvas_backfill;
pub mod projects;
pub mod samples;
pub mod settings;
pub mod task_queue;
pub mod visual_profile;

pub mod project_deletion;
