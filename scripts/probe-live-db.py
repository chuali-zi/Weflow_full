"""Read-only SQLCipher experiment; does not change the WeFlow backend."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

PROJECT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PROJECT / 'python'), str(PROJECT / '.runtime/hotload/vendor')]

from sqlcipher3 import dbapi2 as sqlcipher
from weflow_backend.backend import Backend, clean_id
from wxtext.cipher import verify_key
from wxtext.state import StateStore
from wxtext.windows import WindowsSource


def emit(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def connect(path, key):
    connection = sqlcipher.connect(path.resolve().as_uri() + '?mode=ro', uri=True,
                                   isolation_level=None, timeout=2)
    try:
        connection.execute('PRAGMA key = "x\'' + key.secret.hex() + key.salt.hex() + '\'"')
        connection.execute('PRAGMA cipher_compatibility=4')
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA trusted_schema=OFF')
        connection.execute('SELECT count(*) FROM sqlite_master').fetchone()
        return connection
    except BaseException:
        connection.close()
        raise


def signature(connection):
    # A short read transaction provides a consistent view within this database.
    connection.execute('BEGIN')
    try:
        names = sorted(row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'")
            if re.fullmatch(r'Msg_[0-9a-fA-F]{32}', row[0]))
        rows = []
        for name in names:
            quoted = '"' + name.replace('"', '""') + '"'
            columns = {row[1] for row in connection.execute('PRAGMA table_info(' + quoted + ')')}
            aggregates = ['count(*)'] + [f'max("{column}")' for column in
                ('local_id', 'server_id', 'create_time', 'sort_seq') if column in columns]
            rows.append((name, tuple(connection.execute('SELECT ' + ','.join(aggregates) +
                        ' FROM ' + quoted).fetchone())))
        connection.execute('COMMIT')
        version = connection.execute('PRAGMA data_version').fetchone()[0]
        digest = hashlib.sha256(json.dumps((version, rows)).encode()).hexdigest()
        return digest, sum(row[1][0] for row in rows), len(rows)
    except BaseException:
        connection.execute('ROLLBACK')
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, default=Path(os.environ['APPDATA']) / 'WeFlow-full/backend')
    parser.add_argument('--watch', type=float, default=0, help='Watch seconds; default is one sample')
    parser.add_argument('--interval', type=float, default=1)
    parser.add_argument('--backend-check', action='store_true', help='Exercise existing session/message queries')
    args = parser.parse_args()
    if args.watch < 0 or args.interval <= 0:
        parser.error('watch must be nonnegative and interval must be positive')
    root = args.data_dir.resolve()
    keys = StateStore(args.state_dir).load_keys(root)
    processes = WindowsSource().processes()
    emit(event='start', wechatRunning=bool(processes), wechatProcesses=len(processes),
         cachedKeys=len(keys), sqliteVersion=sqlcipher.sqlite_version)
    connections = {}
    failures = []
    try:
        for relative, key in sorted(keys.items()):
            path = root / relative
            if not path.resolve().is_relative_to(root) or not path.is_file():
                continue
            try:
                with path.open('rb') as stream:
                    if not verify_key(key, stream.read(4096)):
                        raise ValueError('Cached key does not authenticate database header')
                connections[relative] = connect(path, key)
                emit(event='open', database=relative, success=True,
                     cipherVersion=connections[relative].execute('PRAGMA cipher_version').fetchone()[0],
                     journalMode=connections[relative].execute('PRAGMA journal_mode').fetchone()[0])
            except Exception as error:
                failures.append(relative)
                emit(event='open', database=relative, success=False, error=str(error))
        message_connections = {name: connection for name, connection in connections.items()
                               if re.fullmatch(r'message/message_\d+\.db', name)}
        if args.backend_check and 'contact/contact.db' in connections:
            backend = Backend(args.state_dir)
            backend.root = root
            backend.meta = {'directory': str(root), 'files': list(connections)}
            backend.owner = clean_id(root.parent.name)
            backend.connections = connections
            for connection in connections.values():
                connection.row_factory = sqlcipher.Row
            sessions = backend.getSessions()['sessions']
            target = next((row['username'] for row in sessions if row['username'] == 'filehelper'),
                          sessions[0]['username'] if sessions else None)
            messages = backend.getMessages(target, 5, 0) if target else {'messages': []}
            emit(event='backend', sessions=len(sessions), queriedMessages=len(messages.get('messages', [])),
                 success=messages.get('success', not sessions))
        previous = {}
        changes = 0
        samples = 0
        sample_errors = 0
        deadline = time.monotonic() + args.watch
        while True:
            started = time.monotonic()
            total = 0
            changed = []
            errors = []
            for name, connection in message_connections.items():
                try:
                    value = signature(connection)
                    total += value[1]
                    if name in previous and value[0] != previous[name][0]:
                        changed.append({'database': name, 'before': previous[name][1], 'after': value[1]})
                    previous[name] = value
                except Exception as error:
                    errors.append({'database': name, 'error': str(error)})
            samples += 1
            changes += len(changed)
            sample_errors += len(errors)
            emit(event='sample', sample=samples, messageCount=total, changed=changed, errors=errors,
                 elapsedMs=round((time.monotonic() - started) * 1000))
            if time.monotonic() >= deadline:
                break
            time.sleep(min(args.interval, max(0, deadline - time.monotonic())))
        emit(event='result', openedDatabases=len(connections), failedDatabases=failures,
             messageDatabases=len(message_connections), samples=samples, observedChanges=changes,
             sampleErrors=sample_errors,
             wechatRunning=bool(WindowsSource().processes()))
        return 1 if failures or sample_errors or not message_connections else 0
    finally:
        for connection in connections.values():
            connection.close()


if __name__ == '__main__':
    raise SystemExit(main())
