"""Local JSON-RPC queries over authenticated, private WeChat snapshots."""
from collections import Counter
from datetime import datetime
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

from wxtext.adapter import decode_text, message_table, quoted, tables, columns
from wxtext.cipher import PROFILE, decrypt_database, open_readonly, verify_key
from wxtext.errors import ToolError
from wxtext.snapshot import inventory, snapshot
from wxtext.state import StateStore, atomic_write
from wxtext.wal import apply_wal
from wxtext.windows import WindowsSource, discover_data_dir_records


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

    def source(self):
        if self.windows is None:
            self.windows = WindowsSource()
        return self.windows

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

    def status(self, dataDir=None, **_):
        root = account_root(dataDir)
        try:
            meta = self.read_active(root)
        except ToolError:
            return {"success": True, "ready": False}
        return {"success": True, "ready": True, "capturedAt": meta["capturedAt"],
                "dataDir": str(root), "accountId": meta["accountId"]}

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
        self.open(str(root))
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

    def open(self, accountDir, hexKey="", **_):
        root = account_root(accountDir)
        meta = self.ensure_snapshot(root)
        if self.meta and meta["directory"] == self.meta["directory"] and root == self.root:
            return True
        self.close()
        self.root, self.meta, self.owner = root, meta, meta["accountId"]
        # Opening the contact database verifies the snapshot is usable.
        self.connection("contact/contact.db")
        return True

    def testConnection(self, accountDir, hexKey="", **_):
        root = account_root(accountDir)
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
        return {"success": True}

    def connection(self, relative):
        if self.meta is None:
            raise ToolError("NOT_CONNECTED", "聊天记录尚未打开。")
        if relative not in self.meta["files"]:
            raise ToolError("DATABASE_UNAVAILABLE", "该数据库未包含在当前副本中。", details={"file": relative})
        if relative not in self.connections:
            self.connections[relative] = open_readonly(Path(self.meta["directory"]) / relative)
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

    def execQuery(self, kind, path=None, sql="", params=None, **_):
        connection = self.connection(self.resolve_db(kind, path or ""))
        rows = connection.execute(sql, params or []).fetchall()
        return {"success": True, "rows": [json_row(row) for row in rows]}

    def contact_rows(self, usernames=None):
        connection = self.connection("contact/contact.db")
        rows = [json_row(row) for row in connection.execute("SELECT * FROM contact")]
        for row in rows:
            username = row.get("username", "")
            row.setdefault("local_type", 2 if "@chatroom" in username else 3 if username.startswith("gh_") else 1)
        return [r for r in rows if not usernames or r.get("username") in usernames]

    def getContact(self, username, **_):
        rows = self.contact_rows([username])
        return {"success": True, "contact": rows[0] if rows else None}

    def getContactsCompact(self, usernames=None, **_):
        return {"success": True, "contacts": self.contact_rows(usernames)}

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

    def shard_messages(self, relative, connection, table, ascending, begin, end):
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
        sql = f"SELECT m.*, n.user_name AS sender_username FROM {quoted(table)} m LEFT JOIN {quoted(mapping)} n ON n.rowid=m.real_sender_id"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY m.create_time {order}, {sequence} {order}, m.local_id {order}"
        for original in connection.execute(sql, params):
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

    def message_stream(self, session_id, ascending=True, begin=0, end=0):
        streams = [self.shard_messages(relative, conn, table, ascending, begin, end)
                   for relative, conn, table in self.message_tables(session_id)]
        key = lambda row: (int(row["create_time"]), int(row["sort_seq"]), int(row["local_id"]), row["_db_path"])
        seen = {}
        for row in heapq.merge(*streams, key=key, reverse=not ascending):
            server = row["server_id"]
            if server != "0":
                signature = hashlib.sha256(json.dumps(
                    [row["message_content"], row["sender_username"], row["create_time"], row["local_type"]],
                    ensure_ascii=False, separators=(",", ":")).encode()).digest()
                if server in seen:
                    if seen[server] != signature:
                        raise ToolError("MESSAGE_CONFLICT", "同一消息 ID 在分库中出现冲突。")
                    continue
                seen[server] = signature
            yield row

    def getMessages(self, sessionId, limit=50, offset=0, **_):
        rows = list(itertools.islice(self.message_stream(sessionId, False), max(0, offset), max(0, offset) + max(1, limit)))
        return {"success": True, "messages": rows}

    def openMessageCursor(self, sessionId, batchSize=100, ascending=False, beginTimestamp=0, endTimestamp=0, **_):
        self.next_cursor += 1
        self.cursors[self.next_cursor] = [iter(self.message_stream(sessionId, ascending, beginTimestamp, endTimestamp)), max(1, batchSize)]
        return {"success": True, "cursor": self.next_cursor}

    def fetchMessageBatch(self, cursor, **_):
        if cursor not in self.cursors:
            raise ToolError("CURSOR_CLOSED", "消息分页已经结束，请重新打开聊天。")
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
            latest = next(self.message_stream(username, False), None)
            if latest:
                result.append({"username": username, "summary": latest["message_content"],
                               "last_timestamp": latest["create_time"], "sort_timestamp": latest["create_time"],
                               "last_msg_type": latest["local_type"], "unread_count": 0})
        result.sort(key=lambda row: row["sort_timestamp"], reverse=True)
        self.session_cache = result
        return {"success": True, "sessions": result}

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
        simple = {"discover", "prepareKeys", "createSnapshot", "status", "snapshotConfig", "exportRaw", "open", "close", "testConnection",
                  "execQuery", "getContact", "getContactsCompact", "listMessageDbs", "listMediaDbs", "getSessions",
                  "getMessages", "openMessageCursor", "fetchMessageBatch", "closeMessageCursor",
                  "getSessionMessageTypeStats", "searchMessages"}
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
        if method in {"setMonitor", "cloudStop", "cloudInit", "cloudReport"}:
            raise ToolError("FEATURE_UNAVAILABLE", "内置后端未实现实时监控或云报告。", details={"method": method})
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
