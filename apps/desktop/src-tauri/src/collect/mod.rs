//! 采集层：浏览器扩展 ↔ 桌面的 WS server（开发计划 §5.2，精简版）。
//!
//! 扩展端用原生 JS（MV3）发 `{type:"save", url, page_url}`，
//! 桌面调 `ingest::ingest_from_url` 下载入库；不做防盗链/断点续传。

pub mod ws_server;
