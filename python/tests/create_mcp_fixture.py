"""Generate an unencrypted synthetic account for MCP stdio integration checks."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys
import time
import uuid

from fixtures import make_account, install_snapshot, encrypt_fixture
from weflow_backend.backend import Backend
from wxtext.cipher import DatabaseKey
from wxtext.errors import ToolError
from wxtext.state import StateStore
from wxtext.adapter import message_table


def generate(destination, mode="snapshot"):
    if mode not in {"snapshot", "live"}:
        raise ValueError("mode must be snapshot or live")
    home = Path(destination).resolve() / uuid.uuid4().hex
    home.mkdir(parents=True)
    root, _ = make_account(home)
    profile = home / "profile"
    profile.mkdir()
    (profile / "WeFlow-config.json").write_text("{}", encoding="utf-8")
    state_dir = profile / "backend"
    backend = Backend(state_dir)

    now = int(datetime.now(timezone.utc).timestamp())
    task_start = now - 1800
    large_server_id = 9007199254740993
    long_text = "长文本片段🙂，这是用于 MCP 分页检查的合成正文。" * 260
    assert len(long_text) >= 6000

    contact = sqlite3.connect(root / "contact/contact.db")
    contact.execute("UPDATE contact SET nick_name=? WHERE username='123@chatroom'", ("研发工作群",))
    contact.execute("INSERT INTO contact VALUES(?,?,?,?,?)",
                    ("456@chatroom", "", "研发工作群", "", 2))
    contact.commit()
    contact.close()

    table_peer = message_table("wxid_peer")
    table_work = message_table("123@chatroom")
    table_second = message_table("456@chatroom")
    schema = ("(local_id INTEGER PRIMARY KEY, server_id INTEGER, local_type INTEGER, sort_seq INTEGER, "
              "real_sender_id INTEGER, create_time INTEGER, message_content BLOB, "
              "WCDB_CT_message_content INTEGER)")
    task_rows = [
        (101, 9200001, 1, 101, 13, task_start, "今天由我负责准备周五发布前的回归清单，明天下午提交。", 0),
        (102, 9200002, 1, 102, 7, task_start + 120, "收到，我先覆盖登录和消息同步。", 0),
        (103, 9200003, 1, 103, 13, task_start + 300, "补充：请把截图和失败步骤一起放进清单。", 0),
        (104, 9200004, 1, 104, 13, task_start + 540, "刚才安排的消息同步项先取消，改期到下周一再做。", 0),
        (105, 9200005, 1, 105, 7, task_start + 720, "确认，回归清单今天先交，其余项目下周一开始。", 0),
        (106, 9007199254740995, 1, 106, 7, task_start + 840,
         f'<msg><refermsg><svrid>{large_server_id}</svrid><displayname>同事</displayname>'
         '<content>回归清单安排</content></refermsg>引用这条大 ID 消息确认一下。</msg>', 0),
        (107, 9200007, 1, 107, 7, task_start + 960, long_text, 0),
        (108, 9200008, 49, 108, 7, task_start + 1020,
         '<msg><appmsg><title>这项确认按改期执行。</title><type>57</type><refermsg>'
         '<svrid>9200004</svrid><fromusr>wxid_peer</fromusr>'
         '<content>消息同步项先取消，改期到下周一。</content></refermsg></appmsg></msg>', 0),
    ]
    private_rows = [
        (201, 9300001, 1, 201, 13, now - 900, "你到办公室了吗？", 0),
        (202, 9300002, 1, 202, 7, now - 780, "到了，正在看今天的同步问题。", 0),
        (203, 9300003, 1, 203, 13, now - 660, "我把复现步骤发你了。", 0),
        (204, 9300004, 1, 204, 7, now - 540, "收到，我先按第二步重试。", 0),
        (205, 9300005, 1, 205, 13, now - 420, "好，结果出来后告诉我。", 0),
        (206, 9300006, 1, 206, 7, now - 300, "这里保留一个超过 JS 安全整数的 server ID。", 0),
    ]
    group2_rows = [
        (301, 9400001, 1, 301, 13, task_start + 60, "另一个同名工作群的独立消息。", 0),
        (302, 9400002, 1, 302, 13, task_start + 180, "这里用于区分候选群。", 0),
    ]

    for index in range(2):
        path = root / f"message/message_{index}.db"
        connection = sqlite3.connect(path)
        catalog = {row[0].lower() for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if table_second.lower() not in catalog:
            connection.execute(f"CREATE TABLE {table_second}{schema}")
        connection.execute("INSERT OR IGNORE INTO Name2Id(rowid,user_name) VALUES(?,?)", (88, "456@chatroom"))
        connection.commit()
        connection.close()

    connection = sqlite3.connect(root / "message/message_0.db")
    connection.executemany(f"INSERT INTO {table_work} VALUES(?,?,?,?,?,?,?,?)", task_rows)
    connection.executemany(f"INSERT INTO {table_peer} VALUES(?,?,?,?,?,?,?,?)", private_rows)
    connection.executemany(f"INSERT INTO {table_second} VALUES(?,?,?,?,?,?,?,?)", group2_rows)
    connection.commit()
    connection.close()

    install_snapshot(backend, root)
    if mode == "live":
        keys = {}
        for index, path in enumerate(sorted(root.rglob("*.db"))):
            key = DatabaseKey(bytes([index + 30]) * 32, bytes([index + 60]) * 16)
            encrypt_fixture(path, key)
            keys[path.relative_to(root).as_posix()] = key
        backend.state.save_keys(root, keys, {"synthetic": True})
    backend.state.select(root, "wxid_me")
    backend.state.set_mode(root, mode)
    backend.close()
    (home / ".weflow-mcp-fixture.json").write_text(json.dumps({
        "kind": "weflow-mcp-synthetic", "version": 1, "mode": mode,
        "dataDir": str(root),
    }), encoding="utf-8")

    start = datetime.fromtimestamp(task_start - 300, timezone.utc).isoformat(timespec="seconds")
    end = datetime.fromtimestamp(now + 60, timezone.utc).isoformat(timespec="seconds")
    return {
        "dataDir": str(root),
        "userDataPath": str(profile),
        "home": str(home),
        "sessionIds": ["123@chatroom", "456@chatroom", "wxid_peer"],
        "taskSessionId": "123@chatroom",
        "privateSessionId": "wxid_peer",
        "start": start,
        "end": end,
        "now": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "longTextCharacters": len(long_text),
        "largeServerId": str(large_server_id),
    }


def mutate_live(home):
    """Commit one synthetic task-group row through SQLCipher, never exposing keys."""
    home = Path(home).expanduser().resolve()
    marker_path = home / ".weflow-mcp-fixture.json"
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ToolError("NOT_SYNTHETIC_FIXTURE", "目录不是可变更的 MCP 合成 fixture。") from None
    if marker.get("kind") != "weflow-mcp-synthetic" or marker.get("version") != 1 or marker.get("mode") != "live":
        raise ToolError("NOT_SYNTHETIC_FIXTURE", "仅支持 live 模式的 MCP 合成 fixture。")

    profile = home / "profile"
    try:
        if json.loads((profile / "WeFlow-config.json").read_text(encoding="utf-8")) != {}:
            raise ValueError
        state = StateStore(profile / "backend")
        settings = state.settings()
        root = Path(marker["dataDir"]).resolve()
        if not root.is_relative_to(home) or Path(settings["data_dir"]).resolve() != root:
            raise ValueError
        mode = (settings.get("database_modes") or {}).get(state._mode_key(root))
        if mode != "live":
            raise ValueError
        keys = state.load_keys(root)
        key = keys["message/message_0.db"]
        database = root / "message/message_0.db"
        if not database.is_relative_to(home) or not database.is_file():
            raise ValueError
    except (OSError, KeyError, TypeError, ValueError, ToolError):
        raise ToolError("NOT_SYNTHETIC_FIXTURE", "live 合成 fixture 配置或密钥缓存无法验证。") from None

    try:
        from sqlcipher3 import dbapi2 as sqlcipher
    except ImportError as error:
        raise ToolError("SQLCIPHER_UNAVAILABLE", "当前 Python 环境没有 sqlcipher3。") from error

    connection = sqlcipher.connect(str(database), timeout=2, isolation_level=None)
    try:
        connection.execute("PRAGMA key = \"x'" + (key.secret + key.salt).hex() + "'\"")
        connection.execute("PRAGMA cipher_compatibility = 4")
        table = message_table("123@chatroom")
        next_id = connection.execute(f"SELECT COALESCE(MAX(local_id),0)+1 FROM {table}").fetchone()[0]
        next_seq = connection.execute(f"SELECT COALESCE(MAX(sort_seq),0)+1 FROM {table}").fetchone()[0]
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(f"INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)",
                           (next_id, int(time.time_ns()), 1, next_seq, 13, int(time.time()),
                            "mcp-live-fixture-mutation", 0))
        connection.execute("COMMIT")
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", nargs="?", type=Path,
                        default=Path(__file__).resolve().parents[2] / ".runtime/mcp-test")
    parser.add_argument("--mode", choices=("snapshot", "live"), default="snapshot")
    parser.add_argument("--mutate-live", metavar="HOME", type=Path)
    args = parser.parse_args()
    if args.mutate_live is not None:
        mutate_live(args.mutate_live)
        raise SystemExit(0)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(generate(args.destination, args.mode), ensure_ascii=False))
