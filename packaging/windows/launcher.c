#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <shellapi.h>
#include <stdlib.h>
#include <math.h>

#define PATH_CAP 4096
static wchar_t log_path[PATH_CAP];
static HWND progress_window;

static const char MAGIC[16] = "CICPACKV033FULL!";
static DWORD payload_error = ERROR_SUCCESS;
static int payload_stage = 0;

static void log_event(const wchar_t *text);

static void fail(const wchar_t *message) {
    log_event(message);
    wchar_t detail[PATH_CAP + 1400];
    swprintf(detail, PATH_CAP + 1400, L"%ls\n\n启动日志目录：\n%ls\n请保留 launcher.log 与 startup-python.log 便于定位。", message, log_path);
    MessageBoxW(NULL, detail, L"内容智能工作台启动失败", MB_OK | MB_ICONERROR);
}

static void pump(void) {
    MSG message;
    while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&message); DispatchMessageW(&message);
    }
}

static void progress(const wchar_t *text) {
    if (!IsWindow(progress_window)) {
        progress_window = CreateWindowExW(0, L"STATIC", text,
            WS_OVERLAPPED | WS_CAPTION | WS_VISIBLE | SS_CENTER,
            (GetSystemMetrics(SM_CXSCREEN) - 560) / 2, (GetSystemMetrics(SM_CYSCREEN) - 150) / 2,
            560, 150, NULL, NULL, GetModuleHandleW(NULL), NULL);
    } else SetWindowTextW(progress_window, text);
    UpdateWindow(progress_window); pump();
}

static void log_event(const wchar_t *text) {
    HANDLE file = CreateFileW(log_path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        char line[18000]; DWORD written;
        int length = WideCharToMultiByte(CP_UTF8, 0, text, -1, line, sizeof(line) - 2, NULL, NULL);
        if (length > 0) { line[length - 1] = '\r'; line[length] = '\n'; WriteFile(file, line, length + 1, &written, NULL); }
        CloseHandle(file);
    }
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


static int run_and_wait(wchar_t *command, const wchar_t *cwd) {
    STARTUPINFOW startup = {0}; PROCESS_INFORMATION child = {0};
    SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
    HANDLE output = CreateFileW(log_path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE; startup.hStdOutput = startup.hStdError = output; startup.hStdInput = input;
    int ok = CreateProcessW(NULL, command, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, cwd, &startup, &child);
    if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    if (!ok) return 0;
    ULONGLONG deadline = GetTickCount64() + 240000;
    while (WaitForSingleObject(child.hProcess, 100) == WAIT_TIMEOUT) {
        pump();
        if (GetTickCount64() > deadline) { TerminateProcess(child.hProcess, 124); break; }
    }
    DWORD code = 1; GetExitCodeProcess(child.hProcess, &code);
    wchar_t result[100]; swprintf(result, 100, L"解包进程退出码：%lu", code); log_event(result);
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
    return code == 0;
}

static int runtime_complete(const wchar_t *runtime) {
    const wchar_t *files[] = {L"python.exe", L"pythonw.exe", L"python312.dll", L"python312.zip", L"standalone_entry.py",
        L"Lib\\site-packages\\uvicorn\\config.py", L"Lib\\site-packages\\fastapi\\__init__.py",
        L"Lib\\site-packages\\lancedb\\__init__.py", L"Lib\\site-packages\\pyarrow\\__init__.py", L"web_dist\\index.html"};
    wchar_t path[PATH_CAP];
    for (int i = 0; i < sizeof(files) / sizeof(files[0]); ++i) {
        if (swprintf(path, PATH_CAP, L"%ls\\%ls", runtime, files[i]) < 0 || !file_exists(path)) return 0;
    }
    return 1;
}

static void stop_previous(const wchar_t *root) {
    wchar_t path[PATH_CAP]; swprintf(path, PATH_CAP, L"%ls\\runtime-process.json", root);
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;
    char record[16000] = {0}; DWORD size = 0; ReadFile(file, record, sizeof(record) - 1, &size, NULL); CloseHandle(file);
    char *pid_field = strstr(record, "\"pid\""), *time_field = strstr(record, "\"create_time\"");
    if (!pid_field || !time_field || !strstr(record, "standalone_entry.py")) return;
    pid_field = strchr(pid_field, ':'); time_field = strchr(time_field, ':');
    if (!pid_field || !time_field) return;
    DWORD pid = strtoul(pid_field + 1, NULL, 10); double expected = strtod(time_field + 1, NULL);
    if (!pid || expected <= 0 || pid == GetCurrentProcessId()) return;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
    if (!process) return;
    wchar_t executable[PATH_CAP], prefix[PATH_CAP]; DWORD length = PATH_CAP;
    FILETIME created, exited, kernel, user;
    swprintf(prefix, PATH_CAP, L"%ls\\runtime-", root);
    if (QueryFullProcessImageNameW(process, 0, executable, &length) && _wcsnicmp(executable, prefix, wcslen(prefix)) == 0 &&
        GetProcessTimes(process, &created, &exited, &kernel, &user)) {
        const wchar_t *name = wcsrchr(executable, L'\\');
        ULARGE_INTEGER ticks; ticks.LowPart = created.dwLowDateTime; ticks.HighPart = created.dwHighDateTime;
        double actual = (double)ticks.QuadPart / 10000000.0 - 11644473600.0;
        if (name && (!_wcsicmp(name + 1, L"pythonw.exe") || !_wcsicmp(name + 1, L"python.exe")) && fabs(actual - expected) < 1.0) {
            log_event(L"已验证应用专用路径、PID 与创建时间，替换上一应用实例");
            TerminateProcess(process, 0); WaitForSingleObject(process, 5000);
        }
    }
    CloseHandle(process);
}

static int prepare_runtime(const wchar_t *self, const wchar_t *root, const wchar_t *runtime, const wchar_t *ready) {
    if (file_exists(ready) && runtime_complete(runtime)) { log_event(L"复用已校验运行环境"); return 1; }
    progress(L"内容智能工作台：正在释放并校验本地运行环境\n首次启动可能需要一至数分钟，请稍候…");
    wchar_t zip[PATH_CAP], stage[PATH_CAP], old[PATH_CAP], command[32768], system[PATH_CAP];
    swprintf(zip, PATH_CAP, L"%ls\\payload-v0.3.25.zip", root);
    swprintf(stage, PATH_CAP, L"%ls.extracting-%lu-%llu", runtime, GetCurrentProcessId(), GetTickCount64());
    if (!write_payload(self, zip)) {
        wchar_t message[400]; swprintf(message, 400, L"读取安装数据失败。阶段 %d，系统错误 %lu。请确认 EXE 下载完整。", payload_stage, payload_error); fail(message); return 0;
    }
    if (!CreateDirectoryW(stage, NULL)) { fail(L"无法创建运行环境临时目录，请检查可用磁盘空间和目录权限。"); return 0; }
    GetSystemDirectoryW(system, PATH_CAP);
    swprintf(command, 32768, L"\"%ls\\tar.exe\" -xf \"%ls\" -C \"%ls\"", system, zip, stage);
    log_event(L"使用系统 tar 解包（不依赖 PowerShell 执行策略）");
    int extracted = run_and_wait(command, root);
    if (!extracted) {
        log_event(L"系统 tar 不可用，使用 PowerShell 严格模式解包");
        SetEnvironmentVariableW(L"CIC_EXTRACT_ZIP", zip); SetEnvironmentVariableW(L"CIC_EXTRACT_DIR", stage);
        // Paths are environment values, never interpolated into PowerShell source.
        swprintf(command, 32768, L"\"%ls\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"$ErrorActionPreference='Stop'; try { Expand-Archive -LiteralPath $env:CIC_EXTRACT_ZIP -DestinationPath $env:CIC_EXTRACT_DIR -Force; exit 0 } catch { Write-Error $_; exit 1 }\"", system);
        extracted = run_and_wait(command, root);
        SetEnvironmentVariableW(L"CIC_EXTRACT_ZIP", NULL); SetEnvironmentVariableW(L"CIC_EXTRACT_DIR", NULL);
    }
    if (!extracted || !runtime_complete(stage)) { fail(L"运行环境释放或校验失败。旧环境与用户数据均保留；请查看启动日志。 "); return 0; }
    if (GetFileAttributesW(runtime) != INVALID_FILE_ATTRIBUTES) {
        swprintf(old, PATH_CAP, L"%ls.incomplete-%lu-%llu", runtime, GetCurrentProcessId(), GetTickCount64());
        if (!MoveFileW(runtime, old)) { fail(L"无法替换损坏的运行环境，目录可能被占用。请查看日志中的系统错误。"); return 0; }
    }
    if (!MoveFileW(stage, runtime)) { fail(L"无法提交完整运行环境，请检查目录权限。"); return 0; }
    HANDLE marker = CreateFileW(ready, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (marker == INVALID_HANDLE_VALUE) { fail(L"无法保存运行环境校验标记。"); return 0; }
    DWORD written; WriteFile(marker, "v0.3.25", 7, &written, NULL); FlushFileBuffers(marker); CloseHandle(marker);
    DeleteFileW(zip); log_event(L"运行环境完整释放并提交"); return 1;
}

static int start_application(const wchar_t *runtime, const wchar_t *root) {
    wchar_t command[PATH_CAP * 3], signal[PATH_CAP], pythonw[PATH_CAP], entry[PATH_CAP];
    swprintf(signal, PATH_CAP, L"%ls\\launch-%lu.url", root, GetCurrentProcessId()); DeleteFileW(signal);
    SetEnvironmentVariableW(L"CIC_STARTUP_URL_FILE", signal); SetEnvironmentVariableW(L"CIC_STARTUP_LOG_DIR", root);
    swprintf(pythonw, PATH_CAP, L"%ls\\pythonw.exe", runtime); swprintf(entry, PATH_CAP, L"%ls\\standalone_entry.py", runtime);
    swprintf(command, PATH_CAP * 3, L"\"%ls\" \"%ls\"", pythonw, entry);
    STARTUPINFOW startup = {0}; PROCESS_INFORMATION child = {0};
    startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
    if (!CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, runtime, &startup, &child)) { log_event(L"CreateProcessW 启动 Python 失败"); return 0; }
    CloseHandle(child.hThread);
    progress(L"内容智能工作台：正在加载知识库与本地服务\n服务就绪后将自动打开浏览器，请稍候…");
    ULONGLONG deadline = GetTickCount64() + 90000;
    int ok = 0;
    while (GetTickCount64() < deadline) {
        pump();
        if (file_exists(signal)) {
            HANDLE file = CreateFileW(signal, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            char bytes[160] = {0}; DWORD count = 0;
            if (file != INVALID_HANDLE_VALUE) { ReadFile(file, bytes, sizeof(bytes) - 1, &count, NULL); CloseHandle(file); }
            wchar_t url[160] = {0}; MultiByteToWideChar(CP_UTF8, 0, bytes, -1, url, 160);
            wchar_t *end = NULL; unsigned long port = 0;
            if (wcsncmp(url, L"http://127.0.0.1:", 17) == 0) port = wcstoul(url + 17, &end, 10);
            if (port > 0 && port <= 65535 && end && !*end) {
                if (!GetEnvironmentVariableW(L"CIC_NO_BROWSER", command, PATH_CAP)) {
                    if ((INT_PTR)ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL) <= 32) MessageBoxW(NULL, url, L"服务已启动，请在浏览器打开此地址", MB_OK);
                }
                ok = 1; DeleteFileW(signal); log_event(L"本地服务健康检查通过"); break;
            }
        }
        if (WaitForSingleObject(child.hProcess, 100) != WAIT_TIMEOUT) { DWORD code = 0; GetExitCodeProcess(child.hProcess, &code); wchar_t result[120]; swprintf(result, 120, L"Python 在就绪前退出，退出码：0x%08lX", code); log_event(result); break; }
    }
    if (!ok) { TerminateProcess(child.hProcess, 125); WaitForSingleObject(child.hProcess, 5000); }
    CloseHandle(child.hProcess); return ok;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
    (void)instance; (void)previous; (void)arguments; (void)show;
    wchar_t self[PATH_CAP], local[PATH_CAP], root[PATH_CAP], runtime[PATH_CAP], ready[PATH_CAP], portable[PATH_CAP];
    DWORD length = GetModuleFileNameW(NULL, self, PATH_CAP);
    if (!length || length >= PATH_CAP || !GetEnvironmentVariableW(L"LOCALAPPDATA", local, PATH_CAP)) { fail(L"无法定位程序或本地用户目录。"); return 1; }
    swprintf(root, PATH_CAP, L"%ls\\ContentIntelligenceCanvas", local); CreateDirectoryW(root, NULL);
    swprintf(log_path, PATH_CAP, L"%ls\\launcher.log", root);
    wchar_t *separator = wcsrchr(self, L'\\');
    if (!separator) return 1;
    *separator = L'\0'; swprintf(portable, PATH_CAP, L"%ls\\ContentIntelligenceCanvas_Data", self); *separator = L'\\';
    SetEnvironmentVariableW(L"CIC_PORTABLE_HOME", portable);
    swprintf(runtime, PATH_CAP, L"%ls\\runtime-v0.3.25", root); swprintf(ready, PATH_CAP, L"%ls\\.ready", runtime);
    progress(L"内容智能工作台：正在准备启动…");
    HANDLE mutex = CreateMutexW(NULL, FALSE, L"Local\\ContentIntelligenceCanvas.Launcher");
    if (!mutex) { fail(L"无法创建启动锁。"); return 2; }
    DWORD wait = WAIT_TIMEOUT; ULONGLONG deadline = GetTickCount64() + 300000;
    while ((wait = WaitForSingleObject(mutex, 100)) == WAIT_TIMEOUT && GetTickCount64() < deadline) pump();
    if (wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED) { CloseHandle(mutex); fail(L"另一个启动过程尚未完成，请查看启动日志。"); return 3; }
    stop_previous(root);
    int ok = 0, diagnosed = 0;
    for (int attempt = 0; attempt < 2; ++attempt) {
        if (!prepare_runtime(self, root, runtime, ready)) { diagnosed = 1; break; }
        if (start_application(runtime, root)) { ok = 1; break; }
        DeleteFileW(ready);
        log_event(L"启动未就绪，将重新释放运行环境后重试一次");
    }
    ReleaseMutex(mutex); CloseHandle(mutex);
    if (IsWindow(progress_window)) DestroyWindow(progress_window);
    if (!ok && !diagnosed) fail(L"本地服务未能启动，已保存完整启动日志。请查看 startup-python.log 的最后一段错误。");
    return ok ? 0 : 4;
}
