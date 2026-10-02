"""Per-user DPAPI key cache. Secret data never appears in CLI arguments or logs."""
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import tempfile

from .cipher import DatabaseKey
from .errors import ToolError
from .windows import BOOL, DWORD, HANDLE, bind, require_windows


class DataBlob(c.Structure):
    _fields_ = [("size", DWORD), ("data", HANDLE)]


def dpapi(value: bytes, decrypt=False) -> bytes:
    require_windows()
    crypt = c.WinDLL("crypt32", use_last_error=True)
    kernel = c.WinDLL("kernel32", use_last_error=True)
    free = bind(kernel, "LocalFree", HANDLE, [HANDLE])
    blob = c.POINTER(DataBlob)
    if decrypt:
        function = bind(crypt, "CryptUnprotectData", BOOL, [blob, HANDLE, blob, HANDLE, HANDLE, DWORD, blob])
    else:
        function = bind(crypt, "CryptProtectData", BOOL, [blob, c.c_wchar_p, blob, HANDLE, HANDLE, DWORD, blob])
    buffer = c.create_string_buffer(value)
    incoming = DataBlob(len(value), c.cast(buffer, HANDLE))
    outgoing = DataBlob()
    if not function(c.byref(incoming), None, None, None, None, 1, c.byref(outgoing)):
        raise ToolError("CACHE_UNAVAILABLE", "Windows DPAPI 无法处理密钥缓存。",
                        "请使用创建缓存的同一 Windows 用户；需要重建时重新运行 prepare --refresh。",
                        {"winerror": c.get_last_error()})
    try:
        return c.string_at(outgoing.data, outgoing.size)
    finally:
        # Release the Windows allocation; Python itself cannot guarantee secret zeroization.
        if outgoing.data:
            c.memset(outgoing.data, 0, outgoing.size)
            free(outgoing.data)


def default_state_root() -> Path:
    if os.name == "nt":
        return Path(os.environ["LOCALAPPDATA"]) / "wxtext"
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "wxtext"


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, filename = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(filename, path)
    finally:
        Path(filename).unlink(missing_ok=True)


class StateStore:
    def __init__(self, root: Path, protect=None, unprotect=None):
        self.root = root.resolve()
        self.protect = protect or dpapi
        self.unprotect = unprotect or (lambda data: dpapi(data, decrypt=True))

    def settings(self) -> dict:
        path = self.root / "settings.json"
        if not path.exists():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or not isinstance(value.get("data_dir"), str):
                raise ValueError
            if value.get("self_id") is not None and not isinstance(value["self_id"], str):
                raise ValueError
            return value
        except (ValueError, UnicodeError):
            raise ToolError("CACHE_INVALID", "本地设置文件格式错误。", "重新 prepare --data-dir 指定账号目录。") from None

    def select(self, data_dir: Path, self_id: str | None):
        atomic_write(self.root / "settings.json", json.dumps(
            {"data_dir": str(data_dir.resolve()), "self_id": self_id}, ensure_ascii=False).encode("utf-8"))

    def cache_path(self, data_dir: Path):
        identity = os.path.normcase(str(data_dir.resolve()))
        token = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        return self.root / "keys" / (token + ".dpapi")

    def save_keys(self, data_dir: Path, keys: dict[str, DatabaseKey], diagnostics: dict):
        value = {"version": 1, "data_dir": os.path.normcase(str(data_dir.resolve())),
                 "keys": {name: {"key": key.secret.hex(), "salt": key.salt.hex(), "profile": key.profile}
                          for name, key in keys.items()}, "diagnostics": diagnostics}
        sealed = self.protect(json.dumps(value).encode("utf-8"))
        atomic_write(self.cache_path(data_dir), sealed)

    def load_keys(self, data_dir: Path) -> dict[str, DatabaseKey]:
        path = self.cache_path(data_dir)
        if not path.exists():
            return {}
        if path.stat().st_size > 8 * 1024 * 1024:
            raise ToolError("CACHE_INVALID", "密钥缓存大小异常。")
        try:
            value = json.loads(self.unprotect(path.read_bytes()))
            if value["version"] != 1 or value["data_dir"] != os.path.normcase(str(data_dir.resolve())):
                raise ValueError
            return {name: DatabaseKey(bytes.fromhex(record["key"]), bytes.fromhex(record["salt"]), record["profile"])
                    for name, record in value["keys"].items()}
        except (KeyError, ValueError, TypeError, AttributeError):
            raise ToolError("CACHE_INVALID", "密钥缓存格式错误或账号绑定不匹配。",
                            "重新运行 prepare --refresh。") from None

    def work_root(self) -> Path:
        path = self.root / "work"
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path
