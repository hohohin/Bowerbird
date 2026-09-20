//! Pass a fully quoted command as an AppleScript argument, never as script source.
use tokio::process::Command;

fn quote(value: &std::ffi::OsStr) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "'\\''"))
}

fn command_line(command: &Command) -> String {
    let command = command.as_std();
    let mut parts = vec!["/usr/bin/env".to_string()];
    // env options must precede assignments and the executable.
    for (name, value) in command.get_envs() {
        if value.is_none() {
            parts.extend(["-u".to_string(), quote(name)]);
        }
    }
    for (name, value) in command.get_envs() {
        if let Some(value) = value {
            let mut assignment = name.to_os_string();
            assignment.push("=");
            assignment.push(value);
            parts.push(quote(&assignment));
        }
    }
    parts.push(quote(command.get_program()));
    parts.extend(command.get_args().map(quote));
    parts.join(" ")
}

pub(super) async fn open(command: &Command) -> std::io::Result<()> {
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg("on run argv\ntell application \"Terminal\"\nactivate\ndo script (item 1 of argv)\nend tell\nend run")
        .arg("--")
        .arg(command_line(command))
        .output()
        .await?;
    if !output.status.success() {
        return Err(std::io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_preserves_arguments_and_private_environment() {
        let value = "Mac user's folder/\"quoted\"/$(printf injected)`printf injected`";
        let mut command = Command::new("/bin/sh");
        command
            .env("BB_TERMINAL_VALUE", value)
            .env_remove("BB_TERMINAL_SHARED");
        command.args([
            "-c",
            "printf '%s\\n%s\\n%s' \"$BB_TERMINAL_VALUE\" \"$1\" \"${BB_TERMINAL_SHARED-unset}\"",
            "fixture",
            value,
        ]);
        let output = std::process::Command::new("/bin/sh")
            .env("BB_TERMINAL_SHARED", "shared")
            .args(["-c", &command_line(&command)])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{value}\n{value}\nunset")
        );
    }
}
