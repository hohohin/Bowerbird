//! 采集层：浏览器扩展 ↔ 桌面的 WS server（开发计划 §5.2，精简版）。
//!
//! 扩展端用原生 JS（MV3）发 `save` / `save_batch`，桌面下载器带 UA/Referer、
//! 按内容识别图片格式并走统一 ingest；不读取 Cookie、不做断点续传。

pub mod ws_server;
