// Run only our newly created child in a private HKCU namespace. No attachment to
// an existing process, binary patching, or changes to the global Dreamina store.
#include <windows.h>
#include <string>
#include <vector>
#include <stdio.h>

static std::wstring quote(const wchar_t* arg) {
    std::wstring out = L"\"";
    size_t slashes = 0;
    for (; *arg; ++arg) {
        if (*arg == L'\\') { ++slashes; continue; }
        out.append(slashes * (*arg == L'"' ? 2 : 1), L'\\');
        if (*arg == L'"') out += L'\\';
        out += *arg;
        slashes = 0;
    }
    out.append(slashes * 2, L'\\');
    return out + L'"';
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) return 125;
    const bool plain = wcscmp(argv[1], L"--plain") == 0;
    const int first = plain ? 2 : 1;
    if (argc <= first) return 125;
    wchar_t self[32768];
    const DWORD length = GetModuleFileNameW(nullptr, self, 32768);
    if (!length || length >= 32768) return 125;
    std::wstring dll(self, length);
    dll.resize(dll.find_last_of(L"\\/") + 1);
    dll += L"cli-registry.dll";
    std::wstring args;
    for (int i = first; i < argc; ++i) {
        if (i > first) args += L' ';
        args += quote(argv[i]);
    }
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        if (job) CloseHandle(job);
        return 125;
    }
    STARTUPINFOW startup = { sizeof(startup) };
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child = {};
    // The quoted first token selects the executable and preserves normal Windows
    // search semantics for cmd.exe (used by npm's .cmd shim).
    if (!CreateProcessW(nullptr, args.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED,
                        nullptr, nullptr, &startup, &child)) {
        CloseHandle(job);
        fwprintf(stderr, L"Bowerbird: cannot start isolated CLI (%lu)\n", GetLastError());
        return 125;
    }
    bool ready = AssignProcessToJobObject(job, child.hProcess) != FALSE;
    const SIZE_T size = (dll.size() + 1) * sizeof(wchar_t);
    void* remote = ready && !plain ? VirtualAllocEx(child.hProcess, nullptr, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE) : nullptr;
    if (!plain) ready = remote && WriteProcessMemory(child.hProcess, remote, dll.c_str(), size, nullptr);
    HANDLE loader = nullptr;
    if (ready && !plain) {
        const auto load = reinterpret_cast<LPTHREAD_START_ROUTINE>(
            GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW"));
        loader = CreateRemoteThread(child.hProcess, nullptr, 0, load, remote, 0, nullptr);
        DWORD result = 0;
        ready = loader && WaitForSingleObject(loader, 30000) == WAIT_OBJECT_0 &&
                GetExitCodeThread(loader, &result) && result != 0;
    }
    if (loader) CloseHandle(loader);
    if (ready && remote) VirtualFreeEx(child.hProcess, remote, 0, MEM_RELEASE);
    if (ready) ready = ResumeThread(child.hThread) != static_cast<DWORD>(-1);
    DWORD code = 125;
    if (ready) {
        if (WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0)
            GetExitCodeProcess(child.hProcess, &code);
    } else {
        TerminateProcess(child.hProcess, 125);
        fwprintf(stderr, L"Bowerbird: private CLI credentials unavailable; shared login was not used.\n");
    }
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    CloseHandle(job);
    return static_cast<int>(code);
}
