#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--reset-install-auth") {
        std::process::exit(bowerbird_desktop_lib::reset_install_auth());
    }
    bowerbird_desktop_lib::run();
}
