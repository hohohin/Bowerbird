use std::path::PathBuf;

fn usage() -> ! {
    eprintln!(
        "usage:\n  project_canvas_backfill preview <library.db>\n  project_canvas_backfill backup-copy <source.db> <destination.db>\n  project_canvas_backfill run-copy <library.db>"
    );
    std::process::exit(2);
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(mode) = args.next().and_then(|value| value.into_string().ok()) else {
        usage();
    };
    let Some(path) = args.next().map(PathBuf::from) else {
        usage();
    };

    let result = match mode.as_str() {
        "preview" if args.next().is_none() => {
            bowerbird_desktop_lib::project_canvas_backfill_preview_file(&path)
        }
        "backup-copy" => {
            let Some(destination) = args.next().map(PathBuf::from) else {
                usage();
            };
            if args.next().is_some() {
                usage();
            }
            bowerbird_desktop_lib::project_canvas_backfill_backup_copy(&path, &destination)
        }
        "run-copy" if args.next().is_none() => {
            bowerbird_desktop_lib::project_canvas_backfill_run_copy(&path)
        }
        _ => usage(),
    };
    match result {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("project_canvas_backfill: {error}");
            std::process::exit(1);
        }
    }
}
