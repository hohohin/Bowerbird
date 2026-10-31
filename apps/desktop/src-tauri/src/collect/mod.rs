//! 采集层：浏览器扩展 ↔ 桌面的 WS server（开发计划 §5.2，精简版）。
//!
//! 旧图片 URL 协议保留；save_blob 接收浏览器取到的真实字节。
//! 视频需先协商能力并显式标记类型；桌面不读取 Cookie、不做断点续传。

pub mod ws_server;
mod video_blob;
