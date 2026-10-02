"""Windows-only process access. This module is safe to import on Linux."""
from contextlib import contextmanager
import ctypes as c
from dataclasses import dataclass, asdict
import os
from pathlib import Path
import struct
import sys
import time

from .errors import ToolError
from .keyscan import KeyMatcher, scan_config, scan_master


DWORD = c.c_uint32
BOOL = c.c_int32
HANDLE = c.c_void_p
SIZE = c.c_size_t


def require_windows():
    if sys.platform != "win32":
        raise ToolError("WINDOWS_REQUIRED", "采集和实际导出需要在 Windows 本地运行。",
                        "请在 Windows PowerShell 运行 py -m wxtext；WSL 可运行核心测试。")
    if struct.calcsize("P") != 8:
        raise ToolError("WRONG_ARCHITECTURE", "需要 64 位 Python。", "安装 Python 3.12 或更新的 64 位版本。")


def bind(library, name, result, arguments):
    function = getattr(library, name)
    function.restype, function.argtypes = result, arguments
    return function


class ProcessEntry(c.Structure):
    _fields_ = [("size", DWORD), ("usage", DWORD), ("pid", DWORD), ("heap", SIZE),
                ("module", DWORD), ("threads", DWORD), ("parent", DWORD),
                ("priority", c.c_int32), ("flags", DWORD), ("exe", c.c_wchar * 260)]


class ModuleEntry(c.Structure):
    _fields_ = [("size", DWORD), ("module_id", DWORD), ("pid", DWORD), ("global_usage", DWORD),
                ("process_usage", DWORD), ("base", HANDLE), ("image_size", DWORD),
                ("module", HANDLE), ("name", c.c_wchar * 256), ("path", c.c_wchar * 260)]


class MemoryInfo(c.Structure):
    _fields_ = [("base", HANDLE), ("allocation", HANDLE), ("allocation_protect", DWORD),
                ("partition", c.c_uint16), ("region_size", SIZE), ("state", DWORD),
                ("protect", DWORD), ("kind", DWORD)]


@dataclass(frozen=True)
class Process:
    pid: int
    name: str
    path: str
    version: str | None


class WindowsSource:
    def __init__(self):
        require_windows()
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        self.security = c.WinDLL("advapi32", use_last_error=True)
        k, a = self.kernel, self.security
        self.close = bind(k, "CloseHandle", BOOL, [HANDLE])
        self.open = bind(k, "OpenProcess", HANDLE, [DWORD, BOOL, DWORD])
        self.snapshot = bind(k, "CreateToolhelp32Snapshot", HANDLE, [DWORD, DWORD])
        self.first = bind(k, "Process32FirstW", BOOL, [HANDLE, c.POINTER(ProcessEntry)])
        self.next = bind(k, "Process32NextW", BOOL, [HANDLE, c.POINTER(ProcessEntry)])
        self.module_first = bind(k, "Module32FirstW", BOOL, [HANDLE, c.POINTER(ModuleEntry)])
        self.module_next = bind(k, "Module32NextW", BOOL, [HANDLE, c.POINTER(ModuleEntry)])
        self.query_path = bind(k, "QueryFullProcessImageNameW", BOOL, [HANDLE, DWORD, c.c_wchar_p, c.POINTER(DWORD)])
        self.session = bind(k, "ProcessIdToSessionId", BOOL, [DWORD, c.POINTER(DWORD)])
        self.query_memory = bind(k, "VirtualQueryEx", SIZE, [HANDLE, HANDLE, c.POINTER(MemoryInfo), SIZE])
        self.read_memory = bind(k, "ReadProcessMemory", BOOL, [HANDLE, HANDLE, HANDLE, SIZE, c.POINTER(SIZE)])
        self.open_token = bind(a, "OpenProcessToken", BOOL, [HANDLE, DWORD, c.POINTER(HANDLE)])
        self.token_info = bind(a, "GetTokenInformation", BOOL, [HANDLE, DWORD, HANDLE, DWORD, c.POINTER(DWORD)])
        self.sid_length = bind(a, "GetLengthSid", DWORD, [HANDLE])
        self.current_sid = self.owner(os.getpid())
        self.current_session = DWORD()
        if not self.session(os.getpid(), c.byref(self.current_session)):
            self.fail("ProcessIdToSessionId")

    def fail(self, operation: str):
        raise ToolError("ACCESS_DENIED", f"Windows 调用失败：{operation}。",
                        "在登录该微信的同一 Windows 用户下运行；若微信以管理员运行，请使用管理员 PowerShell。",
                        {"winerror": c.get_last_error()})

    @contextmanager
    def handle(self, pid, rights=0x1000):
        handle = self.open(rights, False, pid)
        if not handle:
            self.fail("OpenProcess")
        try:
            yield handle
        finally:
            self.close(handle)

    @contextmanager
    def toolhelp(self, flags, pid=0):
        handle = self.snapshot(flags, pid)
        if handle in (None, c.c_void_p(-1).value):
            self.fail("CreateToolhelp32Snapshot")
        try:
            yield handle
        finally:
            self.close(handle)

    def owner(self, pid):
        with self.handle(pid) as process:
            token = HANDLE()
            if not self.open_token(process, 0x0008, c.byref(token)):
                self.fail("OpenProcessToken")
            try:
                needed = DWORD()
                self.token_info(token, 1, None, 0, c.byref(needed))
                if not needed.value:
                    self.fail("GetTokenInformation")
                buffer = c.create_string_buffer(needed.value)
                if not self.token_info(token, 1, buffer, needed, c.byref(needed)):
                    self.fail("GetTokenInformation")
                sid = c.cast(buffer, c.POINTER(HANDLE))[0]
                return c.string_at(sid, self.sid_length(sid))
            finally:
                self.close(token)

    def processes(self) -> list[Process]:
        found = []
        with self.toolhelp(0x02) as handle:
            entry = ProcessEntry()
            entry.size = c.sizeof(entry)
            success = self.first(handle, c.byref(entry))
            while success:
                if entry.exe.lower() in {"weixin.exe", "wechat.exe"}:
                    # Compare token owners, not a process name or guessed account directory.
                    session_id = DWORD()
                    same_session = self.session(entry.pid, c.byref(session_id)) and session_id.value == self.current_session.value
                    if same_session and self.owner(entry.pid) == self.current_sid:
                        with self.handle(entry.pid) as process:
                            length = DWORD(32768)
                            path = c.create_unicode_buffer(length.value)
                            if not self.query_path(process, 0, path, c.byref(length)):
                                self.fail("QueryFullProcessImageNameW")
                            found.append(Process(entry.pid, entry.exe, path.value, file_version(path.value)))
                success = self.next(handle, c.byref(entry))
            if c.get_last_error() not in (0, 18):
                self.fail("Process32NextW")
        return sorted(found, key=lambda item: item.pid)

    def ensure_stopped(self):
        if self.processes():
            raise ToolError("NEED_EXIT", "检测到当前用户的微信进程仍在运行。",
                            "请从微信托盘菜单正常退出，再重新运行当前命令；关闭窗口不等于退出。")

    def modules(self, pid):
        with self.toolhelp(0x08 | 0x10, pid) as handle:
            entry = ModuleEntry()
            entry.size = c.sizeof(entry)
            success = self.module_first(handle, c.byref(entry))
            while success:
                if entry.name.lower() == "weixin.dll":
                    yield (entry.base, entry.image_size, entry.path)
                success = self.module_next(handle, c.byref(entry))

    def acquire(self, headers, existing, timeout=60.0, progress=lambda message: None, required=None):
        processes = self.processes()
        if not processes:
            raise ToolError("NEED_LOGIN", "未发现当前用户运行中的微信。", "请打开微信并登录你自己的账号，再运行 prepare。")
        eligible = [p for p in processes if p.version and p.version.startswith("4.")]
        if not eligible:
            raise ToolError("UNSUPPORTED_VERSION", "没有检测到可识别的 Windows 微信 4.x 进程。",
                            "运行 doctor 检查完整版本号。", {"processes": [asdict(p) for p in processes]})
        matcher = KeyMatcher(headers, existing, required)
        deadline = time.monotonic() + timeout
        reports = []
        for process in eligible:
            if matcher.complete or time.monotonic() >= deadline:
                break
            progress(f"检查微信 {process.version}（PID {process.pid}），只读查找并验证密钥…")
            with self.handle(process.pid, 0x0400 | 0x0010) as handle:
                reader = ProcessReader(self, handle)
                report = scan_config(reader, matcher, deadline)
                report.update(pid=process.pid, version=process.version)
                reports.append(report)
        if not matcher.complete:
            # A separate, capped fallback; never keep looping over failed offsets.
            fallback_deadline = time.monotonic() + min(10.0, timeout / 4)
            for process in eligible:
                if matcher.complete or time.monotonic() >= fallback_deadline:
                    break
                with self.handle(process.pid, 0x0400 | 0x0010) as handle:
                    for module in self.modules(process.pid):
                        scan_master(ProcessReader(self, handle), matcher, module, fallback_deadline)
                        if matcher.complete:
                            break
        return matcher.keys, {"processes": reports, "candidate_count": matcher.candidates,
                              "verified_databases": len(matcher.keys), "runtime_validation": "page_hmac"}


class ProcessReader:
    def __init__(self, source, handle):
        self.source, self.handle = source, handle

    def read(self, address, size):
        if size < 0 or size > 16 * 1024 * 1024:
            return None
        buffer, received = c.create_string_buffer(size), SIZE()
        self.source.read_memory(self.handle, address, buffer, size, c.byref(received))
        return buffer.raw[:received.value] if received.value else None

    def regions(self):
        address = 0
        while address < 0x0000800000000000:
            info = MemoryInfo()
            if not self.source.query_memory(self.handle, address, c.byref(info), c.sizeof(info)):
                return
            base, size = info.base or 0, info.region_size
            if size <= 0 or base + size <= address:
                return
            protection = info.protect & 0xFF
            if info.state == 0x1000 and not info.protect & 0x100 and protection in {2, 4, 8, 0x20, 0x40, 0x80}:
                yield base, size
            address = base + size


def file_version(filename: str) -> str | None:
    require_windows()
    library = c.WinDLL("version", use_last_error=True)
    size_fn = bind(library, "GetFileVersionInfoSizeW", DWORD, [c.c_wchar_p, c.POINTER(DWORD)])
    load = bind(library, "GetFileVersionInfoW", BOOL, [c.c_wchar_p, DWORD, DWORD, HANDLE])
    query = bind(library, "VerQueryValueW", BOOL, [HANDLE, c.c_wchar_p, c.POINTER(HANDLE), c.POINTER(DWORD)])
    unused = DWORD()
    size = size_fn(filename, c.byref(unused))
    if not size:
        return None
    buffer = c.create_string_buffer(size)
    value, length = HANDLE(), DWORD()
    if not load(filename, 0, size, buffer) or not query(buffer, "\\", c.byref(value), c.byref(length)) or length.value < 16:
        return None
    words = c.cast(value, c.POINTER(DWORD))
    if words[0] != 0xFEEF04BD:
        return None
    major, minor = words[2], words[3]
    return f"{major >> 16}.{major & 65535}.{minor >> 16}.{minor & 65535}"


def discover_data_dirs() -> list[Path]:
    require_windows()
    roots = set()
    profile = Path(os.environ["USERPROFILE"])
    roots.add(profile / "Documents" / "xwechat_files")
    shell = c.WinDLL("shell32", use_last_error=True)
    personal = bind(shell, "SHGetFolderPathW", c.c_int32, [HANDLE, c.c_int32, HANDLE, DWORD, c.c_wchar_p])
    buffer = c.create_unicode_buffer(260)
    if personal(None, 5, None, 0, buffer) == 0:
        roots.add(Path(buffer.value) / "xwechat_files")
    config = Path(os.environ.get("APPDATA", profile / "AppData" / "Roaming")) / "Tencent" / "xwechat" / "config"
    for ini in config.glob("*.ini"):
        if ini.stat().st_size > 65536:
            continue
        raw = ini.read_bytes()
        encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
        try:
            lines = raw.decode(encoding).splitlines()
        except UnicodeError:
            continue
        for line in lines:
            candidate = Path(line.split("=", 1)[-1].strip().strip('"').strip("\x00"))
            if candidate.is_absolute():
                roots.update((candidate, candidate / "xwechat_files"))
    results = set()
    for root in roots:
        if root.name == "db_storage" and (root / "contact" / "contact.db").is_file():
            results.add(root.resolve())
        if (root / "db_storage" / "contact" / "contact.db").is_file():
            results.add((root / "db_storage").resolve())
        if root.is_dir():
            for candidate in root.glob("*/db_storage"):
                if (candidate / "contact" / "contact.db").is_file():
                    results.add(candidate.resolve())
    return sorted(results)
