// Standalone synthetic registry client; never opens a provider credential key.
use std::ffi::c_void;
#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(key: isize, name: *const u16, reserved: u32, class: *const u16,
        options: u32, access: u32, security: *const c_void, out: *mut isize, disposition: *mut u32) -> i32;
    fn RegSetValueExW(key: isize, name: *const u16, reserved: u32, kind: u32, bytes: *const u8, count: u32) -> i32;
    fn RegQueryValueExW(key: isize, name: *const u16, reserved: *mut u32, kind: *mut u32, bytes: *mut u8, count: *mut u32) -> i32;
    fn RegCloseKey(key: isize) -> i32;
}
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args[1].chars().all(|c| c.is_ascii_alphanumeric()));
    let name = wide(&format!("Software\\Bowerbird\\CliAuthTestsProbe\\{}", args[1]));
    let value = wide("sentinel");
    let mut key = 0;
    unsafe {
        assert_eq!(RegCreateKeyExW(0x80000001u32 as i32 as isize, name.as_ptr(), 0, std::ptr::null(),
            0, 0xf003f, std::ptr::null(), &mut key, std::ptr::null_mut()), 0);
        if let Some(text) = args.get(2) {
            let bytes = wide(text);
            assert_eq!(RegSetValueExW(key, value.as_ptr(), 0, 1, bytes.as_ptr().cast(), (bytes.len() * 2) as u32), 0);
        }
        let mut bytes = vec![0u16; 100];
        let mut count = 200;
        let result = RegQueryValueExW(key, value.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut(), bytes.as_mut_ptr().cast(), &mut count);
        if result == 2 { println!("absent"); } else {
            assert_eq!(result, 0);
            println!("{}", String::from_utf16_lossy(&bytes[..count as usize / 2 - 1]));
        }
        RegCloseKey(key);
    }
}
