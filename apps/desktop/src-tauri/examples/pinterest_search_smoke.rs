fn main() {
    #[cfg(debug_assertions)]
    bowerbird_desktop_lib::run_pinterest_search_fixture();
    #[cfg(not(debug_assertions))]
    panic!("fixture must never run in a release build");
}
