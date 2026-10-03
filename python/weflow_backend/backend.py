"""Local JSON-RPC queries over authenticated, private WeChat snapshots."""
from collections import Counter
from datetime import datetime
from functools import wraps
import hashlib
import heapq
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import uuid
import threading
import time

from wxtext.adapter import decode_text, message_table, quoted, tables, columns
from wxtext.cipher import PROFILE, decrypt_database, open_readonly, verify_key
from wxtext.errors import ToolError
from wxtext.snapshot import inventory, snapshot
from wxtext.state import StateStore, atomic_write
from wxtext.wal import apply_wal
from wxtext.windows import WindowsSource, discover_data_dir_records
from .live import connect as live_connect, data_version as live_data_version, close_all as close_live


def account_root(value=None, account_id=None):
    if not value:
        choices = [item["dataDir"] for item in discover_data_dir_records()]
        if len(choices) != 1:
            raise ToolError("ACCOUNT_REQUIRED", "请选择要读取的微信账号目录。",
                            details={"candidates": [str(p) for p in choices]})
        return choices[0].resolve()
    path = Path(value).expanduser().resolve()
    if path.name == "db_storage":
        return path
    if (path / "db_storage").is_dir():
        return path / "db_storage"
    candidates = [p for p in path.glob("*/db_storage") if not account_id or
                  p.parent.name == account_id or p.parent.name.startswith(account_id + "_")]
    if len(candidates) != 1:
        raise ToolError("ACCOUNT_REQUIRED", "目录中有多个账号或没有找到 db_storage，请选择具体账号。",
                        details={"candidates": [str(p) for p in candidates]})
    return candidates[0].resolve()


def clean_id(name):
    return re.sub(r"_[A-Za-z0-9]{4}$", "", name)


def json_value(value):
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.hex()
    # Preserve identifiers before they cross JavaScript's integer boundary.
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        return str(value)
    return value


def json_row(row):
    return {name: json_value(row[name]) for name in row.keys()}


def message_signature(row):
    return hashlib.sha256(json.dumps(
        [row["message_content"], row["sender_username"], row["create_time"], row["local_type"]],
        ensure_ascii=False, separators=(",", ":")).encode()).digest()


def live_query(method):
    """The same bounded read applies to RPC and direct CLI calls."""
    @wraps(method)
    def query(self, *args, **kwargs):
        if self.mode != "live":
            return method(self, *args, **kwargs)
        self._pending_events.extend(self.pollLiveChanges())
        if self.live_missing:
            raise ToolError("KEY_NOT_FOUND", "核心数据库不完整，请补齐密钥后重试。",
                            details={"missing_databases": self.live_missing})
        if self._last_status_state not in {"ready", "degraded"}:
            raise ToolError("SOURCE_REPLACED", "源数据库正在重新连接，请稍后重试。")
        own_budget = self._deadline is None
        if own_budget:
            self.begin_request(None, 2000)
        try:
            result = method(self, *args, **kwargs)
            self._check_limits()
            return result
        except ToolError:
            raise
        except Exception as error:
            self._check_limits()
            message = str(error).casefold()
            if "locked" in message or "busy" in message:
                raise ToolError("LIVE_BUSY", "数据库暂时繁忙，请稍后重试。") from error
            if "interrupt" in message:
                raise ToolError("LIVE_READ_TIMEOUT", "在线读取超过时间限制。") from error
            raise
        finally:
            if own_budget:
                self.end_request()
    return query


class Backend:
    def __init__(self, state_dir, windows=None, state=None, progress=lambda message: None):
        self.state = state or StateStore(Path(state_dir))
        self.windows = windows
        self.progress = progress
        self.connections = {}
        self.root = None
        self.meta = None
        self.owner = None
        self.cursors = {}
        self.next_cursor = 0
        self.session_cache = None
        self.stats_cache = {}
        self.mode = "snapshot"
        self.connection_id = None
        self.revision = 0
        self.monitor_enabled = True
        self.live_baseline = {}
        self.live_missing = []
        self.live_engine = "sqlcipher3"
        self._cancelled = set()
        self._request_lock = threading.Lock()
        self._request_id = None
        self._deadline = None
        self._last_inventory_check = 0.0
        self._known_live_files = set()
        self._known_live_salts = {}
        self.live_keys = {}
        self._last_status_state = None
        self._pending_events = []
        self._live_identities = {}
        self._retry_index = 0
        self._reconnect_at = 0.0
        self._recovery_code = None
        self.live_unavailable = []

    def source(self):
        if self.windows is None:
            self.windows = WindowsSource()
        return self.windows

    def getImageKeys(self, accountDir=None, accountId=None, refresh=False, **_):
        from .image_keys import acquire
        root = account_root(accountDir or self.state.settings().get('data_dir'), accountId)
        return acquire(root.parent, self.state, self.source(), self.progress, refresh)

    @live_query
    def resolveImageHardlink(self, md5, accountDir=None, **_):
        if not re.fullmatch(r'[0-9a-fA-F]{32}', md5 or ''):
            return {'success': False, 'error': '图片标识无效。'}
        account = self.root.parent
        if accountDir and account_root(accountDir) != self.root:
            return {'success': False, 'error': '图片账号与已连接账号不一致。'}
        relative = next((name for name in self.meta['files'] if Path(name).name == 'hardlink.db'), None)
        if not relative:
            return {'success': False, 'error': '没有图片附件索引。'}
        conn = self.connection(relative)
        rows = conn.execute('''SELECT h.file_name, h.type, d1.username AS dir1, d2.username AS dir2
            FROM image_hardlink_info_v4 h
            LEFT JOIN dir2id d1 ON d1.rowid=h.dir1
            LEFT JOIN dir2id d2 ON d2.rowid=h.dir2
            WHERE h.md5=? COLLATE NOCASE ORDER BY h.modify_time DESC LIMIT 30''', (md5,)).fetchall()
        found = []
        for row in rows:
            parts = [row['dir1'], row['dir2'], row['file_name']]
            if any(not part or '/' in part or '\\' in part or part in {'.', '..'} for part in parts):
                continue
            path = account / 'msg' / 'attach' / parts[0] / parts[1] / 'Img' / parts[2]
            if path.is_file():
                name = parts[2].lower()
                rank = 0 if name.endswith('_h.dat') else 2 if name.endswith('_t.dat') else 1
                found.append((rank, path, row['type']))
        if not found:
            return {'success': False, 'error': '图片尚未下载到本机。'}
        _, path, kind = min(found, key=lambda item: item[0])
        return {'success': True, 'data': {'file_name': path.name, 'full_path': str(path), 'type': kind}}

    def resolveImageHardlinkBatch(self, requests, **_):
        rows = []
        for index, request in enumerate(requests):
            rows.append({'index': index, 'md5': request.get('md5'),
                         **self.resolveImageHardlink(**request)})
        return {'success': True, 'rows': rows}

    def active_path(self, root):
        token = hashlib.sha256(os.path.normcase(str(root.resolve())).encode()).hexdigest()
        return self.state.root / "snapshots" / token / "active.json"

    def read_active(self, root):
        path = self.active_path(root)
        if not path.exists():
            raise ToolError("SNAPSHOT_REQUIRED", "聊天记录副本尚未准备，请先在原界面获取密钥并连接数据库。")
        value = json.loads(path.read_text(encoding="utf-8"))
        directory = Path(value["directory"]).resolve()
        if not directory.is_relative_to(path.parent.resolve()) or not directory.is_dir():
            raise ToolError("SNAPSHOT_REQUIRED", "记录副本已不存在，请重新准备。")
        return value

    def discover(self, **_):
        records = discover_data_dir_records()
        candidates = [record["dataDir"] for record in records]
        selected = self.state.settings().get("data_dir")
        if selected and Path(selected).is_dir() and Path(selected) not in candidates:
            candidates.append(Path(selected))
        result = []
        for path in candidates:
            record = next((item for item in records if item["dataDir"] == path), {})
            item = {"dataDir": str(path), "accountId": clean_id(path.parent.name),
                    "directoryName": path.parent.name, "directorySource": record.get("source", "selected")}
            try:
                item["capturedAt"] = self.read_active(path)["capturedAt"]
            except (ToolError, ValueError, KeyError):
                pass
            result.append(item)
        return {"success": True, "accounts": result}

    def prepareKeys(self, dataDir=None, dbPath=None, accountId=None, refresh=False, **_):
        supplied = dataDir or dbPath
        records = discover_data_dir_records() if os.name == "nt" else []
        source_map = {str(item["dataDir"]): item.get("source", "unknown") for item in records}
        if supplied:
            root = account_root(supplied, accountId)
            explicit = True
            directory_source = "explicit"
            if str(root) in source_map:
                directory_source = source_map[str(root)]
        else:
            settings = self.state.settings()
            choices = [item["dataDir"] for item in records]
            # WeChat's own config is authoritative. A saved selection is only
            # a fallback when it is the sole discovered account directory.
            configured = [item["dataDir"] for item in records if item.get("source") == "config"]
            preferred = configured or choices
            if accountId:
                preferred = [path for path in preferred if clean_id(path.parent.name) == accountId]
            selected = Path(settings["data_dir"]).resolve() if settings.get("data_dir") else None
            if len(set(configured)) > 1 and selected not in configured and not accountId:
                raise ToolError("ACCOUNT_REQUIRED", "检测到多个微信配置账号，请在原有账号路径栏选择目标账号。",
                                details={"candidates": [str(path) for path in configured]})
            root = selected if selected in preferred else preferred[0] if preferred else None
            if root is None:
                raise ToolError("ACCOUNT_REQUIRED", "检测到多个微信数据目录，请在原有账号路径栏选择一个。",
                                details={"candidates": [str(path) for path in preferred]})
            explicit = False
            directory_source = source_map.get(str(root), "config")

        # A matching account ID may have stale copies in multiple folders.
        # Scan their headers together so one bounded memory pass proves which
        # location belongs to the running process. It never inspects/mutates
        # the database body.
        candidate_roots = [root]
        account_id = clean_id(root.parent.name)
        if os.name == "nt":
            candidate_roots.extend(item["dataDir"] for item in records if item["dataDir"] != root and
                                   (not supplied or clean_id(item["dataDir"].parent.name) == account_id))
        unique_roots = list(dict.fromkeys(path.resolve() for path in candidate_roots))
        root_alias = {path: hashlib.sha256(os.path.normcase(str(path)).encode()).hexdigest()[:16]
                      for path in unique_roots}
        combined_headers = {}
        per_root_headers = {}
        for candidate in unique_roots:
            current = self.database_headers(candidate)
            per_root_headers[candidate] = current
            alias = root_alias[candidate]
            combined_headers.update({f"{alias}/{name}": header for name, header in current.items()})

        combined_keys = {}
        for candidate in unique_roots:
            if refresh:
                continue
            alias = root_alias[candidate]
            cached = self.state.load_keys(candidate)
            current = per_root_headers[candidate]
            combined_keys.update({f"{alias}/{name}": key for name, key in cached.items()
                                  if name in current and verify_key(key, current[name])})

        selected_alias = root_alias[root]
        selected_cache_complete = all(f"{selected_alias}/{name}" in combined_keys
                                      for name in per_root_headers[root])
        missing_all = set(combined_headers) - combined_keys.keys()
        diagnostics = {"source": "verified_cache"}
        if missing_all and not selected_cache_complete:
            try:
                # All known databases are the completion set. Reaching the
                # core-message subset must not terminate this bounded pass.
                combined_keys, diagnostics = self.source().acquire(
                    combined_headers, combined_keys, 120, self.progress, required=set(combined_headers))
            except ToolError as error:
                # Cached core keys remain useful when WeChat is logged out;
                # optional gaps are reported below. Other acquisition errors
                # still matter when core keys are absent.
                if error.code != "NEED_LOGIN" or not combined_keys:
                    raise
                diagnostics = {"source": "verified_cache", "scan_error": error.code}

        matched_roots = {}
        for candidate in unique_roots:
            alias = root_alias[candidate]
            headers_for_root = per_root_headers[candidate]
            keys_for_root = {name: combined_keys[f"{alias}/{name}"] for name in headers_for_root
                             if f"{alias}/{name}" in combined_keys and
                             verify_key(combined_keys[f"{alias}/{name}"], headers_for_root[name])}
            matched_roots[candidate] = keys_for_root

        selected_keys = matched_roots[root]
        matched_paths = [path for path, keys in matched_roots.items() if keys]
        configured_roots = {item["dataDir"].resolve() for item in records if item.get("source") == "config"}
        selected_config_is_unique = (not explicit and directory_source == "config" and
                                     configured_roots == {root} and selected_cache_complete)
        if selected_config_is_unique:
            matched_paths = [root]
        if not explicit and len(matched_paths) > 1:
            raise ToolError("ACCOUNT_REQUIRED", "多个微信数据目录都能通过密钥认证，请在原有账号路径栏选择目标目录。",
                            details={"candidates": [str(path) for path in matched_paths]})
        if not selected_keys and len([path for path, keys in matched_roots.items() if keys]) == 1:
            matched_root = next(path for path, keys in matched_roots.items() if keys)
            suggestion = {"accountId": clean_id(matched_root.parent.name),
                          "suggestedDbPath": str(matched_root.parent.parent),
                          "suggestedDataDir": str(matched_root)}
            if explicit:
                raise ToolError("ACCOUNT_DIRECTORY_MISMATCH",
                                "所选微信数据目录与当前运行的微信账号不匹配。",
                                "请改用微信配置指向的数据目录后重新获取密钥。", suggestion)
            root = matched_root
            directory_source = source_map.get(str(root), "authenticated")
            selected_keys = matched_roots[root]

        for candidate, keys in matched_roots.items():
            self.state.save_keys(candidate, keys, diagnostics)

        required = set(inventory(root))
        verified = selected_keys
        self.state.select(root, clean_id(root.parent.name), directory_source)
        missing = sorted(required - verified.keys())
        if missing:
            raise ToolError("KEY_NOT_FOUND", "尚未取得全部核心聊天数据库密钥。",
                            "保持微信登录并打开目标聊天及历史记录后，再点击获取密钥。",
                            {"missing_databases": missing, "verified_databases": len(verified),
                             "unavailable_databases": sorted(per_root_headers[root].keys() - verified.keys()),
                             "directorySource": directory_source})
        key = verified["contact/contact.db"].secret.hex()
        return {"success": True, "key": key, "accountId": clean_id(root.parent.name),
                "dbPath": str(root.parent.parent), "dataDir": str(root),
                "directorySource": directory_source,
                "verifiedDatabases": len(verified),
                "unavailableDatabases": sorted(per_root_headers[root].keys() - verified.keys())}

    @staticmethod
    def database_headers(root):
        headers = {}
        for path in sorted(root.rglob("*.db")):
            resolved = path.resolve()
            if not resolved.is_relative_to(root) or not resolved.is_file():
                continue
            with resolved.open("rb") as stream:
                header = stream.read(PROFILE.page_size)
            if len(header) == PROFILE.page_size and not header.startswith(b"SQLite format 3\0"):
                headers[path.relative_to(root).as_posix()] = header
        return headers

    def createSnapshot(self, dataDir=None, accountId=None, **_):
        root = account_root(dataDir, accountId)
        self.source().ensure_stopped()
        keys = self.state.load_keys(root)
        required = set(inventory(root))
        if required - keys.keys():
            raise ToolError("KEY_NOT_FOUND", "请先获取数据库密钥。")
        files = sorted(name for name in keys if (root / name).is_file())
        home = self.active_path(root).parent
        home.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="prepare-", dir=home) as staging_name:
            staging = Path(staging_name)
            with snapshot(root, self.state.work_root(), self.source().ensure_stopped,
                          progress=self.progress, files=files) as (copy, sources):
                for relative in files:
                    self.progress(f"正在准备 {relative}")
                    encrypted = copy / relative
                    key = keys[relative]
                    apply_wal(encrypted, key)
                    plain = staging / relative
                    plain.parent.mkdir(parents=True, exist_ok=True)
                    decrypt_database(encrypted, plain, key)
                self.source().ensure_stopped()
                captured = datetime.now().astimezone().isoformat(timespec="seconds")
                destination = home / uuid.uuid4().hex
                staging.rename(destination)
                meta = {"directory": str(destination), "dataDir": str(root),
                        "accountId": clean_id(root.parent.name), "capturedAt": captured,
                        "files": files, "sources": sources}
                atomic_write(self.active_path(root), json.dumps(meta, ensure_ascii=False).encode("utf-8"))
        self.close()
        return {"success": True, **meta,
                "key": keys["contact/contact.db"].secret.hex(), "dbPath": str(root.parent.parent)}

    def status(self, dataDir=None, mode=None, **_):
        root = account_root(dataDir)
        selected = self.state.mode(root, mode)
        if selected == "live":
            if self.root == root and self.mode == "live":
                return self.getConnectionStatus()
            return {"success": True, "mode": "live", "state": "disconnected",
                    "complete": False, "missingDatabases": [], "connectionId": None,
                    "revision": 0}
        try:
            meta = self.read_active(root)
        except ToolError:
            return {"success": True, "ready": False}
        return {"success": True, "ready": True, "capturedAt": meta["capturedAt"],
                "dataDir": str(root), "accountId": meta["accountId"], "mode": "snapshot"}

    def getConnectionStatus(self, dataDir=None, mode=None, **_):
        if self.mode == "live" and self.meta is not None:
            return self._status_payload()
        if self.mode == "snapshot" and self.meta is not None:
            return {"success": True, "mode": "snapshot", "state": "ready",
                    "complete": True, "missingDatabases": [], "connectionId": None,
                    "revision": 0, "engine": "sqlite3",
                    "capabilities": {"live": False, "monitor": False}}
        selected_root = dataDir or self.state.settings().get("data_dir")
        selected_mode = self.state.mode(account_root(selected_root), mode) if selected_root else self.mode
        return {"success": True, "mode": selected_mode, "state": "disconnected",
                "complete": False, "missingDatabases": [], "connectionId": self.connection_id,
                "revision": self.revision, "engine": "sqlite3"}

    def connectionConfig(self, dataDir=None, mode=None, **_):
        root = account_root(dataDir or self.root)
        selected = self.state.mode(root, mode)
        if selected == "live":
            if self.root != root or self.mode != "live":
                self.open(str(root), mode="live")
            key = self.state.load_keys(root).get("contact/contact.db")
            return {"success": True, "mode": "live", "dbPath": str(root.parent.parent),
                    "dataDir": str(root), "accountId": self.owner,
                    "key": key.secret.hex() if key else "",
                    **self._status_payload()}
        result = self.snapshotConfig(str(root))
        result["mode"] = "snapshot"
        return result

    def setReadMode(self, dataDir, mode, **_):
        root = account_root(dataDir)
        if mode not in {"snapshot", "live"}:
            raise ToolError("INVALID_MODE", "读取模式必须是 snapshot 或 live。")
        # Validation happens before settings are changed.  An error therefore
        # leaves the previous mode untouched.
        self.open(str(root), mode=mode)
        self.state.set_mode(root, mode)
        return {"success": True, "mode": mode, **self.getConnectionStatus()}

    def setMonitor(self, enabled=True, **_):
        if self.mode != "live":
            raise ToolError("FEATURE_UNAVAILABLE", "snapshot 模式不支持实时监控。",
                            details={"mode": "snapshot"})
        self.monitor_enabled = bool(enabled)
        events = self.pollLiveChanges() if self.monitor_enabled else []
        return {"success": True, "enabled": self.monitor_enabled, "events": events,
                **self._status_payload()}

    def pollLiveChanges(self):
        if self.mode != "live" or self.meta is None or not self.monitor_enabled:
            return []
        changed = []
        errors = []
        now = time.monotonic()
        if time.monotonic() - self._last_inventory_check >= 10:
            self._last_inventory_check = time.monotonic()
            try:
                current = set(inventory(self.root))
                if current != self._known_live_files:
                    self._known_live_files = current
                    errors.append("inventory")
                for name in current:
                    path = self.root / name
                    with path.open("rb") as stream:
                        salt = stream.read(PROFILE.salt_size)
                    stat = path.stat()
                    identity = (stat.st_dev, stat.st_ino, salt)
                    if self._live_identities.get(name) != identity:
                        errors.append("identity")
            except Exception:
                errors.append("inventory")
        for name, connection in list(self.connections.items()):
            try:
                value = live_data_version(connection)
                previous = self.live_baseline.get(name)
                self.live_baseline[name] = value
                if previous is not None and value != previous:
                    changed.append(name)
            except Exception:
                if name in self._known_live_files:
                    errors.append(name)
                else:
                    connection.close()
                    self.connections.pop(name, None)
                    self.live_baseline.pop(name, None)
                    if name not in self.live_unavailable:
                        self.live_unavailable.append(name)
        events = []
        if changed:
            self.revision += 1
            self.session_cache = None
            self.stats_cache.clear()
            events.append({"type": "change", "payload": {
                "table": "Session", "reason": "database_commit", "mode": "live",
                "accountId": self.owner, "connectionId": self.connection_id,
                "revision": self.revision, "scope": "account", "databases": changed,
                "requiresReload": True}})
        if errors and self._recovery_code is None:
            self._recovery_code = "SOURCE_REPLACED"
            self._retry_index = 0
            self._reconnect_at = now + 1
            self._last_status_state = "reconnecting"
            self.session_cache = None
            self.stats_cache.clear()
            events.append({"type": "connection-status", "payload":
                           self._status_payload("reconnecting", self._recovery_code, 1)})
        if self._recovery_code and now >= self._reconnect_at:
            try:
                affected = sorted(self._known_live_files)
                self._open_live(self.root)
                events.append({"type": "connection-status", "payload": self._status_payload()})
                self.revision += 1
                events.append({"type": "change", "payload": {
                    "table": "Session", "reason": "reconnected", "mode": "live",
                    "accountId": self.owner, "connectionId": self.connection_id,
                    "revision": self.revision, "scope": "account", "databases": affected,
                    "requiresReload": True}})
            except (ToolError, OSError) as error:
                state = "needs_key" if isinstance(error, ToolError) and error.code == "KEY_NOT_FOUND" else "reconnecting"
                if state == "needs_key":
                    self.live_missing = list((error.details or {}).get("missing_databases", []))
                self._recovery_code = error.code if isinstance(error, ToolError) else "SOURCE_REPLACED"
                delay = (1, 2, 5)[min(self._retry_index, 2)]
                self._retry_index += 1
                self._reconnect_at = now + delay
                if state != self._last_status_state:
                    events.append({"type": "connection-status", "payload":
                                   self._status_payload(state, self._recovery_code, delay)})
                self._last_status_state = state
        return events

    def drain_events(self):
        events, self._pending_events = self._pending_events, []
        return events

    def request_cancel(self, request_id):
        if request_id is not None:
            with self._request_lock:
                self._cancelled.add(str(request_id))

    def cancel(self, requestId=None, **_):
        # The input thread sets the flag immediately. By the time this queued
        # acknowledgement runs, the target has finished; don't retain its ID.
        if requestId is not None:
            with self._request_lock:
                self._cancelled.discard(str(requestId))
        return {"success": True, "requestId": requestId}

    def begin_request(self, request_id=None, timeout_ms=None):
        self._request_id = None if request_id is None else str(request_id)
        if timeout_ms is None and self.mode == "live":
            timeout_ms = 2000
        self._deadline = (time.monotonic() + max(1, int(timeout_ms)) / 1000
                          if timeout_ms else None)
        for connection in self.connections.values():
            try:
                connection.set_progress_handler(self._progress, 1000)
            except Exception:
                pass

    def end_request(self):
        for connection in self.connections.values():
            try:
                connection.set_progress_handler(None, 0)
            except Exception:
                pass
        with self._request_lock:
            self._cancelled.discard(self._request_id)
        self._request_id = self._deadline = None

    def _progress(self):
        with self._request_lock:
            cancelled = self._request_id in self._cancelled if self._request_id else False
        return 1 if (cancelled or (self._deadline is not None and time.monotonic() >= self._deadline)) else 0

    def snapshotConfig(self, dataDir, **_):
        root = account_root(dataDir)
        meta = self.read_active(root)
        keys = self.state.load_keys(root)
        if "contact/contact.db" not in keys:
            raise ToolError("KEY_NOT_FOUND", "密钥缓存不存在，请重新获取密钥。")
        return {"success": True, "dbPath": str(root.parent.parent), "key": keys["contact/contact.db"].secret.hex(),
                "accountId": meta["accountId"], "capturedAt": meta["capturedAt"]}

    def exportRaw(self, request, **_):
        root = self.export_account_root(request)
        requested_mode = (request.get("mode") or
                          self.state.mode(root, None))
        self.open(str(root), mode=requested_mode)
        output = Path(request.get("exportsDir") or request["outputDir"]).resolve()
        if output.is_relative_to(self.root.parent):
            raise ToolError("UNSAFE_PATH", "导出目录不能位于微信账号目录中。")
        output.mkdir(parents=True, exist_ok=True)
        paths, manifests = {}, {}
        options = request.get("options") or {}
        date_range = options.get("dateRange") or {}
        begin, end = int(date_range.get("start") or 0), int(date_range.get("end") or 0)
        if begin > 10_000_000_000:
            begin //= 1000
        if end > 10_000_000_000:
            end //= 1000
        if self.mode == "live":
            return self._export_live(request, output, begin, end)
        for session_id in request["sessionIds"]:
            self.progress(f"正在导出 {session_id}")
            path = output / (hashlib.md5(session_id.encode(), usedforsecurity=False).hexdigest() + ".jsonl")
            rows = 0
            with path.open("w", encoding="utf-8", newline="\n") as stream:
                for row in self.message_stream(session_id, request.get("ascending", True), begin, end):
                    stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                    rows += 1
            paths[session_id] = str(path)
            manifests[session_id] = {"path": str(path), "rows": rows, "bytes": path.stat().st_size}
        return {"success": True, "successCount": len(paths), "failCount": 0,
                "failedSessionIds": [], "failedSessionErrors": {}, "sessionOutputPaths": paths,
                "rawSessionOutputPaths": paths, "rawExportManifests": manifests}

    def _export_live(self, request, output, begin, end):
        # Capture each database once in a fixed, bounded transaction. All
        # source transactions end before merging/deduplicating the spool.
        started = datetime.now().astimezone().isoformat(timespec="milliseconds")
        staging = Path(tempfile.mkdtemp(prefix=".weflow-live-", dir=output))
        captures, paths, manifests = [], {}, {}
        session_ids = list(dict.fromkeys(request["sessionIds"]))
        spools = {sid: [] for sid in session_ids}
        ascending = request.get("ascending", True)
        previous_deadline = self._deadline
        try:
            for relative in self.meta["files"]:
                if not re.fullmatch(r"message/message_\d+\.db", relative):
                    continue
                connection = self.connection(relative)
                captured_start = datetime.now().astimezone().isoformat(timespec="milliseconds")
                self._deadline = time.monotonic() + 5
                connection.set_progress_handler(self._progress, 1000)
                try:
                    with self._transaction(connection):
                        catalog = tables(connection)
                        for sid in session_ids:
                            table = catalog.get(message_table(sid).lower())
                            if not table:
                                continue
                            self.progress(f"正在捕获 {relative}")
                            token = hashlib.md5(sid.encode(), usedforsecurity=False).hexdigest()
                            spool = staging / (Path(relative).stem + "-" + token + ".capture")
                            with spool.open("w", encoding="utf-8", newline="\n") as stream:
                                for row in self.shard_messages(relative, connection, table, ascending, begin, end):
                                    self._check_limits()
                                    stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                            spools[sid].append(spool)
                        self._check_limits()
                except Exception:
                    self._check_limits()
                    raise
                finally:
                    self._deadline = previous_deadline
                    connection.set_progress_handler(self._progress if self._request_id or self._deadline else None, 1000)
                captures.append({"database": relative, "captureStartedAt": captured_start,
                                 "captureFinishedAt": datetime.now().astimezone().isoformat(timespec="milliseconds")})
            def captured_rows(path):
                with path.open(encoding="utf-8") as stream:
                    for line in stream:
                        yield json.loads(line)
            key = lambda row: (int(row["create_time"]), int(row["sort_seq"]), int(row["local_id"]), row["_db_path"])
            for sid in session_ids:
                name = hashlib.md5(sid.encode(), usedforsecurity=False).hexdigest() + ".jsonl"
                published = staging / name
                seen, count = {}, 0
                with published.open("w", encoding="utf-8", newline="\n") as stream:
                    for row in heapq.merge(*(captured_rows(path) for path in spools[sid]), key=key, reverse=not ascending):
                        self._check_limits()
                        server = row["server_id"]
                        if server != "0":
                            signature = message_signature(row)
                            if server in seen:
                                if seen[server] != signature:
                                    raise ToolError("MESSAGE_CONFLICT", "同一消息 ID 在分库中出现冲突。")
                                continue
                            seen[server] = signature
                        stream.write(json.dumps(row, ensure_ascii=False) + "\n")
                        count += 1
                paths[sid] = str(output / name)
                manifests[sid] = {"path": paths[sid], "rows": count, "bytes": published.stat().st_size,
                                  "consistency": "per_database", "databases": captures}
            self._check_limits()
            # Staging and output share a volume, including the desktop Worker's
            # system temp directory. Capture/convert failure publishes nothing.
            for sid in session_ids:
                destination = Path(paths[sid])
                (staging / destination.name).replace(destination)
            return {"success": True, "mode": "live", "successCount": len(paths), "failCount": 0,
                    "failedSessionIds": [], "failedSessionErrors": {}, "sessionOutputPaths": paths,
                    "rawSessionOutputPaths": paths, "rawExportManifests": manifests,
                    "consistency": "per_database", "databases": captures,
                    "captureStartedAt": started,
                    "captureFinishedAt": datetime.now().astimezone().isoformat(timespec="milliseconds"),
                    "connectionId": self.connection_id, "revision": self.revision}
        finally:
            self._deadline = previous_deadline
            shutil.rmtree(staging, ignore_errors=True)

    @staticmethod
    def export_account_root(request):
        account = request.get("account") or {}
        account_dir = account.get("accountDir")
        if account_dir:
            return account_root(account_dir)
        session_db = account.get("sessionDb") or request.get("sessionDb")
        if not session_db:
            raise ToolError("ACCOUNT_REQUIRED", "WeFlow未提供账号目录或会话数据库路径。",
                            "请在原界面选择微信账号后重新连接。")
        path = Path(session_db).expanduser().resolve()
        if not path.is_file():
            raise ToolError("DATA_NOT_FOUND", "WeFlow提供的会话数据库路径不存在。", details={"sessionDb": str(path)})
        root = next((parent for parent in (path.parent, *path.parents) if parent.name.lower() == "db_storage"), None)
        if root is None or not (root / "contact" / "contact.db").is_file():
            raise ToolError("ACCOUNT_REQUIRED", "会话数据库路径不属于可识别的微信 db_storage 目录。",
                            "请在原界面重新选择正确的微信账号目录。", {"sessionDb": str(path)})
        return root.resolve()

    def _status_payload(self, state=None, code=None, retry_after=None):
        state = state or (self._last_status_state if self._recovery_code else
                         "needs_key" if self.live_missing else "degraded" if self.live_unavailable else
                         "ready" if self.meta is not None else "disconnected")
        payload = {"success": True, "mode": self.mode, "state": state,
                   "complete": not self.live_missing,
                   "missingDatabases": list(self.live_missing),
                   "unavailableDatabases": list(self.live_unavailable),
                   "connectionId": self.connection_id, "revision": self.revision,
                   "engine": self.live_engine if self.mode == "live" else "sqlite3",
                   "capabilities": {"live": self.mode == "live", "monitor": self.mode == "live"}}
        if code:
            payload["code"] = code
        if retry_after is not None:
            payload["retryAfter"] = retry_after
        return payload

    def _check_limits(self):
        if self._request_id:
            with self._request_lock:
                if self._request_id in self._cancelled:
                    raise ToolError("CANCELLED", "操作已取消。")
        if self._deadline is not None and time.monotonic() >= self._deadline:
            raise ToolError("LIVE_READ_TIMEOUT", "在线读取超过时间限制。")

    def _open_live(self, root):
        keys = self.state.load_keys(root)
        required = set(inventory(root))
        missing = sorted(required - set(keys))
        if missing:
            raise ToolError("KEY_NOT_FOUND", "尚未取得全部核心聊天数据库密钥。",
                            "请先获取密钥；在线读取不会回退到旧副本。",
                            {"missing_databases": missing})
        files = sorted(name for name in keys if (root / name).is_file() and
                       name.lower().endswith(".db"))
        # Always include the required set even when a key cache has an old entry.
        files = sorted(set(files) | required)
        opened = {}
        for relative in files:
            if relative not in required:
                continue
            if relative not in keys:
                continue
            try:
                opened[relative] = live_connect(root / relative, keys[relative])
            except BaseException as error:
                close_live(opened)
                if isinstance(error, ToolError) and error.code == "LIVE_AUTH_FAILED":
                    raise ToolError("KEY_NOT_FOUND", "源库认证失败，请重新获取对应密钥。",
                                    details={"missing_databases": [relative]}) from error
                raise
        if "contact/contact.db" not in opened:
            close_live(opened)
            raise ToolError("KEY_NOT_FOUND", "联系人数据库密钥不存在。")
        try:
            opened["contact/contact.db"].execute("SELECT username FROM contact LIMIT 1").fetchone()
            for name in required - {"contact/contact.db"}:
                opened[name].execute("SELECT user_name FROM Name2Id LIMIT 1").fetchone()
        except Exception:
            close_live(opened)
            raise ToolError("UNSUPPORTED_SCHEMA", "在线核心数据库结构尚未适配。") from None
        self.close()
        self.root = root
        self.owner = clean_id(root.parent.name)
        self.meta = {"directory": str(root), "dataDir": str(root),
                     "accountId": self.owner, "files": sorted(files)}
        self.connections = opened
        self.live_keys = keys
        self.mode = "live"
        self._last_status_state = "ready"
        self._recovery_code = None
        self._retry_index = 0
        self._reconnect_at = 0.0
        self.connection_id = uuid.uuid4().hex
        self.revision = 0
        self.live_missing = sorted(required - set(opened))
        self._known_live_files = set(required)
        self._known_live_salts = {}
        self._live_identities = {}
        for name in required:
            try:
                with (root / name).open("rb") as stream:
                    self._known_live_salts[name] = stream.read(PROFILE.salt_size)
                stat = (root / name).stat()
                self._live_identities[name] = (stat.st_dev, stat.st_ino, self._known_live_salts[name])
            except OSError:
                pass
        self._last_inventory_check = time.monotonic()
        self.live_baseline = {name: live_data_version(conn) for name, conn in opened.items()}
        for connection in opened.values():
            if self._deadline is not None:
                connection.set_progress_handler(self._progress, 1000)
        # Verify a real table query after authentication.
        with self._transaction(self.connections["contact/contact.db"]):
            self.connections["contact/contact.db"].execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        return True

    def _transaction(self, connection):
        from .live import read_transaction
        if self.mode == "live":
            return read_transaction(connection)
        from contextlib import nullcontext
        return nullcontext(connection)

    def open(self, accountDir, hexKey="", mode=None, **_):
        root = account_root(accountDir)
        selected_mode = self.state.mode(root, mode)
        if selected_mode == "live":
            result = self._open_live(root)
            return result
        meta = self.ensure_snapshot(root)
        if self.meta and meta["directory"] == self.meta["directory"] and root == self.root:
            return True
        self.close()
        self.root, self.meta, self.owner = root, meta, meta["accountId"]
        self.mode = "snapshot"
        self.connection_id = None
        self.revision = 0
        # Opening the contact database verifies the snapshot is usable.
        self.connection("contact/contact.db")
        return True

    def testConnection(self, accountDir, hexKey="", mode=None, **_):
        root = account_root(accountDir)
        selected_mode = self.state.mode(root, mode)
        if selected_mode == "live":
            # Probe on an isolated Backend so testing another account cannot
            # close the active GUI connection.
            probe = Backend(self.state.root, windows=self.windows, state=self.state,
                            progress=self.progress)
            try:
                probe._open_live(root)
                return {"success": True, **probe._status_payload()}
            finally:
                probe.close()
        meta = self.ensure_snapshot(root, update_if_changed=True)
        connection = open_readonly(Path(meta["directory"]) / "contact/contact.db")
        try:
            connection.execute("SELECT 1 FROM contact LIMIT 1").fetchone()
        finally:
            connection.close()
        return {"success": True, "sessionCount": 0}

    def ensure_snapshot(self, root, update_if_changed=False):
        required = set(inventory(root))
        try:
            meta = self.read_active(root)
            changed = update_if_changed and self.source_metadata_changed(root, meta)
            if required <= set(meta.get("files", [])) and not changed:
                return meta
        except ToolError as error:
            if error.code != "SNAPSHOT_REQUIRED":
                raise
        # The original WeFlow connect path is also the first-run preparation
        # path. createSnapshot enforces a normal WeChat exit and uses only
        # already authenticated per-database cached keys.
        result = self.createSnapshot(str(root))
        return result

    @staticmethod
    def source_metadata_changed(root, meta):
        """Compare inexpensive source size/mtime/WAL metadata on explicit connect.

        Older and synthetic snapshots without a source manifest remain usable;
        the next successful capture writes the richer manifest.
        """
        sources = meta.get("sources") or []
        for item in sources:
            name = item.get("file")
            if not isinstance(name, str):
                continue
            path = (root / name).resolve()
            if not path.is_relative_to(root.resolve()) or not path.is_file():
                return True
            stat = path.stat()
            if stat.st_size != item.get("size"):
                return True
            expected_mtime = item.get("mtime_ns")
            if expected_mtime is not None and stat.st_mtime_ns != expected_mtime:
                return True
            wal_name = name + "-wal"
            wal = root / wal_name
            expected_wal = item.get("wal")
            if wal.exists() != bool(expected_wal):
                return True
            if expected_wal:
                wal_stat = wal.stat()
                if wal_stat.st_size != expected_wal.get("size"):
                    return True
                expected_wal_mtime = expected_wal.get("mtime_ns")
                if expected_wal_mtime is not None and wal_stat.st_mtime_ns != expected_wal_mtime:
                    return True
        return False

    def close(self, **_):
        self.cursors.clear()
        for connection in self.connections.values():
            connection.close()
        self.connections.clear()
        self.root = self.meta = self.owner = self.session_cache = None
        self.stats_cache.clear()
        self.live_baseline.clear()
        self.live_missing = []
        self.live_keys = {}
        self._last_status_state = None
        self._recovery_code = None
        self.live_unavailable = []
        return {"success": True}

    def connection(self, relative):
        if self.meta is None:
            raise ToolError("NOT_CONNECTED", "聊天记录尚未打开。")
        if relative not in self.meta["files"]:
            raise ToolError("DATABASE_UNAVAILABLE", "该数据库未包含在当前副本中。", details={"file": relative})
        if relative not in self.connections:
            if self.mode == "snapshot":
                self.connections[relative] = open_readonly(Path(self.meta["directory"]) / relative)
            elif relative in self.live_keys:
                try:
                    self.connections[relative] = live_connect(self.root / relative, self.live_keys[relative])
                except ToolError:
                    if relative not in self.live_unavailable:
                        self.live_unavailable.append(relative)
                        self._pending_events.append({"type": "connection-status", "payload": self._status_payload()})
                    raise
                self.live_baseline[relative] = live_data_version(self.connections[relative])
                if self._deadline is not None:
                    self.connections[relative].set_progress_handler(self._progress, 1000)
            else:
                raise ToolError("KEY_NOT_FOUND", "该数据库密钥不存在。", details={"file": relative})
        return self.connections[relative]

    def resolve_db(self, kind="", path=""):
        if path:
            candidate = Path(path)
            for base in (self.root, Path(self.meta["directory"])):
                try:
                    relative = candidate.resolve().relative_to(base.resolve()).as_posix()
                    if relative in self.meta["files"]:
                        return relative
                except ValueError:
                    pass
            normalized = path.replace("\\", "/")
            if normalized in self.meta["files"]:
                return normalized
            matches = [name for name in self.meta["files"] if Path(name).name == candidate.name]
            if len(matches) == 1:
                return matches[0]
            raise ToolError("DATABASE_UNAVAILABLE", "查询的数据库不在当前记录副本中。")
        patterns = {"contact": "contact.db", "session": "session.db", "sns": "sns.db"}
        name = patterns.get(kind.lower())
        matches = [p for p in self.meta["files"] if Path(p).name.lower() == name]
        if matches:
            return matches[0]
        raise ToolError("DATABASE_UNAVAILABLE", "当前副本没有该类型的数据库。")

    @live_query
    def execQuery(self, kind, path=None, sql="", params=None, **_):
        connection = self.connection(self.resolve_db(kind, path or ""))
        with self._transaction(connection):
            rows = connection.execute(sql, params or []).fetchall()
        return {"success": True, "rows": [json_row(row) for row in rows]}

    def contact_rows(self, usernames=None):
        connection = self.connection("contact/contact.db")
        with self._transaction(connection):
            rows = [json_row(row) for row in connection.execute("SELECT * FROM contact")]
        for row in rows:
            username = row.get("username", "")
            row.setdefault("local_type", 2 if "@chatroom" in username else 3 if username.startswith("gh_") else 1)
        return [r for r in rows if not usernames or r.get("username") in usernames]

    @live_query
    def getContact(self, username, **_):
        rows = self.contact_rows([username])
        return {"success": True, "contact": rows[0] if rows else None}

    @live_query
    def getContactsCompact(self, usernames=None, **_):
        return {"success": True, "contacts": self.contact_rows(usernames)}

    @live_query
    def contact_map(self, usernames, field):
        result = {}
        for row in self.contact_rows(usernames):
            username = row["username"]
            if field == "display":
                value = row.get("remark") or row.get("nick_name") or username
            elif field == "avatar":
                value = row.get("big_head_img_url") or row.get("big_head_url") or row.get("small_head_img_url") or row.get("small_head_url") or row.get("head_img_url") or ""
            elif field == "friend":
                value = row.get("local_type") == 1
            else:
                value = row.get(field, "")
            result[username] = value
        return {"success": True, "map": result}

    def listMessageDbs(self, **_):
        return {"success": True, "data": [str(self.root / name) for name in self.meta["files"]
                if re.fullmatch(r"message/message_\d+\.db", name)]}

    def listMediaDbs(self, **_):
        return {"success": True, "data": [str(self.root / name) for name in self.meta["files"]
                if "media" in name.lower()]}

    def message_tables(self, session_id):
        wanted = message_table(session_id).lower()
        for path in self.listMessageDbs()["data"]:
            relative = Path(path).relative_to(self.root).as_posix()
            connection = self.connection(relative)
            table = tables(connection).get(wanted)
            if table:
                yield relative, connection, table

    def shard_messages(self, relative, connection, table, ascending, begin, end, limit=None, after=None):
        available = columns(connection, table)
        required = {"local_id", "local_type", "create_time", "message_content", "real_sender_id"}
        if required - available:
            raise ToolError("UNSUPPORTED_SCHEMA", "消息表结构尚未适配。",
                            details={"file": relative, "missing_columns": sorted(required - available)})
        mapping = tables(connection).get("name2id")
        if not mapping:
            raise ToolError("UNSUPPORTED_SCHEMA", "消息分库缺少 Name2Id 映射。")
        order = "ASC" if ascending else "DESC"
        sequence = "m.sort_seq" if "sort_seq" in available else "m.local_id"
        where, params = [], []
        if begin:
            where.append("m.create_time >= ?")
            params.append(begin)
        if end:
            where.append("m.create_time <= ?")
            params.append(end)
        if after:
            comparator = ">" if ascending else "<"
            where.append(f"(m.create_time, {sequence}, m.local_id, ?) {comparator} (?, ?, ?, ?)")
            params.extend([str(self.root / relative), *after])
        sql = f"SELECT m.*, n.user_name AS sender_username FROM {quoted(table)} m LEFT JOIN {quoted(mapping)} n ON n.rowid=m.real_sender_id"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY m.create_time {order}, {sequence} {order}, m.local_id {order}"
        if limit is not None:
            sql += f" LIMIT {max(1, int(limit))}"
        for original in connection.execute(sql, params):
            self._check_limits()
            row = json_row(original)
            raw, compression = original["message_content"], row.get("WCDB_CT_message_content")
            fallback = original["compress_content"] if "compress_content" in available else None
            code = int(row["local_type"])
            if raw is not None:
                if isinstance(raw, str) or code & 0xFFFF == 1 or compression == 4 or (isinstance(raw, bytes) and raw.startswith(b"\x28\xb5\x2f\xfd")):
                    row["message_content"] = decode_text(raw, compression, fallback)
                else:
                    row["message_content"] = json_value(raw)
            row["sender_username"] = row.get("sender_username") or ""
            if code & 0xFFFF == 1 and not row["sender_username"]:
                raise ToolError("SENDER_UNRESOLVED", "无法识别文字消息发送者。", details={"file": relative, "local_id": row["local_id"]})
            row["computed_is_send"] = int(row["sender_username"] == self.owner)
            row["server_id"] = str(row.get("server_id") or 0)
            row.setdefault("sort_seq", row["local_id"])
            row.update(_db_path=str(self.root / relative), _db_name=Path(relative).name, _table_name=table)
            yield row

    def message_stream(self, session_id, ascending=True, begin=0, end=0, limit=None, after=None):
        if self.mode == "live":
            streams = []
            for relative, conn, table in self.message_tables(session_id):
                captured_at = time.monotonic()
                with self._transaction(conn):
                    streams.append(list(self.shard_messages(relative, conn, table,
                                                            ascending, begin, end, limit, after)))
                if time.monotonic() - captured_at > 5:
                    raise ToolError("LIVE_READ_TIMEOUT", "在线导出捕获超过 5 秒，请缩小范围或使用 snapshot。")
            streams = [iter(rows) for rows in streams]
        else:
            streams = [self.shard_messages(relative, conn, table, ascending, begin, end, limit, after)
                       for relative, conn, table in self.message_tables(session_id)]
        key = lambda row: (int(row["create_time"]), int(row["sort_seq"]), int(row["local_id"]), row["_db_path"])
        seen = {}
        for row in heapq.merge(*streams, key=key, reverse=not ascending):
            self._check_limits()
            server = row["server_id"]
            if server != "0":
                signature = message_signature(row)
                if server in seen:
                    if seen[server] != signature:
                        raise ToolError("MESSAGE_CONFLICT", "同一消息 ID 在分库中出现冲突。")
                    continue
                seen[server] = signature
            yield row

    @live_query
    def getMessages(self, sessionId, limit=50, offset=0, **_):
        automatic_budget = self.mode == "live" and self._deadline is None
        if automatic_budget:
            self.begin_request(None, 2000)
        requested = max(1, int(limit))
        try:
            source_limit = max(1, int(offset) + requested) if self.mode == "live" else None
            try:
                if self.mode == "live":
                    state = {"session": sessionId, "size": source_limit, "ascending": False,
                             "begin": 0, "end": 0, "position": None, "seen": {}}
                    page = self._live_page(state)
                    rows = page["rows"][max(0, offset):]
                else:
                    rows = list(itertools.islice(self.message_stream(sessionId, False),
                                                 max(0, offset), max(0, offset) + requested))
            except Exception as error:
                if "interrupt" in str(error).casefold() and self._deadline is not None and time.monotonic() >= self._deadline:
                    raise ToolError("LIVE_READ_TIMEOUT", "在线读取超过时间限制。") from error
                raise
            return {"success": True, "messages": rows}
        finally:
            if automatic_budget:
                self.end_request()

    @live_query
    def openMessageCursor(self, sessionId, batchSize=100, ascending=False, beginTimestamp=0, endTimestamp=0, **_):
        self.next_cursor += 1
        if self.mode == "live":
            self.cursors[self.next_cursor] = {"session": sessionId, "size": max(1, batchSize),
                "ascending": bool(ascending), "begin": beginTimestamp, "end": endTimestamp,
                "revision": self.revision, "position": None, "seen": {}}
            return {"success": True, "cursor": self.next_cursor, "revision": self.revision}
        self.cursors[self.next_cursor] = [iter(self.message_stream(sessionId, ascending, beginTimestamp, endTimestamp)), max(1, batchSize)]
        return {"success": True, "cursor": self.next_cursor}

    def _live_page(self, state):
        rows, position = [], state["position"]
        seen = dict(state["seen"])
        while len(rows) <= state["size"]:
            candidates = list(self.message_stream(state["session"], state["ascending"],
                state["begin"], state["end"], state["size"] + 1, position))
            if not candidates:
                break
            for row in candidates:
                key = (int(row["create_time"]), int(row["sort_seq"]), int(row["local_id"]), row["_db_path"])
                position = key
                server = row["server_id"]
                if server != "0":
                    signature = message_signature(row)
                    if server in seen:
                        if seen[server] != signature:
                            raise ToolError("MESSAGE_CONFLICT", "同一消息 ID 在分库中出现冲突。")
                        continue
                    seen[server] = signature
                rows.append(row)
                if len(rows) > state["size"]:
                    break
            if len(rows) > state["size"]:
                break
        more = len(rows) > state["size"]
        rows = rows[:state["size"]]
        if rows:
            last = rows[-1]
            state["position"] = (int(last["create_time"]), int(last["sort_seq"]), int(last["local_id"]), last["_db_path"])
            for row in rows:
                if row["server_id"] != "0":
                    state["seen"][row["server_id"]] = message_signature(row)
        return {"success": True, "rows": rows, "hasMore": more, "revision": self.revision}

    @live_query
    def fetchMessageBatch(self, cursor, **_):
        if cursor not in self.cursors:
            raise ToolError("CURSOR_CLOSED", "消息分页已经结束，请重新打开聊天。")
        if self.mode == "live" and isinstance(self.cursors[cursor], dict):
            state = self.cursors[cursor]
            if state["revision"] != self.revision:
                self.cursors.pop(cursor, None)
                raise ToolError("CURSOR_STALE", "数据库已发生变化，请重新加载消息页。")
            return self._live_page(state)
        iterator, size = self.cursors[cursor]
        rows = list(itertools.islice(iterator, size))
        sentinel = object()
        following = next(iterator, sentinel)
        more = following is not sentinel
        if more:
            self.cursors[cursor][0] = itertools.chain([following], iterator)
        return {"success": True, "rows": rows, "hasMore": more}

    def closeMessageCursor(self, cursor, **_):
        self.cursors.pop(cursor, None)
        return {"success": True}

    @live_query
    def getSessions(self, **_):
        if self.session_cache is not None:
            return {"success": True, "sessions": self.session_cache}
        candidates = {row["username"] for row in self.contact_rows()}
        known_tables = set()
        for path in self.listMessageDbs()["data"]:
            connection = self.connection(Path(path).relative_to(self.root).as_posix())
            catalog = tables(connection)
            known_tables.update(catalog)
            mapping = catalog.get("name2id")
            if mapping:
                candidates.update(row[0] for row in connection.execute(f"SELECT user_name FROM {quoted(mapping)}") if row[0])
        result = []
        for username in sorted(candidates):
            if message_table(username).lower() not in known_tables:
                continue
            latest = next(self.message_stream(username, False, limit=1), None)
            if latest:
                result.append({"username": username, "summary": latest["message_content"],
                               "last_timestamp": latest["create_time"], "sort_timestamp": latest["create_time"],
                               "last_msg_type": latest["local_type"], "unread_count": 0})
        result.sort(key=lambda row: row["sort_timestamp"], reverse=True)
        self.session_cache = result
        return {"success": True, "sessions": result}

    @live_query
    def stats(self, session_id, begin=0, end=0):
        cache_key = (session_id, begin, end)
        if cache_key in self.stats_cache:
            return self.stats_cache[cache_key]
        data = {"total": 0, "sent": 0, "received": 0, "firstTime": 0, "lastTime": 0,
                "typeCounts": Counter(), "daily": Counter(), "monthly": Counter(),
                "hourly": Counter(), "weekday": Counter(), "senderCounts": Counter(),
                "sentDaily": Counter(), "special": Counter(), "textCharacters": 0}
        for row in self.message_stream(session_id, True, begin, end):
            moment = datetime.fromtimestamp(int(row["create_time"]))
            data["total"] += 1
            data["sent" if row["computed_is_send"] else "received"] += 1
            data["firstTime"] = data["firstTime"] or int(row["create_time"])
            data["lastTime"] = int(row["create_time"])
            data["typeCounts"][str(row["local_type"])] += 1
            data["daily"][moment.strftime("%Y-%m-%d")] += 1
            data["monthly"][moment.strftime("%Y-%m")] += 1
            data["hourly"][str(moment.hour)] += 1
            data["weekday"][str((moment.weekday() + 1) % 7)] += 1
            data["senderCounts"][row["sender_username"]] += 1
            if row["computed_is_send"]:
                data["sentDaily"][moment.strftime("%Y-%m-%d")] += 1
            code = int(row["local_type"])
            content = str(row["message_content"] or "")
            subtype = code >> 32
            if code & 0xFFFF == 49:
                found = re.search(r"<type>\s*(\d+)\s*</type>", content)
                subtype = subtype or (int(found[1]) if found else 0)
                special = {6: "file_messages", 2000: "transfer_messages", 2001: "red_packet_messages"}.get(subtype)
                if special:
                    data["special"][special] += 1
            elif code & 0xFFFF == 50:
                data["special"]["call_messages"] += 1
            if int(row["local_type"]) & 0xFFFF == 1:
                data["textCharacters"] += len(row["message_content"] or "")
        self.stats_cache[cache_key] = data
        return data

    def getSessionMessageTypeStats(self, sessionId, beginTimestamp=0, endTimestamp=0, **_):
        data = self.stats(sessionId, beginTimestamp, endTimestamp)
        kinds = Counter()
        for code, count in data["typeCounts"].items():
            kinds[int(code) & 0xFFFF] += count
        return {"success": True, "data": {"total_messages": data["total"],
                "type_counts": data["typeCounts"], "sender_counts": data["senderCounts"],
                "first_timestamp": data["firstTime"], "last_timestamp": data["lastTime"],
                "date_counts": data["daily"], "group_my_messages": data["sent"],
                "group_sender_count": len(data["senderCounts"]),
                "voice_messages": kinds[34], "image_messages": kinds[3],
                "video_messages": kinds[43] + kinds[62], "emoji_messages": kinds[47],
                "file_messages": data["special"]["file_messages"],
                "call_messages": data["special"]["call_messages"],
                "transfer_messages": data["special"]["transfer_messages"],
                "red_packet_messages": data["special"]["red_packet_messages"],
                "text_characters": data["textCharacters"], "sent_messages": data["sent"],
                "received_messages": data["received"]}}

    def aggregate(self, session_ids, begin=0, end=0, annual=False):
        data = {"total": 0, "sent": 0, "received": 0, "firstTime": 0, "lastTime": 0,
                "sessions": {}, "idMap": {}, "typeCounts": Counter(), "daily": Counter(),
                "monthly": Counter(), "hourly": Counter(), "weekday": Counter(), "sentDaily": Counter()}
        for session_id in session_ids:
            stats = self.stats(session_id, begin, end)
            entry = dict(stats)
            entry["senders"] = stats["senderCounts"]
            if annual:
                entry["monthly"] = Counter()
                for month, count in stats["monthly"].items():
                    entry["monthly"][str(int(month[-2:]))] += count
            data["sessions"][session_id] = entry
            for field in ("total", "sent", "received"):
                data[field] += stats[field]
            if stats["firstTime"]:
                data["firstTime"] = min(data["firstTime"] or stats["firstTime"], stats["firstTime"])
            data["lastTime"] = max(data["lastTime"], stats["lastTime"])
            for field in ("typeCounts", "daily", "monthly", "hourly", "weekday", "sentDaily"):
                data[field].update(stats[field])
        return {"success": True, "data": data}

    @live_query
    def searchMessages(self, keyword, sessionId=None, limit=100, offset=0, beginTimestamp=0, endTimestamp=0, **_):
        session_ids = [sessionId] if sessionId else [s["username"] for s in self.getSessions()["sessions"]]
        def matches():
            for sid in session_ids:
                for row in self.message_stream(sid, False, beginTimestamp, endTimestamp):
                    if keyword.casefold() in str(row.get("message_content", "")).casefold():
                        yield {**row, "session_id": sid, "_session_id": sid}
        rows = list(itertools.islice(matches(), offset, offset + limit))
        return {"success": True, "messages": rows}

    def dispatch(self, method, payload):
        simple = {"discover", "prepareKeys", "getImageKeys", "resolveImageHardlink", "resolveImageHardlinkBatch", "createSnapshot", "status", "snapshotConfig", "connectionConfig", "getConnectionStatus", "setReadMode", "exportRaw", "open", "close", "testConnection",
                  "execQuery", "getContact", "getContactsCompact", "listMessageDbs", "listMediaDbs", "getSessions",
                  "getMessages", "openMessageCursor", "fetchMessageBatch", "closeMessageCursor",
                  "getSessionMessageTypeStats", "searchMessages", "setMonitor", "cancel"}
        if method in simple:
            return getattr(self, method)(**payload)
        if method == "isConnected":
            return self.meta is not None
        if method == "getLastInitError":
            return None if self.meta else "聊天记录尚未连接，请检查微信账号目录和数据库副本。"
        if method == "shutdown":
            return self.close()
        if method in {"setPaths", "setLibPath", "setLogEnabled"}:
            # The Python adapter has no native DLL paths or configurable log
            # switches; accepting these calls would hide a disconnected UI.
            raise ToolError("FEATURE_UNAVAILABLE", "内置后端不需要原生库路径或日志开关。", details={"method": method})
        if method in {"cloudStop", "cloudInit", "cloudReport"}:
            raise ToolError("FEATURE_UNAVAILABLE", "内置后端未实现云报告。", details={"method": method})
        if method == "getLogs":
            return {"success": True, "logs": []}
        maps = {"getDisplayNames": "display", "getAvatarUrls": "avatar", "getContactAliasMap": "alias", "getContactFriendFlags": "friend"}
        if method in maps:
            return self.contact_map(payload.get("usernames", []), maps[method])
        sid = payload.get("sessionId", payload.get("chatroomId", ""))
        begin, end = payload.get("beginTimestamp", 0), payload.get("endTimestamp", 0)
        if method == "getMessageCount":
            return {"success": True, "count": self.stats(sid)["total"]}
        if method in {"getMessageCounts", "getSessionMessageCounts"}:
            return {"success": True, "counts": {s: self.stats(s)["total"] for s in payload["sessionIds"]}}
        if method == "getSessionMessageTypeStatsBatch":
            options = payload.get("options") or {}
            return {"success": True, "data": {s: self.getSessionMessageTypeStats(s, options.get("beginTimestamp", 0), options.get("endTimestamp", 0))["data"] for s in payload["sessionIds"]}}
        if method == "getSessionMessageDateCounts":
            return {"success": True, "counts": self.stats(sid)["daily"]}
        if method == "getSessionMessageDateCountsBatch":
            return {"success": True, "data": {s: self.stats(s)["daily"] for s in payload["sessionIds"]}}
        if method == "getMessageDates":
            return {"success": True, "dates": sorted(self.stats(sid)["daily"])}
        if method in {"getAggregateStats", "getAnnualReportStats"}:
            return self.aggregate(payload["sessionIds"], begin, end, method == "getAnnualReportStats")
        if method == "getGroupStats":
            return self.aggregate([sid], begin, end)
        if method == "getAvailableYears":
            years = {int(day[:4]) for s in payload["sessionIds"] for day in self.stats(s)["daily"]}
            return {"success": True, "data": sorted(years, reverse=True)}
        if method in {"getMessagesByType", "getNewMessages"}:
            iterator = self.message_stream(sid, payload.get("ascending", method == "getNewMessages"), payload.get("minTime", begin), end)
            if method == "getMessagesByType":
                iterator = (row for row in iterator if int(row["local_type"]) == int(payload["localType"]))
            offset, limit = max(0, payload.get("offset", 0)), payload.get("limit", 1000)
            rows = list(itertools.islice(iterator, offset, offset + limit if limit else None))
            return {"success": True, "rows" if method == "getMessagesByType" else "messages": rows}
        if method in {"getMessageById", "getMessageByServerId"}:
            field = "local_id" if method == "getMessageById" else "server_id"
            value = payload.get("localId", payload.get("svrid"))
            row = next((r for r in self.message_stream(sid) if str(r[field]) == str(value)), None)
            return {"success": True, "message" if method == "getMessageById" else "row": row}
        if method in {"getMessageTables", "getMessageTableStats"}:
            result = []
            for relative, conn, table in self.message_tables(sid):
                count = conn.execute(f"SELECT count(*) FROM {quoted(table)}").fetchone()[0]
                result.append({"db_path": str(self.root / relative), "db_name": Path(relative).name,
                               "table_name": table, "tableName": table, "name": table, "count": count})
            return {"success": True, "tables": result}
        if method in {"listTables", "getTableSchema", "getMessageTableColumns", "getMessageMeta", "getMessageTableTimeRange"}:
            conn = self.connection(self.resolve_db(payload.get("kind", "message"), payload.get("dbPath", "")))
            table = payload.get("tableName", "")
            if method == "listTables":
                return {"success": True, "tables": list(tables(conn).values())}
            if method == "getTableSchema":
                row = conn.execute("SELECT sql FROM sqlite_master WHERE name=?", (table,)).fetchone()
                return {"success": True, "schema": row[0] if row else ""}
            if method == "getMessageTableColumns":
                return {"success": True, "columns": sorted(columns(conn, table))}
            if method == "getMessageMeta":
                rows = conn.execute(f"SELECT * FROM {quoted(table)} LIMIT ? OFFSET ?", (payload.get("limit", 100), payload.get("offset", 0)))
                return {"success": True, "rows": [json_row(row) for row in rows]}
            row = conn.execute(f"SELECT min(create_time),max(create_time) FROM {quoted(table)}").fetchone()
            return {"success": True, "data": {"minTime": row[0], "maxTime": row[1]}}
        if method == "getContactTypeCounts":
            counts = Counter("group" if "@chatroom" in r["username"] else "official" if r["username"].startswith("gh_") else "private" for r in self.contact_rows())
            return {"success": True, "counts": {"former_friend": 0, "blocked": 0, **counts}}
        if method == "getContactStatus":
            return {"success": True, "map": {r["username"]: {"localType": r["local_type"], "isFriend": r["local_type"] == 1} for r in self.contact_rows(payload["usernames"])}}
        if method in {"getGroupMembers", "getGroupMemberCount", "getGroupMemberCounts", "getGroupNicknames"}:
            # Chat participants do not establish the group's complete membership.
            raise ToolError("FEATURE_UNAVAILABLE", "当前副本不提供群成员名单；群聊消息和发言统计仍可读取。")
        if method in {"getHeadImageBuffers", "getEmoticonCaptionStrict", "getEmoticonCaption", "getEmoticonCdnUrl"}:
            raise ToolError("FEATURE_UNAVAILABLE", "当前副本尚未接入头像或表情资源解码。", details={"method": method})
        raise ToolError("FEATURE_UNAVAILABLE", "当前内置后端尚未实现这项功能。", details={"method": method})
