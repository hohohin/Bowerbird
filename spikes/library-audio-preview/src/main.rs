use anyhow::{bail, Context, Result};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let input = args.next().map(PathBuf::from).context("usage: library-audio-preview <input> --cache-dir <dir> [--output <json>] [--source-version <revision>] [--cancel-file <path>]")?;
    let mut cache = None;
    let mut output = None;
    let mut version = None;
    let mut cancel = None;
    while let Some(flag) = args.next() {
        let value = args.next().context("option requires a value")?;
        match flag.to_str() {
            Some("--cache-dir") => cache = Some(PathBuf::from(value)),
            Some("--output") => output = Some(PathBuf::from(value)),
            Some("--source-version") => {
                version = Some(
                    value
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("revision must be UTF-8"))?,
                )
            }
            Some("--cancel-file") => cancel = Some(PathBuf::from(value)),
            _ => bail!("unknown option: {}", flag.to_string_lossy()),
        }
    }
    let cache = cache.context("--cache-dir is required")?;
    if let Some(output) = &output {
        if fs::canonicalize(output).ok().as_ref() == Some(&fs::canonicalize(&input)?) {
            bail!("output must not overwrite the original audio");
        }
    }
    let value = library_audio_preview::preview(&input, &cache, version.as_deref(), &|| {
        cancel.as_ref().is_some_and(|path| path.exists())
    })?;
    let json = serde_json::to_string(&value)?;
    if let Some(output) = output {
        let parent = output
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(json.as_bytes())?;
        temporary.flush()?;
        temporary.persist(output).map_err(|error| error.error)?;
    }
    println!("{json}");
    Ok(())
}
