#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static const char MAGIC[16] = "CICPACKV033FULL!";
static DWORD payload_error = ERROR_SUCCESS;
static int payload_stage = 0;

static void fail(const wchar_t *message) {
    MessageBoxW(NULL, message, L"内容智能白板启动失败", MB_OK | MB_ICONERROR);
}

static int file_exists(const wchar_t *path) {
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static int write_payload(const wchar_t *self, const wchar_t *zip_path) {
    HANDLE input = INVALID_HANDLE_VALUE, output = INVALID_HANDLE_VALUE;
    LARGE_INTEGER size, position;
    BYTE footer[24], signature[4];
    BYTE *buffer = NULL;
    DWORD count = 0;
    uint64_t payload_size = 0, remaining = 0;
    int ok = 0;
    payload_error = ERROR_SUCCESS;
    payload_stage = 1;
    input = CreateFileW(self, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (input == INVALID_HANDLE_VALUE) { payload_error = GetLastError(); goto cleanup; }
    payload_stage = 2;
    if (!GetFileSizeEx(input, &size) || size.QuadPart < 24) { payload_error = GetLastError(); goto cleanup; }
    position.QuadPart = size.QuadPart - 24;
    if (!SetFilePointerEx(input, position, NULL, FILE_BEGIN) ||
        !ReadFile(input, footer, sizeof(footer), &count, NULL) || count != sizeof(footer)) {
        payload_error = GetLastError(); goto cleanup;
    }
    memcpy(&payload_size, footer, 8);
    payload_stage = 3;
    if (memcmp(footer + 8, MAGIC, 16) != 0 || payload_size == 0 ||
        payload_size > (uint64_t)(size.QuadPart - 24)) goto cleanup;
    position.QuadPart = size.QuadPart - 24 - (LONGLONG)payload_size;
    if (!SetFilePointerEx(input, position, NULL, FILE_BEGIN) ||
        !ReadFile(input, signature, sizeof(signature), &count, NULL) || count != sizeof(signature) ||
        memcmp(signature, "PK\x03\x04", 4) != 0) { payload_error = GetLastError(); goto cleanup; }
    if (!SetFilePointerEx(input, position, NULL, FILE_BEGIN)) { payload_error = GetLastError(); goto cleanup; }
    payload_stage = 4;
    DeleteFileW(zip_path);
    output = CreateFileW(zip_path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (output == INVALID_HANDLE_VALUE) { payload_error = GetLastError(); goto cleanup; }
    buffer = (BYTE *)HeapAlloc(GetProcessHeap(), 0, 1024 * 1024);
    if (!buffer) { payload_error = ERROR_NOT_ENOUGH_MEMORY; goto cleanup; }
    remaining = payload_size;
    payload_stage = 5;
    while (remaining) {
        DWORD request = remaining > 1024 * 1024 ? 1024 * 1024 : (DWORD)remaining;
        DWORD read_count = 0, written = 0;
        if (!ReadFile(input, buffer, request, &read_count, NULL) || read_count == 0 ||
            !WriteFile(output, buffer, read_count, &written, NULL) || written != read_count) {
            payload_error = GetLastError(); goto cleanup;
        }
        remaining -= read_count;
    }
    ok = FlushFileBuffers(output);
    if (!ok) payload_error = GetLastError();
cleanup:
    if (buffer) HeapFree(GetProcessHeap(), 0, buffer);
    if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    if (!ok) DeleteFileW(zip_path);
    return ok;
}

static int run_and_wait(wchar_t *command) {
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    if (!CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &startup, &process)) {
        return 0;
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return code == 0;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
    (void)instance; (void)previous; (void)arguments; (void)show;
    wchar_t self[MAX_PATH];
    wchar_t local[MAX_PATH];
    if (!GetModuleFileNameW(NULL, self, MAX_PATH) ||
        !GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH)) {
        fail(L"无法定位程序或本地用户目录。");
        return 1;
    }

    wchar_t self_dir[MAX_PATH];
    wchar_t portable_home[MAX_PATH];
    wcscpy(self_dir, self);
    wchar_t *separator = wcsrchr(self_dir, L'\\');
    if (separator) *separator = L'\0';
    swprintf(portable_home, MAX_PATH, L"%ls\\ContentIntelligenceCanvas_Data", self_dir);
    SetEnvironmentVariableW(L"CIC_PORTABLE_HOME", portable_home);

    wchar_t app_root[MAX_PATH];
    wchar_t runtime[MAX_PATH];
    wchar_t ready[MAX_PATH];
    wchar_t zip_path[MAX_PATH];
    swprintf(app_root, MAX_PATH, L"%ls\\ContentIntelligenceCanvas", local);
    swprintf(runtime, MAX_PATH, L"%ls\\runtime-v0.3.7", app_root);
    swprintf(ready, MAX_PATH, L"%ls\\.ready", runtime);
    swprintf(zip_path, MAX_PATH, L"%ls\\payload-v0.3.7.zip", app_root);
    CreateDirectoryW(app_root, NULL);

    if (!file_exists(ready)) {
        if (!write_payload(self, zip_path)) {
            wchar_t message[320];
            swprintf(message, 320, L"安装数据校验或释放准备失败。\n\n诊断阶段：%d\n系统错误：%lu\n\n请确认文件完整并保证至少 1 GB 可用空间。", payload_stage, payload_error);
            fail(message);
            return 2;
        }
        wchar_t command[4 * MAX_PATH];
        swprintf(
            command,
            4 * MAX_PATH,
            L"powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"Remove-Item -LiteralPath '%ls' -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path '%ls' -Force | Out-Null; Expand-Archive -LiteralPath '%ls' -DestinationPath '%ls' -Force; New-Item -ItemType File -Path '%ls' -Force | Out-Null\"",
            runtime, runtime, zip_path, runtime, ready
        );
        if (!run_and_wait(command)) {
            fail(L"应用释放失败，请确认磁盘空间充足，并允许 PowerShell 运行。");
            return 3;
        }
        DeleteFileW(zip_path);
    }

    wchar_t pythonw[MAX_PATH];
    wchar_t entry[MAX_PATH];
    swprintf(pythonw, MAX_PATH, L"%ls\\pythonw.exe", runtime);
    swprintf(entry, MAX_PATH, L"%ls\\standalone_entry.py", runtime);
    if (!file_exists(pythonw) || !file_exists(entry)) {
        DeleteFileW(ready);
        fail(L"应用运行环境不完整，请重新启动以修复。");
        return 4;
    }

    wchar_t command[3 * MAX_PATH];
    swprintf(command, 3 * MAX_PATH, L"\"%ls\" \"%ls\"", pythonw, entry);
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    if (!CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, runtime, &startup, &process)) {
        fail(L"应用主进程启动失败。");
        return 5;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}
