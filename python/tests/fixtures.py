"""Synthetic SQLite accounts; no real WeChat data or running processes."""
import ctypes
import hashlib
import hmac
import json
from pathlib import Path
import sqlite3
import struct
import sys
import uuid

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
import zstandard

from weflow_backend.backend import Backend
from wxtext.adapter import message_table
from wxtext.cipher import DatabaseKey
from wxtext.errors import ToolError
from wxtext.state import StateStore, atomic_write


class FakeWindows:
    def __init__(self, keys=None):
        self.keys = keys or {}
        self.running = False
        self.acquisitions = 0

    def ensure_stopped(self):
        if self.running:
            raise ToolError("NEED_EXIT", "请正常退出微信后继续。")

    def acquire(self, headers, existing, timeout, progress, required=None):
        self.acquisitions += 1
        return {**existing, **self.keys}, {"synthetic": True}


def make_account(home):
    root = home / "微信 数据" / "wxid_me_abcd" / "db_storage"
    (root / "contact").mkdir(parents=True)
    (root / "message").mkdir()
    contact = sqlite3.connect(root / "contact/contact.db")
    contact.executescript("""CREATE TABLE contact(username TEXT PRIMARY KEY, alias TEXT, nick_name TEXT, remark TEXT, local_type INTEGER);
        INSERT INTO contact VALUES('wxid_me','','自己','',1),('wxid_peer','friend','朋友','老朋友',1),('123@chatroom','','测试群','',2);
    """)
    contact.close()
    long_text = "  多行🙂\n" + "完整长文字 " * 2000 + "\n\t结尾  "
    rows = [
        [(1, 9007199254740993, 1, 10, 7, 1700000001, "自己发出的消息", 0),
         (2, 101, 1, 11, 13, 1700000002, zstandard.ZstdCompressor().compress(long_text.encode()), 4),
         (3, 0, 3, 12, 13, 1700000003, '<msg><img md5="abc"/></msg>', 0)],
        [(9, 9007199254740993, 1, 10, 42, 1700000001, "自己发出的消息", 0),
         (10, 0, 1, 13, 1, 1700000004, "相同文字", 0),
         (11, 0, 1, 14, 1, 1700000005, "相同文字", 0)],
    ]
    for index, items in enumerate(rows):
        connection = sqlite3.connect(root / f"message/message_{index}.db")
        me, peer = (7, 13) if index == 0 else (42, 1)
        table = message_table("wxid_peer")
        group = message_table("123@chatroom")
        schema = "(local_id INTEGER PRIMARY KEY, server_id INTEGER, local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content BLOB, WCDB_CT_message_content INTEGER)"
        connection.executescript(f"CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY); CREATE TABLE {table}{schema}; CREATE TABLE {group}{schema};")
        connection.executemany("INSERT INTO Name2Id(rowid,user_name) VALUES(?,?)", [(me, 'wxid_me'), (peer, 'wxid_peer'), (77, '123@chatroom')])
        connection.executemany(f"INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)", items)
        connection.execute(f"INSERT INTO {group} VALUES(?,?,?,?,?,?,?,?)", (1, 200 + index, 1, index, peer, 1700000010 + index, "群里发言", 0))
        connection.commit()
        connection.close()
    return root, long_text


def install_snapshot(backend, root):
    import shutil
    home = backend.active_path(root).parent
    destination = home / uuid.uuid4().hex
    shutil.copytree(root, destination)
    meta = {"directory": str(destination), "dataDir": str(root), "accountId": "wxid_me",
            "capturedAt": "2026-10-02T12:00:00+00:00", "files": [p.relative_to(root).as_posix() for p in root.rglob('*.db')]}
    atomic_write(backend.active_path(root), json.dumps(meta).encode())
    return meta


def encrypt_fixture(path, key):
    """Use native SQLite for reserved-page layout, then an independent AES/HMAC encoder.

    This is a profile fixture, not an independent SQLCipher compatibility claim.
    """
    native = Path(sys.base_prefix) / 'DLLs/sqlite3.dll'
    lib = ctypes.CDLL(str(native))
    lib.sqlite3_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
    lib.sqlite3_file_control.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
    lib.sqlite3_exec.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    lib.sqlite3_close.argtypes = [ctypes.c_void_p]
    handle = ctypes.c_void_p()
    assert lib.sqlite3_open(str(path).encode(), ctypes.byref(handle)) == 0
    try:
        assert lib.sqlite3_exec(handle, b'SELECT name FROM sqlite_master;', None, None, None) == 0
        reserve = ctypes.c_int(80)
        assert lib.sqlite3_file_control(handle, b'main', 38, ctypes.byref(reserve)) == 0
        assert lib.sqlite3_exec(handle, b'VACUUM;', None, None, None) == 0
    finally:
        lib.sqlite3_close(handle)
    data = path.read_bytes()
    assert data[20] == 80
    mac_key = hashlib.pbkdf2_hmac('sha512', key.secret, bytes(v ^ 0x3A for v in key.salt), 2, 32)
    output = bytearray()
    for offset in range(0, len(data), 4096):
        number = offset // 4096 + 1
        page = data[offset:offset + 4096]
        start = 16 if number == 1 else 0
        iv = hashlib.sha256(struct.pack('<I', number) + key.salt).digest()[:16]
        encoder = Cipher(algorithms.AES(key.secret), modes.CBC(iv)).encryptor()
        encrypted = encoder.update(page[start:4016]) + encoder.finalize()
        digest = hmac.digest(mac_key, encrypted + iv + struct.pack('<I', number), 'sha512')
        output.extend((key.salt if number == 1 else b'') + encrypted + iv + digest)
    path.write_bytes(output)


def encrypted_account(home):
    root, text = make_account(home)
    keys = {}
    for index, path in enumerate(sorted(root.rglob('*.db'))):
        key = DatabaseKey(bytes([index + 30]) * 32, bytes([index + 60]) * 16)
        encrypt_fixture(path, key)
        keys[path.relative_to(root).as_posix()] = key
    return root, keys, text
