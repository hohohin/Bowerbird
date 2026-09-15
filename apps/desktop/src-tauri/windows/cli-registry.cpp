// Loaded only in the Dreamina child created by cli-launcher.cpp.
// Registry APIs are redirected inside that process, never in the user's CLI.
#include <windows.h>
#include <wchar.h>

BOOL WINAPI DllMain(HINSTANCE, DWORD reason, LPVOID) {
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    wchar_t scope[256] = {};
    if (!GetEnvironmentVariableW(L"BOWERBIRD_DREAMINA_REGISTRY", scope, 256)) return FALSE;
    const wchar_t* testPrefix = L"Software\\Bowerbird\\CliAuthTests\\";
    if (wcscmp(scope, L"Software\\Bowerbird\\CliAuth\\Dreamina") != 0 &&
        wcsncmp(scope, testPrefix, wcslen(testPrefix)) != 0) return FALSE;
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, scope, 0, nullptr, 0, KEY_ALL_ACCESS,
                        nullptr, &key, nullptr) != ERROR_SUCCESS) return FALSE;
    const LSTATUS result = RegOverridePredefKey(HKEY_CURRENT_USER, key);
    RegCloseKey(key);
    return result == ERROR_SUCCESS;
}
