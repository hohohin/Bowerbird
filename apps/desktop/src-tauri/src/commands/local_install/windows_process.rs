use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::{File, OpenOptions},
    io,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::{Command, ExitStatus},
};

use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{DuplicateHandle, HANDLE, DUPLICATE_SAME_ACCESS, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::{
            JobObjects::{
                CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
                JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            SystemInformation::GetSystemDirectoryW,
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
                InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
                CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
                LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
            },
        },
    },
};

pub(crate) struct ManagedChild {
    job: OwnedHandle,
    process: OwnedHandle,
    pid: u32,
}

impl ManagedChild {
    pub(crate) fn id(&self) -> u32 { self.pid }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_for(0)
    }

    pub(crate) fn kill_and_wait(&mut self) -> io::Result<()> {
        // Even a launcher that has exited can have live children in the job.
        unsafe { TerminateJobObject(raw_handle(&self.job), 1) }.map_err(io::Error::from)?;
        if self.wait_for(5000)?.is_none() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "owned installer process did not exit within five seconds"));
        }
        Ok(())
    }

    fn wait_for(&self, milliseconds: u32) -> io::Result<Option<ExitStatus>> {
        let process = raw_handle(&self.process);
        match unsafe { WaitForSingleObject(process, milliseconds) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                unsafe { GetExitCodeProcess(process, &mut code) }.map_err(io::Error::from)?;
                Ok(Some(ExitStatus::from_raw(code)))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }
}

fn raw_handle(handle: &impl AsRawHandle) -> HANDLE { HANDLE(handle.as_raw_handle()) }

fn inheritable_handle(file: &File) -> io::Result<OwnedHandle> {
    let mut duplicate = HANDLE::default();
    unsafe {
        let current = GetCurrentProcess();
        DuplicateHandle(current, raw_handle(file), current, &mut duplicate, 0, true, DUPLICATE_SAME_ACCESS)
            .map_err(io::Error::from)?;
        Ok(OwnedHandle::from_raw_handle(duplicate.0))
    }
}

struct Attributes {
    _storage: Vec<usize>,
    ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        // The size query is documented to return ERROR_INSUFFICIENT_BUFFER.
        let sizing = unsafe { InitializeProcThreadAttributeList(None, 2, None, &mut bytes) };
        if bytes == 0 {
            sizing.map_err(io::Error::from)?;
            return Err(io::Error::other("could not size process attributes"));
        }
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        let ptr = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
        unsafe { InitializeProcThreadAttributeList(Some(ptr), 2, None, &mut bytes) }
            .map_err(io::Error::from)?;
        Ok(Self { _storage: storage, ptr })
    }

    fn set(&self, attribute: u32, handles: &[HANDLE]) -> io::Result<()> {
        unsafe {
            UpdateProcThreadAttribute(self.ptr, 0, attribute as usize,
                Some(handles.as_ptr().cast()), std::mem::size_of_val(handles), None, None)
        }.map_err(io::Error::from)
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.ptr) };
    }
}

pub(super) fn system_program(name: &OsStr) -> io::Result<PathBuf> {
    let mut buffer = [0; 260];
    let count = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if count == 0 { return Err(io::Error::last_os_error()); }
    if count >= buffer.len() { return Err(io::Error::other("system directory path is too long")); }
    let root = PathBuf::from(OsString::from_wide(&buffer[..count]));
    if name.eq_ignore_ascii_case(OsStr::new("powershell.exe")) {
        return Ok(root.join("WindowsPowerShell/v1.0/powershell.exe"));
    }
    Ok(root.join(name))
}

fn wide(text: &OsStr) -> io::Result<Vec<u16>> {
    let text: Vec<u16> = text.encode_wide().collect();
    if text.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "process parameter contains a NUL"));
    }
    Ok(text)
}

fn terminated(text: &OsStr) -> io::Result<Vec<u16>> {
    let mut text = wide(text)?;
    text.push(0);
    Ok(text)
}

fn append_argument(line: &mut Vec<u16>, text: &OsStr) -> io::Result<()> {
    const QUOTE: u16 = b'"' as u16;
    const SLASH: u16 = b'\\' as u16;
    line.push(QUOTE);
    let mut slashes = 0;
    for ch in wide(text)? {
        if ch == SLASH {
            slashes += 1;
            continue;
        }
        let count = if ch == QUOTE { slashes * 2 + 1 } else { slashes };
        line.extend(std::iter::repeat_n(SLASH, count));
        line.push(ch);
        slashes = 0;
    }
    line.extend(std::iter::repeat_n(SLASH, slashes * 2));
    line.push(QUOTE);
    Ok(())
}

fn environment(command: &Command) -> io::Result<Option<Vec<u16>>> {
    if command.get_envs().len() == 0 { return Ok(None); }
    // The installer only changes explicitly named variables via env/env_remove.
    let key = |name: &OsStr| name.to_string_lossy().to_uppercase();
    let mut values: BTreeMap<_, _> = std::env::vars_os()
        .map(|(name, value)| (key(&name), (name, value))).collect();
    for (name, value) in command.get_envs() {
        if let Some(value) = value {
            values.insert(key(name), (name.to_owned(), value.to_owned()));
        } else {
            values.remove(&key(name));
        }
    }
    let mut block = Vec::new();
    for (_, (name, value)) in values {
        block.extend(wide(&name)?);
        block.push(b'=' as u16);
        block.extend(terminated(&value)?);
    }
    if block.is_empty() { block.push(0); }
    block.push(0);
    Ok(Some(block))
}

/// Installer-owned commands use explicit paths or a system executable such as tar.exe.
/// The job handle remains non-inheritable and lives exclusively in the desktop process.
pub(crate) fn spawn_managed(command: &mut Command, log: Option<&File>) -> io::Result<ManagedChild> {
    let program = Path::new(command.get_program());
    let executable = if program.components().count() == 1 {
        system_program(program.as_os_str())?
    } else {
        std::path::absolute(program)?
    };
    let application = terminated(executable.as_os_str())?;
    let mut arguments = Vec::new();
    append_argument(&mut arguments, executable.as_os_str())?;
    for argument in command.get_args() {
        arguments.push(b' ' as u16);
        append_argument(&mut arguments, argument)?;
    }
    arguments.push(0);
    let current_dir = command.get_current_dir().map(|path| terminated(path.as_os_str())).transpose()?;
    let environment = environment(command)?;

    let job = unsafe {
        let handle = CreateJobObjectW(None, PCWSTR::null()).map_err(io::Error::from)?;
        let job = OwnedHandle::from_raw_handle(handle.0);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(handle, JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32)
            .map_err(io::Error::from)?;
        job
    };

    let null = OpenOptions::new().read(true).write(true).open("NUL")?;
    let stdin = inheritable_handle(&null)?;
    let output = inheritable_handle(log.unwrap_or(&null))?;
    let jobs = [raw_handle(&job)];
    let handles = [raw_handle(&stdin), raw_handle(&output)];
    let attributes = Attributes::new()?;
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[1];
    startup.lpAttributeList = attributes.ptr;
    let mut information = PROCESS_INFORMATION::default();
    unsafe {
        // JOB_LIST binds the new process before it can run or start descendants.
        // HANDLE_LIST restricts inheritance to the two configured file handles.
        CreateProcessW(PCWSTR(application.as_ptr()), Some(PWSTR(arguments.as_mut_ptr())), None, None, true,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ref().map(|block| block.as_ptr().cast()),
            PCWSTR(current_dir.as_ref().map_or(std::ptr::null(), |path| path.as_ptr())),
            &startup.StartupInfo, &mut information)
            .map_err(io::Error::from)?;
        drop(OwnedHandle::from_raw_handle(information.hThread.0));
        Ok(ManagedChild { job, process: OwnedHandle::from_raw_handle(information.hProcess.0), pid: information.dwProcessId })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{time::{Duration, Instant}, thread};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

    const QUOTED_ARGUMENT: &str = "含 空格\\\"引号\\";

    #[test]
    fn job_test_child() {
        let Some(path) = std::env::var_os("BOWERBIRD_TEST_JOB_PROBE_PATH") else { return; };
        assert_eq!(std::env::args_os().last().as_deref(), Some(OsStr::new(QUOTED_ARGUMENT)));
        let path = PathBuf::from(path);
        assert_eq!(std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap(),
            std::fs::canonicalize(path.parent().unwrap()).unwrap());
        let child = super::super::command(system_program(OsStr::new("ping.exe")).unwrap())
            .args(["-n", "90", "127.0.0.1"]).spawn().unwrap();
        eprintln!("managed test process started");
        std::fs::write(path, child.id().to_string()).unwrap();
        thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn closing_the_desktop_job_handle_terminates_both_processes() {
        let scratch = tempfile::tempdir().unwrap();
        let probe = scratch.path().join("子 进程.pid");
        let path = std::env::current_exe().unwrap();
        let (_, module) = module_path!().split_once("::").unwrap();
        let child_test = format!("{module}::job_test_child");
        let mut command = Command::new(path);
        command.args(["--nocapture", "--exact", &child_test, QUOTED_ARGUMENT])
            .current_dir(scratch.path())
            .env("BOWERBIRD_TEST_JOB_PROBE_PATH", &probe);
        let log_path = scratch.path().join("test.log");
        let log = File::create(&log_path).unwrap();
        let mut child = spawn_managed(&mut command, Some(&log)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let grandchild_pid = loop {
            if let Some(pid) = std::fs::read_to_string(&probe).ok().and_then(|value| value.parse::<u32>().ok()) { break pid; }
            let log_tail = || super::super::log_tail(&log_path, 4096, 0);
            assert!(child.try_wait().unwrap().is_none(), "installer subprocess exited: {}", log_tail());
            assert!(Instant::now() < deadline, "installer subprocess did not start: {}", log_tail());
            thread::sleep(Duration::from_millis(30));
        };
        let open = |pid| unsafe {
            OwnedHandle::from_raw_handle(OpenProcess(PROCESS_SYNCHRONIZE, false, pid).unwrap().0)
        };
        let root = open(child.id());
        let grandchild = open(grandchild_pid);
        assert_eq!(unsafe { WaitForSingleObject(raw_handle(&grandchild), 0) }, WAIT_TIMEOUT);
        drop(child);
        assert_eq!(unsafe { WaitForSingleObject(raw_handle(&root), 5000) }, WAIT_OBJECT_0);
        assert_eq!(unsafe { WaitForSingleObject(raw_handle(&grandchild), 5000) }, WAIT_OBJECT_0);
        assert!(super::super::log_tail(&log_path, 4096, 0).contains("managed test process started"));
    }
}
