"""Native SQLCipher fixture and commits for the desktop hot-loading check."""
import json
import hashlib
from pathlib import Path
import sqlite3
import sys
import uuid

from sqlcipher3 import dbapi2 as sqlcipher
from fixtures import make_account, install_snapshot
from weflow_backend.backend import Backend
from wxtext.adapter import message_table
from wxtext.cipher import DatabaseKey
from test_image_keys import encode_v2

IMAGE_MD5 = 'b' * 32
IMAGE_PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082')


def writer(path, key):
    connection = sqlcipher.connect(str(path), isolation_level=None)
    connection.execute('PRAGMA key = "x\'' + (key.secret + key.salt).hex() + '\'"')
    connection.execute('PRAGMA cipher_compatibility = 4')
    connection.execute('PRAGMA journal_mode = WAL')
    return connection


def create(destination):
    home = Path(destination).resolve() / uuid.uuid4().hex
    home.mkdir(parents=True)
    root, _ = make_account(home)
    (root / 'hardlink').mkdir()
    hardlink = sqlite3.connect(root / 'hardlink/hardlink.db')
    hardlink.executescript('CREATE TABLE dir2id(username TEXT PRIMARY KEY); CREATE TABLE image_hardlink_info_v4(md5 TEXT,file_name TEXT,type INTEGER,modify_time INTEGER,dir1 INTEGER,dir2 INTEGER);')
    hardlink.executemany('INSERT INTO dir2id VALUES(?)', [(hashlib.md5(b'wxid_peer').hexdigest(),), ('2023-11',)])
    hardlink.execute('INSERT INTO image_hardlink_info_v4 VALUES(?,?,?,?,?,?)', (IMAGE_MD5, IMAGE_MD5 + '_t.dat', 2, 1, 1, 2))
    hardlink.commit()
    hardlink.close()
    backend = Backend(home / 'app-data' / 'backend')
    install_snapshot(backend, root)
    keys = {}
    for index, path in enumerate(sorted(root.rglob('*.db'))):
        plain = sqlite3.connect(path)
        if path.name == 'message_0.db':
            plain.execute(f'UPDATE {message_table("wxid_peer")} SET message_content=?, WCDB_CT_message_content=0 WHERE local_id=2', ('fixture baseline',))
            plain.commit()
        script = '\n'.join(plain.iterdump())
        senders = plain.execute('SELECT rowid, user_name FROM Name2Id').fetchall() if path.parent.name == 'message' else None
        plain.close()
        path.unlink()
        key = DatabaseKey(bytes([index + 1]) * 32, bytes([index + 10]) * 16)
        connection = writer(path, key)
        connection.executescript(script)
        if senders is not None:
            connection.execute('DELETE FROM Name2Id')
            connection.executemany('INSERT INTO Name2Id(rowid,user_name) VALUES(?,?)', senders)
        connection.close()
        keys[path.relative_to(root).as_posix()] = key
    backend.state.save_keys(root, keys, {'synthetic': True})
    backend.state.select(root, 'wxid_me')
    backend.close()
    result = {'dataDir': str(root), 'userDataPath': str(home / 'app-data'),
              'outputDir': str(home / 'exports'), 'home': str(home), 'sessionId': 'wxid_peer'}
    (home / 'fixture.json').write_text(json.dumps(result), encoding='utf-8')
    return result


def mutate(config_path, action):
    config = json.loads(Path(config_path).read_text(encoding='utf-8-sig'))
    root = Path(config['dataDir'])
    if action == 'image-file':
        path = root.parent / 'msg/attach' / hashlib.md5(b'wxid_peer').hexdigest() / '2023-11/Img' / (IMAGE_MD5 + '_t.dat')
        path.parent.mkdir(parents=True)
        path.write_bytes(encode_v2(IMAGE_PNG))
        return {'success': True, 'action': action}
    backend = Backend(Path(config['userDataPath']) / 'backend')
    connection = writer(root / 'message/message_0.db', backend.state.load_keys(root)['message/message_0.db'])
    table = message_table('wxid_peer')
    connection.execute('BEGIN IMMEDIATE')
    if action == 'append':
        connection.executemany(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)',
            [(1000 + index, 8000 + index, 1, 1000 + index, 13, 1700000012,
              f'live-smoke-{index:02}', 0) for index in range(20)])
    elif action == 'edit':
        connection.execute(f'UPDATE {table} SET message_content=? WHERE local_id=1019', ('live-smoke-edited',))
    elif action == 'delete':
        connection.execute(f'DELETE FROM {table} WHERE local_id=1018')
    elif action == 'history':
        connection.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)',
                           (2000, 9900, 1, 4, 13, 1700000002, 'live-smoke-history', 0))
    elif action == 'image-message':
        connection.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)',
                           (3000, 10000, 3, 3000, 13, 1700000013, f'<msg><img md5="{IMAGE_MD5}" /></msg>', 0))
    else:
        raise ValueError('Unknown fixture action')
    connection.execute('COMMIT')
    connection.close()
    backend.close()
    return {'success': True, 'action': action}


if __name__ == '__main__':
    result = mutate(sys.argv[2], sys.argv[1]) if sys.argv[1] in {'append', 'edit', 'delete', 'history', 'image-message', 'image-file'} else create(sys.argv[1])
    print(json.dumps(result))
