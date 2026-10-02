"""Disk-backed target-only sorting and atomic, repeatable export publication."""
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from .adapter import Contact
from .errors import ToolError


def encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class MessageStore:
    def __init__(self, path: Path):
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA temp_store=MEMORY")
        self.connection.execute("""CREATE TABLE messages (
            id TEXT PRIMARY KEY, timestamp INTEGER, seq INTEGER, shard TEXT,
            local_id INTEGER, semantic TEXT, payload TEXT)""")
        self.duplicates = 0

    def add(self, message: dict) -> None:
        source = message["sources"][0]
        identity = ("server:" + message["message_id"] if message["message_id"] else
                    "local:" + encoded(source))
        semantic = encoded({key: message[key] for key in ("sender_id", "timestamp", "text", "type_code")})
        previous = self.connection.execute("SELECT semantic,payload FROM messages WHERE id=?", (identity,)).fetchone()
        if previous:
            if previous[0] != semantic:
                raise ToolError("MESSAGE_CONFLICT", "同一个消息 ID 在不同来源中内容冲突。",
                                "停止导出并核对这些分库，避免去重时丢失内容。", source)
            payload = json.loads(previous[1])
            if source not in payload["sources"]:
                payload["sources"].append(source)
            self.connection.execute("UPDATE messages SET payload=? WHERE id=?", (encoded(payload), identity))
            self.duplicates += 1
        else:
            self.connection.execute("INSERT INTO messages VALUES (?,?,?,?,?,?,?)", (
                identity, message["timestamp"], message["sort_seq"], source["file"],
                source["local_id"], semantic, encoded(message)))

    def rows(self):
        self.connection.commit()
        for row in self.connection.execute(
                "SELECT payload FROM messages ORDER BY timestamp,seq,shard,local_id,id"):
            yield json.loads(row[0])

    def close(self):
        self.connection.close()


def publish(store: MessageStore, output_root: Path, target: Contact, self_id: str,
            sources: list[dict], stats: Counter) -> dict:
    output_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".wxtext-", dir=output_root) as directory:
        stage = Path(directory) / "result"
        stage.mkdir()
        count, first, last = 0, None, None
        with (stage / "messages.jsonl").open("w", encoding="utf-8", newline="\n") as jsonl, \
                (stage / "messages.txt").open("w", encoding="utf-8", newline="\n") as text:
            text.write(f"私聊：{target.display_name} ({target.user_id})\n自己：{self_id}\n\n")
            for message in store.rows():
                jsonl.write(encoded(message) + "\n")
                local_time = datetime.fromtimestamp(message["timestamp"], timezone.utc).astimezone().isoformat()
                sender = "我" if message["is_self"] else target.display_name
                text.write(f"[{local_time}] {sender} ({message['sender_id']})\n{message['text']}\n\n")
                first = first or message["created_at_utc"]
                last = message["created_at_utc"]
                count += 1
        file_hashes = {name: file_digest(stage / name)
                       for name in ("messages.jsonl", "messages.txt")}
        metadata = {"schema_version": 1, "tool_version": "0.1.0", "scope": "local_private_text",
                    "self_id": self_id, "target": asdict(target), "message_count": count,
                    "first_message_utc": first, "last_message_utc": last, "sources": sources,
                    "statistics": dict(sorted(stats.items())), "duplicates_removed": store.duplicates,
                    "file_sha256": file_hashes,
                    "coverage": "本机快照中的普通文字；不包含媒体、卡片、系统消息或手机独有记录。"}
        (stage / "manifest.json").write_text(encoded(metadata) + "\n", encoding="utf-8")
        export_id = hashlib.sha256(encoded(metadata).encode("utf-8")).hexdigest()[:20]
        destination = output_root / f"private-{export_id}"
        if destination.exists():
            names = ("messages.jsonl", "messages.txt", "manifest.json")
            if destination.is_symlink() or not destination.is_dir() or any(
                    (destination / name).is_symlink() or not (destination / name).is_file() or
                    file_digest(destination / name) != file_digest(stage / name) for name in names):
                raise ToolError("OUTPUT_EXISTS", "已有同名导出目录，但内容不同或不完整。",
                                "选择其他 --out 目录；已有文件不会被覆盖。")
            reused = True
        else:
            os.rename(stage, destination)
            reused = False
        return {"status": "ok", "output": str(destination.resolve()), "message_count": count,
                "reused": reused, "duplicates_removed": store.duplicates}
