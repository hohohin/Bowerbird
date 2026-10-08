#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = bowerbird_desktop_lib::agent_generation_wait_worker() {
        std::process::exit(code);
    }
    if let Some(code) = bowerbird_desktop_lib::video_thumbnail_worker() {
        std::process::exit(code);
    }
    if std::env::args().nth(1).as_deref() == Some("--reset-install-auth") {
        std::process::exit(bowerbird_desktop_lib::reset_install_auth());
    }
    bowerbird_desktop_lib::run();
}
