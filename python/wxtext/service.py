"""Orchestration, with injectable Windows and state providers for offline tests."""
from collections import Counter
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
import tempfile

from .adapter import read_contacts, read_messages, resolve_self, resolve_target, search_contacts
from .cipher import PROFILE, decrypt_database, open_readonly, verify_key
from .errors import ToolError
from .exporter import MessageStore, publish
from .snapshot import CONTACT, inventory, snapshot
from .wal import apply_wal


class ExportService:
    def __init__(self, state, windows, discover=lambda: [], progress=lambda message: None):
        self.state, self.windows, self.discover, self.progress = state, windows, discover, progress

    def selection(self, data_dir=None, self_id=None):
        settings = {} if data_dir else self.state.settings()
        selected = data_dir or settings.get("data_dir")
        if not selected:
            candidates = self.discover()
            if len(candidates) != 1:
                raise ToolError("ACCOUNT_REQUIRED", "无法自动唯一选择账号数据目录。",
                                "使用 --data-dir 明确选择你自己的 db_storage 目录。",
                                {"candidates": [str(path) for path in candidates]})
            selected = candidates[0]
        root = Path(selected).expanduser().resolve()
        if root.name != "db_storage":
            raise ToolError("DATA_NOT_FOUND", "--data-dir 必须直接指向 db_storage。")
        if self.state.root.is_relative_to(root.parent) or root.is_relative_to(self.state.root):
            raise ToolError("UNSAFE_PATH", "运行状态目录必须与微信账号数据目录分开。")
        return root, self_id or settings.get("self_id")

    def doctor(self, data_dir=None):
        processes = self.windows.processes()
        result = {"status": "ok", "processes": [asdict(p) for p in processes],
                  "state_dir": str(self.state.root), "windows_live_validation": "requires_prepare_and_export"}
        try:
            root, owner = self.selection(data_dir)
            result.update(data_dir=str(root), self_id=owner, databases=inventory(root),
                          key_cache_exists=self.state.cache_path(root).exists())
        except ToolError as error:
            result.update(selection=error.as_dict())
        return result

    def prepare(self, data_dir=None, self_id=None, timeout=60.0, refresh=False):
        root, owner = self.selection(data_dir, self_id)
        files = inventory(root)
        headers = {}
        for relative in files:
            with (root / relative).open("rb") as stream:
                page = stream.read(PROFILE.page_size)
            if len(page) != PROFILE.page_size:
                raise ToolError("UNSUPPORTED_FORMAT", "数据库首页不是完整的 4096 字节页。", details={"file": relative})
            headers[relative] = page
        saved = {} if refresh else self.state.load_keys(root)
        verified = {name: key for name, key in saved.items() if name in headers and verify_key(key, headers[name])}
        diagnostics = {"source": "verified_cache"}
        if len(verified) != len(headers):
            verified, diagnostics = self.windows.acquire(headers, verified, timeout, self.progress)
        # Validate even provider results before persisting them.
        verified = {name: key for name, key in verified.items() if name in headers and verify_key(key, headers[name])}
        if verified:
            self.state.save_keys(root, verified, diagnostics)
            self.state.select(root, owner)
        missing = sorted(headers.keys() - verified.keys())
        if missing:
            raise ToolError("KEY_NOT_FOUND", "部分数据库尚无通过认证的密钥；已验证部分已加密缓存。",
                            "确认目录属于已登录账号，打开目标聊天及历史记录后再 prepare；仍失败时按完整版本适配。",
                            {"missing_databases": missing, "diagnostics": diagnostics})
        return {"status": "ok", "code": "KEYS_READY", "verified_databases": len(verified),
                "data_dir": str(root), "action": "请从微信托盘正常退出，然后运行 contacts 或 export。",
                "diagnostics": diagnostics}

    @contextmanager
    def decrypted(self, snapshot_root, relative, keys):
        path = snapshot_root / relative
        key = keys.get(relative)
        with path.open("rb") as stream:
            header = stream.read(PROFILE.page_size)
        if key is None or not verify_key(key, header):
            raise ToolError("KEY_NOT_FOUND", "快照缺少有效密钥，或数据库盐已改变。",
                            "打开微信并重新 prepare。", {"file": relative})
        plain = path.with_name(path.name + ".plain")
        connection = None
        try:
            apply_wal(path, key)
            self.progress(f"验证并解密 {relative}…")
            decrypt_database(path, plain, key)
            connection = open_readonly(plain)
            yield connection
        except ToolError as error:
            error.details = {**error.details, "file": relative}
            raise
        finally:
            if connection is not None:
                connection.close()
            plain.unlink(missing_ok=True)

    def contacts(self, query, data_dir=None):
        root, _ = self.selection(data_dir)
        self.windows.ensure_stopped()
        keys = self.state.load_keys(root)
        with snapshot(root, self.state.work_root(), self.windows.ensure_stopped,
                      messages=False, progress=self.progress) as (copy, _):
            with self.decrypted(copy, CONTACT, keys) as connection:
                catalog = read_contacts(connection)
            return {"status": "ok", "contacts": search_contacts(catalog, query)}

    def export(self, target, output, data_dir=None, self_id=None):
        root, owner = self.selection(data_dir, self_id)
        output = Path(output).expanduser().resolve()
        if output.is_relative_to(root.parent) or root.parent.is_relative_to(output) or \
                output.is_relative_to(self.state.root) or self.state.root.is_relative_to(output):
            raise ToolError("UNSAFE_PATH", "导出目录必须与微信账号目录和运行状态目录分开。")
        self.windows.ensure_stopped()
        keys = self.state.load_keys(root)
        work = self.state.work_root()
        with snapshot(root, work, self.windows.ensure_stopped, progress=self.progress) as (copy, sources):
            # Check coverage before decrypting anything. New or rotated shards must not be omitted.
            for item in sources:
                relative = item["file"]
                with (copy / relative).open("rb") as stream:
                    header = stream.read(PROFILE.page_size)
                if relative not in keys or not verify_key(keys[relative], header):
                    raise ToolError("KEY_NOT_FOUND", "无法验证全部消息分片的密钥。",
                                    "打开微信重新 prepare 后再导出。", {"file": relative})
            with self.decrypted(copy, CONTACT, keys) as connection:
                catalog = read_contacts(connection)
            person = resolve_target(catalog, target)
            owner = resolve_self(catalog, root.parent.name, owner)
            if person.user_id == owner:
                raise ToolError("UNSUPPORTED_TARGET", "请选择与你私聊的另一位联系人。")
            stats = Counter()
            with tempfile.TemporaryDirectory(prefix="messages-", dir=work) as directory:
                store = MessageStore(Path(directory) / "selected.sqlite")
                try:
                    for item in sources:
                        if item["file"] == CONTACT:
                            continue
                        with self.decrypted(copy, item["file"], keys) as connection:
                            for message in read_messages(connection, item["file"], person, owner, stats):
                                store.add(message)
                    if not stats["shards_with_target"]:
                        raise ToolError("NO_LOCAL_CONVERSATION", "联系人存在，但本地消息分片没有该私聊。",
                                        "确认目标 ID；若历史只在手机上，请先用微信自身功能迁移到电脑。")
                    return publish(store, output, person, owner, sources, stats)
                finally:
                    store.close()
