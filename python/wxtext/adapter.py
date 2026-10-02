"""WeChat 4.x schema adapter. No fixed numeric sender IDs or text heuristics."""
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import re
import sqlite3

import zstandard

from .errors import ToolError


@dataclass(frozen=True)
class Contact:
    user_id: str
    alias: str = ""
    nickname: str = ""
    remark: str = ""

    @property
    def display_name(self) -> str:
        return self.remark or self.nickname or self.user_id

    @property
    def private(self) -> bool:
        return not ("@" in self.user_id or self.user_id.startswith("gh_"))


def quoted(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def tables(connection: sqlite3.Connection) -> dict[str, str]:
    return {row[0].lower(): row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}


def columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({quoted(table)})")}


def require_columns(connection: sqlite3.Connection, table: str, required: set[str]) -> set[str]:
    actual = columns(connection, table)
    missing = required - actual
    if missing:
        raise ToolError("UNSUPPORTED_SCHEMA", "数据库表结构尚未适配。",
                        "请在 Windows 侧依据实际表结构适配 adapter；不要忽略该分库。",
                        {"table": table, "missing_columns": sorted(missing), "columns": sorted(actual)})
    return actual


def read_contacts(connection: sqlite3.Connection) -> list[Contact]:
    table = tables(connection).get("contact")
    if not table:
        raise ToolError("UNSUPPORTED_SCHEMA", "联系人库缺少 contact 表。")
    available = require_columns(connection, table, {"username"})
    names = ("username", "alias", "nick_name", "remark")
    selection = ",".join(quoted(name) if name in available else "''" for name in names)
    contacts = {}
    for row in connection.execute(f"SELECT {selection} FROM {quoted(table)}"):
        values = [value or "" for value in row]
        if not all(isinstance(value, str) for value in values):
            raise ToolError("UNSUPPORTED_SCHEMA", "联系人名称不是有效的 UTF-8 文本。")
        if not values[0]:
            continue
        contact = Contact(*values)
        previous = contacts.get(contact.user_id)
        if previous and previous != contact:
            raise ToolError("UNSUPPORTED_SCHEMA", "同一联系人 ID 对应冲突记录。")
        contacts[contact.user_id] = contact
    return sorted(contacts.values(), key=lambda contact: contact.user_id)


def search_contacts(contacts: list[Contact], query: str) -> list[dict]:
    needle = query.casefold()
    return [asdict(c) for c in contacts if c.private and any(
        needle in value.casefold() for value in asdict(c).values())]


def resolve_target(contacts: list[Contact], query: str) -> Contact:
    if not query:
        raise ToolError("TARGET_NOT_FOUND", "目标不能为空。")
    exact_id = [c for c in contacts if c.user_id == query]
    exact_alias = [c for c in contacts if c.alias and c.alias == query]
    matches = exact_id or exact_alias or [c for c in contacts if query in (c.nickname, c.remark)]
    if not matches:
        raise ToolError("TARGET_NOT_FOUND", "没有精确匹配的联系人。", "先运行 contacts --query 搜索，再使用 user_id 导出。")
    if len(matches) != 1:
        raise ToolError("AMBIGUOUS_TARGET", "目标名称不唯一。", "用候选人的 user_id 重新导出。",
                        {"candidates": [asdict(c) for c in matches]})
    if not matches[0].private:
        raise ToolError("UNSUPPORTED_TARGET", "首版仅支持个人私聊。")
    return matches[0]


def resolve_self(contacts: list[Contact], account_directory: str, explicit: str | None) -> str:
    if explicit:
        # The owner need not be listed in contact.db, but every message sender is checked below.
        if any(char.isspace() for char in explicit) or "@" in explicit:
            raise ToolError("SELF_ID_REQUIRED", "--self-id 必须是你的稳定微信 ID，而不是昵称。")
        return explicit
    candidates = {account_directory}
    match = re.fullmatch(r"(.+)_([A-Za-z0-9]{4})", account_directory)
    if match:
        candidates.add(match[1])
    matches = [c.user_id for c in contacts if c.user_id in candidates and c.private]
    if len(matches) != 1:
        raise ToolError("SELF_ID_REQUIRED", "无法唯一确认你自己的稳定微信 ID。",
                        "通过 prepare --self-id 指定自己的 user_id；不要填写昵称。")
    return matches[0]


MAX_TEXT_BYTES = 16 * 1024 * 1024
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


def decode_text(content, compression=None, fallback=None) -> str:
    if content is None or content == b"" or content == "":
        if fallback is not None and fallback != b"" and fallback != "":
            content, compression = fallback, None
    if content is None:
        raise ToolError("TEXT_DECODE_FAILED", "文字消息内容为空值。")
    raw = content.encode("utf-8") if isinstance(content, str) else content
    if not isinstance(raw, bytes) or len(raw) > MAX_TEXT_BYTES:
        raise ToolError("TEXT_DECODE_FAILED", "文字内容类型不受支持或超过 16 MiB 限制。")
    if compression not in (None, 0, 4):
        raise ToolError("UNSUPPORTED_COMPRESSION", "发现尚未支持的文字压缩标记。",
                        details={"compression": compression})
    if compression == 4 or raw.startswith(ZSTD_MAGIC):
        try:
            size = zstandard.frame_content_size(raw)
            if size not in (zstandard.CONTENTSIZE_UNKNOWN,) and size > MAX_TEXT_BYTES:
                raise ToolError("TEXT_DECODE_FAILED", "解压文字超过 16 MiB 限制。")
            raw = zstandard.ZstdDecompressor().decompress(
                raw, max_output_size=MAX_TEXT_BYTES, allow_extra_data=False)
        except zstandard.ZstdError:
            raise ToolError("TEXT_DECODE_FAILED", "Zstandard 文字解压失败。") from None
    try:
        return raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise ToolError("TEXT_DECODE_FAILED", "文字不是有效 UTF-8；未尝试截断、猜测或丢弃字节。") from None


def message_table(user_id: str) -> str:
    return "Msg_" + hashlib.md5(user_id.encode("utf-8"), usedforsecurity=False).hexdigest()


def read_messages(connection: sqlite3.Connection, source: str, target: Contact, self_id: str,
                  stats: Counter):
    catalog = tables(connection)
    mapping = catalog.get("name2id")
    if not mapping:
        raise ToolError("UNSUPPORTED_SCHEMA", "消息分库缺少独立的 Name2Id 映射。", details={"file": source})
    require_columns(connection, mapping, {"user_name"})
    table = catalog.get(message_table(target.user_id).lower())
    if not table:
        stats["shards_without_target"] += 1
        return
    stats["shards_with_target"] += 1
    required = {"local_id", "local_type", "real_sender_id", "create_time", "message_content"}
    available = require_columns(connection, table, required)
    extras = {"server_id": "0", "sort_seq": "m.local_id", "compress_content": "NULL",
              "WCDB_CT_message_content": "NULL"}
    selection = [f"m.{quoted(name)}" for name in sorted(required)]
    selection += [f"m.{quoted(name)}" if name in available else f"{default} AS {quoted(name)}"
                  for name, default in extras.items()]
    selection.append("n.user_name AS sender_user_id")
    sql = (f"SELECT {','.join(selection)} FROM {quoted(table)} m "
           f"LEFT JOIN {quoted(mapping)} n ON n.rowid=m.real_sender_id ORDER BY m.local_id")
    for row in connection.execute(sql):
        stats["rows_seen"] += 1
        context = {"file": source, "table": table, "local_id": row["local_id"]}
        try:
            code = row["local_type"]
            if not isinstance(code, int):
                raise ToolError("UNSUPPORTED_SCHEMA", "消息类型不是整数。")
            if code & 0xFFFF != 1:
                stats[f"skipped_type_{code}"] += 1
                continue
            stats["text_rows"] += 1
            sender = row["sender_user_id"]
            if sender not in {self_id, target.user_id}:
                raise ToolError("SENDER_UNRESOLVED", "文字消息发送者无法映射到私聊双方。",
                                "核对 --self-id 与当前分库 Name2Id 映射。",
                                {"sender_reference": row["real_sender_id"]})
            timestamp, local_id = row["create_time"], row["local_id"]
            server_id, seq = row["server_id"] or 0, row["sort_seq"]
            if not all(isinstance(value, int) for value in (timestamp, local_id, server_id, seq)):
                raise ToolError("UNSUPPORTED_SCHEMA", "时间或消息编号不是整数。")
            try:
                utc = datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
            except (ValueError, OverflowError, OSError):
                raise ToolError("UNSUPPORTED_SCHEMA", "时间戳不符合 Unix 秒格式。") from None
            yield {"conversation_id": target.user_id, "self_id": self_id, "peer_id": target.user_id,
                   "sender_id": sender, "is_self": sender == self_id, "timestamp": timestamp,
                   "created_at_utc": utc, "text": decode_text(row["message_content"],
                       row["WCDB_CT_message_content"], row["compress_content"]),
                   "message_id": str(server_id) if server_id else None, "sort_seq": seq,
                   "type_code": code, "sources": [context]}
        except ToolError as error:
            error.details = {**error.details, **context}
            raise
