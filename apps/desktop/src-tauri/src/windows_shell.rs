//! Windows Shell accepts ordinary DOS/UNC names at the filesystem boundary.
use std::path::{Component, Path, PathBuf, Prefix};
use windows::{
    core::{HSTRING, Result},
    Win32::{
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{Common::ITEMIDLIST, ILFree, SHOpenFolderAndSelectItems, SHParseDisplayName},
    },
};

pub(crate) fn shell_path(path: &Path) -> PathBuf {
    let mut parts = path.components();
    let mut ordinary = match parts.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", drive as char)),
            Prefix::VerbatimUNC(server, share) => {
                let mut value = PathBuf::from(r"\\");
                value.push(server);
                value.push(share);
                value
            }
            _ => return path.to_path_buf(),
        },
        _ => return path.to_path_buf(),
    };
    for part in parts {
        if part == Component::RootDir {
            if !ordinary.has_root() { ordinary.push(r"\"); }
        } else {
            ordinary.push(part.as_os_str());
        }
    }
    ordinary
}

pub(crate) struct ShellItem(pub(crate) *mut ITEMIDLIST);
impl ShellItem {
    pub(crate) fn parse(path: &Path) -> Result<Self> {
        let mut item = Self(std::ptr::null_mut());
        unsafe {
            SHParseDisplayName(&HSTRING::from(shell_path(path).as_os_str()), None, &mut item.0, 0, None)?;
        }
        Ok(item)
    }
}
impl Drop for ShellItem {
    fn drop(&mut self) { unsafe { ILFree(Some(self.0)); } }
}

pub(crate) fn reveal(path: &Path) -> Result<()> {
    struct Apartment;
    impl Drop for Apartment { fn drop(&mut self) { unsafe { CoUninitialize(); } } }
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?; }
    let _apartment = Apartment;
    let item = ShellItem::parse(path)?;
    // Zero child items means select this absolute item in its parent folder.
    unsafe { SHOpenFolderAndSelectItems(item.0, None, 0) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_paths_preserve_unc_and_special_characters() {
        for (input, expected) in [
            (r"\\?\UNC\server\share\素材, a.jpg", r"\\server\share\素材, a.jpg"),
            (r"\\?\D:\项目 中文, 空格\素材.webp", r"D:\项目 中文, 空格\素材.webp"),
            (r"D:\素材\音频.wav", r"D:\素材\音频.wav"),
        ] {
            assert_eq!(shell_path(Path::new(input)), PathBuf::from(expected));
        }
    }
    #[test]
    fn reveal_reports_missing_original_before_opening_explorer() {
        let temp = tempfile::tempdir().unwrap();
        assert!(reveal(&temp.path().join("不存在.jpg")).is_err());
    }
}
