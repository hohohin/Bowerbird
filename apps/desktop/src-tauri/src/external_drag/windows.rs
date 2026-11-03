use super::{Decision, Gesture};
use std::{cell::RefCell, path::PathBuf};
use windows::{
    core::*,
    Win32::{
        Foundation::*,
        Graphics::Gdi::{
            CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
            HBITMAP,
        },
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
    drag_with_image(paths, pickup, None, before_start)
}

pub fn drag_with_image(
    paths: &[PathBuf],
    pickup: bool,
    preview: Option<&super::preview::DragImage>,
    before_start: impl FnOnce() -> bool,
) -> Result<(bool, POINT)> {
    let _ole = Ole::enter()?;
    let data = files_data_object(paths)?;
    let _image = preview
        .and_then(|image| thumbnail_image(&data, image).ok())
        .or_else(|| paths.first().and_then(|path| drag_image(&data, path).ok()));
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
// InitializeFromBitmap consumes the HBITMAP on success; never retain a stale GDI handle.
fn attach_image(data: &IDataObject, bitmap: Bitmap, size: SIZE, offset: POINT) -> Result<()> {
    unsafe {
        let helper: IDragSourceHelper =
            CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER)?;
        helper.InitializeFromBitmap(
            &SHDRAGIMAGE {
                sizeDragImage: size,
                ptOffset: offset,
                hbmpDragImage: bitmap.0,
                crColorKey: COLORREF(0xFFFFFFFF),
            },
            data,
        )?;
    }
    std::mem::forget(bitmap);
    Ok(())
}
fn drag_image(data: &IDataObject, path: &std::path::Path) -> Result<()> {
    unsafe {
        let item: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(shell_path(path).as_os_str()), None)?;
        let size = SIZE { cx: 48, cy: 48 };
        let bitmap = Bitmap(item.GetImage(size, SIIGBF_ICONONLY)?);
        attach_image(data, bitmap, size, POINT { x: 12, y: 12 })
    }
}
fn thumbnail_bitmap(image: &super::preview::DragImage) -> Result<Bitmap> {
    unsafe {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: image.width as i32,
                biHeight: -(image.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = std::ptr::null_mut();
        let bitmap = Bitmap(CreateDIBSection(
            None,
            &info,
            DIB_RGB_COLORS,
            &mut pixels,
            None,
            0,
        )?);
        let target = std::slice::from_raw_parts_mut(pixels.cast::<u8>(), image.rgba.len());
        for (rgba, bgra) in image.rgba.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
            bgra.copy_from_slice(&[rgba[2], rgba[1], rgba[0], rgba[3]]);
        }
        Ok(bitmap)
    }
}
fn thumbnail_image(data: &IDataObject, image: &super::preview::DragImage) -> Result<()> {
    attach_image(
        data,
        thumbnail_bitmap(image)?,
        SIZE {
            cx: image.width as i32,
            cy: image.height as i32,
        },
        POINT {
            x: -(18.0 * image.scale) as i32,
            y: -(18.0 * image.scale) as i32,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_thumbnail_initializes_shell_helper_with_real_bitmap_dimensions() {
        use windows::Win32::Graphics::Gdi::{GetObjectW, DIBSECTION};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("preview.png");
        image::RgbaImage::from_pixel(80, 120, image::Rgba([10, 30, 90, 255]))
            .save(&path)
            .unwrap();
        let preview = super::super::preview::load(&path, 1.0, false).unwrap();
        let _ole = Ole::enter().unwrap();
        let object = files_data_object(&[path]).unwrap();
        let bitmap = thumbnail_bitmap(&preview).unwrap();
        let mut info = DIBSECTION::default();
        let read = unsafe {
            GetObjectW(
                bitmap.0.into(),
                std::mem::size_of::<DIBSECTION>() as i32,
                Some((&mut info as *mut DIBSECTION).cast()),
            )
        };
        assert!(read > 0);
        assert_eq!((info.dsBm.bmWidth, info.dsBm.bmHeight), (80, 120));
        let bytes = unsafe {
            std::slice::from_raw_parts(info.dsBm.bmBits.cast::<u8>(), preview.rgba.len())
        };
        assert_eq!(
            &bytes[(20 * 80 + 20) * 4..][..4],
            &[90, 30, 10, 255],
            "top-down native BGRA retains original color"
        );
        thumbnail_image(&object, &preview).unwrap();
        let format = FORMATETC {
            cfFormat: unsafe {
                windows::Win32::System::DataExchange::RegisterClipboardFormatW(w!("DragImageBits"))
            } as u16,
            dwAspect: DVASPECT_CONTENT.0,
            tymed: TYMED_HGLOBAL.0 as u32,
            ..Default::default()
        };
        let mut medium = unsafe { object.GetData(&format) }
            .expect("Shell stores thumbnail pixels in the drag data object");
        unsafe {
            ReleaseStgMedium(&mut medium);
        }
    }

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
