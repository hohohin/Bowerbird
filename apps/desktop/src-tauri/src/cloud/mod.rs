//! Bowerbird Cloud 客户端边界。
//!
//! 本模块只保存公开配置与 HTTP client。service-role、方舟和支付密钥只能存在于
//! Edge Functions；桌面端永远不持有这些机密。官方 URL/publishable key 在构建时内置。

pub mod auth;
pub mod client;
pub mod config;
pub mod entitlement;
pub mod policy;
pub mod visual_profile;

pub use auth::AuthClient;
pub use client::CloudClient;
pub use entitlement::EntitlementService;
