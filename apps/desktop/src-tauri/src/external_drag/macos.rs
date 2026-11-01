use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::PathBuf,
};
use tokio::sync::oneshot;

type Completion = oneshot::Sender<Result<bool, String>>;

struct Context {
    sender: Completion,
    before_start: Option<Box<dyn FnOnce() -> bool>>,
}

#[link(name = "bowerbird_external_drag", kind = "static")]
extern "C" {
    fn bb_start_file_drag(
        window: *mut c_void,
        paths: *const *const c_char,
        count: usize,
        pickup: bool,
        context: *mut c_void,
        before_start: unsafe extern "C" fn(*mut c_void) -> bool,
        callback: unsafe extern "C" fn(*mut c_void, bool, *const c_char),
    );
}

unsafe extern "C" fn before_start(context: *mut c_void) -> bool {
    // This gate runs on the main thread after native preparation. It borrows the
    // context; only completed may reclaim it, including when this gate declines.
    let context = unsafe { &mut *context.cast::<Context>() };
    context.before_start.take().is_some_and(|start| start())
}

unsafe extern "C" fn completed(context: *mut c_void, dropped: bool, error: *const c_char) {
    // The bridge returns ownership exactly once. Copy its borrowed error before
    // returning to Objective-C, including when the awaiting command was cancelled.
    let Context { sender, .. } = unsafe { *Box::from_raw(context.cast::<Context>()) };
    let result = if error.is_null() {
        Ok(dropped)
    } else {
        Err(unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned())
    };
    let _ = sender.send(result);
}

/// Call on Tauri's main thread. Native failure/end completes sender exactly once.
/// The pickup gesture still requires macOS native acceptance; see the .m bridge.
pub fn start(
    window: &tauri::Window,
    paths: &[PathBuf],
    pickup: bool,
    sender: Completion,
    should_start: impl FnOnce() -> bool + 'static,
) {
    let native_window = match window.ns_window() {
        Ok(window) => window,
        Err(error) => {
            tracing::warn!(%error, "cannot get macOS window for external drag");
            let _ = sender.send(Err("无法开始拖动，请重试。".into()));
            return;
        }
    };
    let strings = paths
        .iter()
        .map(|path| {
            let path = path
                .to_str()
                .ok_or_else(|| "无法读取素材位置，请重新连接原文件。".to_string())?;
            CString::new(path).map_err(|_| "无法读取素材位置，请重新连接原文件。".to_string())
        })
        .collect::<Result<Vec<_>, _>>();
    let strings = match strings {
        Ok(strings) => strings,
        Err(error) => {
            let _ = sender.send(Err(error));
            return;
        }
    };
    let pointers = strings.iter().map(|path| path.as_ptr()).collect::<Vec<_>>();
    let context = Box::into_raw(Box::new(Context {
        sender,
        before_start: Some(Box::new(should_start)),
    }))
    .cast::<c_void>();
    // No raw native window pointer crosses a thread; C copies all paths before
    // returning and takes ownership of context even when startup fails.
    unsafe {
        bb_start_file_drag(
            native_window,
            pointers.as_ptr(),
            pointers.len(),
            pickup,
            context,
            before_start,
            completed,
        );
    }
}
