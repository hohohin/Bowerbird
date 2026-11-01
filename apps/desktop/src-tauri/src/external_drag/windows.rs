use super::{Decision, Gesture};
use std::{cell::RefCell, path::PathBuf};
use windows::{
    core::*,
    Win32::{
        Foundation::*,
        Graphics::Gdi::{DeleteObject, HBITMAP},
        System::{Com::*, Ole::*, SystemServices::*},
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
            Shell::*,
            WindowsAndMessaging::GetCursorPos,
        },
    },
};

pub struct Ole;
impl Ole {
    pub fn enter() -> Result<Self> {
        unsafe {
            OleInitialize(None)?;
        }
        Ok(Self)
    }
}
impl Drop for Ole {
    fn drop(&mut self) {
        unsafe {
            OleUninitialize();
        }
    }
}

#[implement(IDropSource)]
struct Source {
    gesture: RefCell<Gesture>,
}
impl IDropSource_Impl for Source_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        match self.gesture.borrow_mut().update(
            keys.contains(MK_LBUTTON),
            escape.as_bool() || keys.contains(MK_RBUTTON),
        ) {
            Decision::Continue => S_OK,
            Decision::Drop => DRAGDROP_S_DROP,
            Decision::Cancel => DRAGDROP_S_CANCEL,
        }
    }
    fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

pub fn files_data_object(paths: &[PathBuf]) -> Result<IDataObject> {
    struct Item(*mut Common::ITEMIDLIST);
    impl Drop for Item {
        fn drop(&mut self) {
            unsafe {
                ILFree(Some(self.0));
            }
        }
    }
    let mut items = Vec::new();
    for path in paths {
        let mut item = std::ptr::null_mut();
        unsafe {
            SHParseDisplayName(
                &HSTRING::from(shell_path(path).as_os_str()),
                None,
                &mut item,
                0,
                None,
            )?;
        }
        items.push(Item(item));
    }
    let pointers: Vec<_> = items.iter().map(|item| item.0.cast_const()).collect();
    let array = unsafe { SHCreateShellItemArrayFromIDLists(&pointers)? };
    unsafe { array.BindToHandler(None, &BHID_DataObject) }
}

fn shell_path(path: &std::path::Path) -> PathBuf {
    use std::path::{Component, Prefix};
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
            if !ordinary.has_root() {
                ordinary.push(r"\");
            }
        } else {
            ordinary.push(part.as_os_str());
        }
    }
    ordinary
}

pub fn drag(
    paths: &[PathBuf],
    pickup: bool,
    before_start: impl FnOnce() -> bool,
) -> Result<(bool, POINT)> {
    let _ole = Ole::enter()?;
    let data = files_data_object(paths)?;
    let _image = paths.first().and_then(|path| drag_image(&data, path).ok());
    let source: IDropSource = Source {
        gesture: RefCell::new(Gesture::new(pickup)),
    }
    .into();
    if !before_start() || (!pickup && unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } >= 0) {
        let mut position = POINT::default();
        unsafe {
            GetCursorPos(&mut position)?;
        }
        return Ok((false, position));
    }
    let mut effect = DROPEFFECT::default();
    let result = unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) };
    result.ok()?;
    let mut position = POINT::default();
    unsafe {
        GetCursorPos(&mut position)?;
    }
    Ok((
        result == DRAGDROP_S_DROP && effect == DROPEFFECT_COPY,
        position,
    ))
}

struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}
fn drag_image(data: &IDataObject, path: &std::path::Path) -> Result<Bitmap> {
    // Shell icon only: do not decode a large original just to initiate a drag.
    unsafe {
        let item: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(shell_path(path).as_os_str()), None)?;
        let size = SIZE { cx: 48, cy: 48 };
        let bitmap = Bitmap(item.GetImage(size, SIIGBF_ICONONLY)?);
        let helper: IDragSourceHelper =
            CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER)?;
        helper.InitializeFromBitmap(
            &SHDRAGIMAGE {
                sizeDragImage: size,
                ptOffset: POINT { x: 12, y: 12 },
                hbmpDragImage: bitmap.0,
                crColorKey: COLORREF(0xFFFFFFFF),
            },
            data,
        )?;
        Ok(bitmap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_paths_preserve_unc_server_and_share() {
        assert_eq!(
            shell_path(std::path::Path::new(r"\\?\UNC\server\share\素材.png")),
            PathBuf::from(r"\\server\share\素材.png")
        );
        assert_eq!(
            shell_path(std::path::Path::new(r"\\?\D:\素材\音频.wav")),
            PathBuf::from(r"D:\素材\音频.wav")
        );
    }
    #[test]
    fn shell_data_object_delivers_original_unicode_paths_as_hdrop() {
        let temp = tempfile::tempdir().unwrap();
        let paths: Vec<_> = ["中文 image.png", "audio.wav"]
            .iter()
            .map(|name| {
                let p = temp.path().join(name);
                std::fs::write(&p, b"synthetic only").unwrap();
                p.canonicalize().unwrap()
            })
            .collect();
        let _ole = Ole::enter().unwrap();
        let object = files_data_object(&paths).unwrap();
        let format = FORMATETC {
            cfFormat: CF_HDROP.0,
            dwAspect: DVASPECT_CONTENT.0,
            tymed: TYMED_HGLOBAL.0 as u32,
            ..Default::default()
        };
        let mut medium = unsafe { object.GetData(&format) }.unwrap();
        let drop = HDROP(unsafe { medium.u.hGlobal }.0);
        let count = unsafe { DragQueryFileW(drop, u32::MAX, None) };
        let actual: Vec<_> = (0..count)
            .map(|i| {
                let len = unsafe { DragQueryFileW(drop, i, None) };
                let mut buf = vec![0u16; len as usize + 1];
                unsafe {
                    DragQueryFileW(drop, i, Some(&mut buf));
                }
                PathBuf::from(String::from_utf16(&buf[..len as usize]).unwrap())
            })
            .collect();
        unsafe {
            ReleaseStgMedium(&mut medium);
        }
        assert_eq!(
            actual
                .iter()
                .map(|p| p.canonicalize().unwrap())
                .collect::<Vec<_>>(),
            paths
        );
        for path in paths {
            assert_eq!(std::fs::read(path).unwrap(), b"synthetic only");
        }
    }
}
