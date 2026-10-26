#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
int wmain(void) {
    wchar_t root[32768], command[32768];
    if (!GetModuleFileNameW(NULL, root, 32768)) return 1;
    wchar_t *last = wcsrchr(root, L'\\'); if (!last) return 1; *last = 0;
    if (swprintf(command, 32768, L"\"%ls\\runtime\\python.exe\" -u \"%ls\\runtime\\server_entry.py\"", root, root) < 0) return 1;
    STARTUPINFOW startup = {0}; PROCESS_INFORMATION child = {0}; startup.cb = sizeof(startup);
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, 0, NULL, root, &startup, &child)) {
        fwprintf(stderr, L"Server runtime could not start (Windows error %lu).\n", GetLastError()); return 1;
    }
    CloseHandle(child.hThread); WaitForSingleObject(child.hProcess, INFINITE);
    DWORD code = 1; GetExitCodeProcess(child.hProcess, &code); CloseHandle(child.hProcess); return (int)code;
}
