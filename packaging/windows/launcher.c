#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static const char MAGIC[16] = "CICPACKV030FULL!";

static void fail(const wchar_t *message) {
    MessageBoxW(NULL, message, L"内容智能白板启动失败", MB_OK | MB_ICONERROR);
}

static int file_exists(const wchar_t *path) {
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static int write_payload(const wchar_t *self, const wchar_t *zip_path) {
    FILE *input = _wfopen(self, L"rb");
    if (!input) return 0;
    _fseeki64(input, 0, SEEK_END);
    __int64 size = _ftelli64(input);
    if (size < 24 || _fseeki64(input, size - 24, SEEK_SET) != 0) {
        fclose(input);
        return 0;
    }
    uint64_t payload_size = 0;
    char magic[16];
    if (fread(&payload_size, 1, 8, input) != 8 || fread(magic, 1, 16, input) != 16 ||
        memcmp(magic, MAGIC, 16) != 0 || payload_size > (uint64_t)(size - 24)) {
        fclose(input);
        return 0;
    }
    if (_fseeki64(input, size - 24 - (__int64)payload_size, SEEK_SET) != 0) {
        fclose(input);
        return 0;
    }
    FILE *output = _wfopen(zip_path, L"wb");
    if (!output) {
        fclose(input);
        return 0;
    }
    char buffer[1024 * 1024];
    uint64_t remaining = payload_size;
    while (remaining > 0) {
        size_t request = remaining > sizeof(buffer) ? sizeof(buffer) : (size_t)remaining;
        size_t read_count = fread(buffer, 1, request, input);
        if (read_count == 0 || fwrite(buffer, 1, read_count, output) != read_count) {
            fclose(input);
            fclose(output);
            return 0;
        }
        remaining -= read_count;
    }
    fclose(input);
    fclose(output);
    return 1;
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
    swprintf(runtime, MAX_PATH, L"%ls\\runtime-v0.3.0", app_root);
    swprintf(ready, MAX_PATH, L"%ls\\.ready", runtime);
    swprintf(zip_path, MAX_PATH, L"%ls\\payload.zip", app_root);
    CreateDirectoryW(app_root, NULL);

    if (!file_exists(ready)) {
        if (!write_payload(self, zip_path)) {
            fail(L"安装数据读取失败，文件可能下载不完整。");
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
