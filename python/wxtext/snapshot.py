"""Snapshot only stopped clients. Never checkpoint or open source databases in SQLite."""
from contextlib import contextmanager
import hashlib
from pathlib import Path
import re
import tempfile
import time
from typing import Callable

from .errors import ToolError


CONTACT = "contact/contact.db"


def inventory(root: Path, messages: bool = True) -> list[str]:
    contact = root / CONTACT
    if not contact.is_file():
        raise ToolError("DATA_NOT_FOUND", "未找到 contact/contact.db。", "--data-dir 应指向你的 db_storage 目录。")
    files = [CONTACT]
    if messages:
        shards = sorted((root / "message").glob("message_*.db"))
        shards = [p for p in shards if re.fullmatch(r"message_\d+\.db", p.name)]
        if not shards:
            raise ToolError("DATA_NOT_FOUND", "未找到消息分库 message_N.db。")
        files.extend(p.relative_to(root).as_posix() for p in shards)
    for relative in files:
        resolved = (root / relative).resolve()
        if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
            raise ToolError("UNSAFE_PATH", "数据库路径越出所选账号目录。")
    return files


def reject_sidecars(root: Path, files: list[str]) -> None:
    for relative in files:
        for suffix in ("-journal",):
            path = root / (relative + suffix)
            if path.exists() and path.stat().st_size:
                raise ToolError("NEED_CLEAN_EXIT", "数据库仍有非空事务日志，无法保证离线记录完整。",
                                "请正常打开微信，再从托盘正常退出；仍有日志时停止并进行本地适配，不要删除日志。",
                                 {"file": relative + suffix})


def snapshot_files(root: Path, files: list[str]) -> list[str]:
    result = list(files)
    for relative in files:
        name = relative + "-wal"
        path = root / name
        if path.exists():
            if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
                raise ToolError("UNSAFE_PATH", "WAL path is outside the account directory.")
            result.append(name)
    return result


def fingerprint(path: Path) -> tuple[int, int, str]:
    before = path.stat()
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ToolError("SOURCE_CHANGED", "读取期间源数据库发生变化。", "退出微信后重新运行。")
    return after.st_size, after.st_mtime_ns, digest


@contextmanager
def snapshot(root: Path, work_root: Path, ensure_stopped: Callable[[], None],
             messages: bool = True, settle_seconds: float = 0.25, progress=lambda message: None, files=None):
    ensure_stopped()
    explicit_files = files is not None
    files = list(files) if explicit_files else inventory(root, messages)
    for relative in files:
        resolved = (root / relative).resolve()
        if not resolved.is_relative_to(root.resolve()) or not resolved.is_file():
            raise ToolError("UNSAFE_PATH", "数据库路径越出所选账号目录。")
    reject_sidecars(root, files)
    captured = snapshot_files(root, files)
    initial = {}
    for name in captured:
        progress(f"检查快照源文件 {name}…")
        initial[name] = fingerprint(root / name)
    time.sleep(settle_seconds)
    ensure_stopped()
    with tempfile.TemporaryDirectory(prefix="snapshot-", dir=work_root) as directory:
        destination = Path(directory)
        manifest = []
        for name in captured:
            progress(f"复制快照 {name}…")
            copied = destination / name
            copied.parent.mkdir(parents=True, exist_ok=True)
            hasher = hashlib.sha256()
            with (root / name).open("rb") as source, copied.open("xb") as target:
                while block := source.read(1024 * 1024):
                    hasher.update(block)
                    target.write(block)
            if hasher.hexdigest() != initial[name][2]:
                raise ToolError("SOURCE_CHANGED", "复制期间数据库内容发生变化。", "退出微信后重新运行。")
            if name in files:
                item = {"file": name, "size": initial[name][0], "sha256": initial[name][2]}
                wal = name + "-wal"
                if wal in initial:
                    item["wal"] = {"file": wal, "size": initial[wal][0], "sha256": initial[wal][2]}
                manifest.append(item)
        ensure_stopped()
        if not explicit_files and files != inventory(root, messages):
            raise ToolError("SOURCE_CHANGED", "复制期间数据库分片清单发生变化。")
        reject_sidecars(root, files)
        if captured != snapshot_files(root, files):
            raise ToolError("SOURCE_CHANGED", "WAL file inventory changed during capture.")
        for name in captured:
            progress(f"复核快照一致性 {name}…")
            if fingerprint(root / name) != initial[name]:
                raise ToolError("SOURCE_CHANGED", "快照完成前源数据库发生变化。")
        yield destination, manifest
