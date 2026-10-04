import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from weflow_backend.backend import Backend, account_root
from wxtext.errors import ToolError
from wxtext.state import StateStore
from wxtext.windows import parse_config_paths
from fixtures import FakeWindows, make_account, install_snapshot, encrypted_account, encrypt_fixture
from wxtext.adapter import message_table
from wxtext.cipher import decrypt_database, verify_database_integrity


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('WEFLOW_TEST_TMP'))
        self.home = Path(self.temp.name)
        self.root, self.text = make_account(self.home)
        self.backend = Backend(self.home / 'state', windows=FakeWindows())
        install_snapshot(self.backend, self.root)
        self.backend.open(str(self.root.parent))

    def tearDown(self):
        self.backend.close()
        self.temp.cleanup()

    def test_shards_zstd_senders_and_large_ids(self):
        rows = list(self.backend.message_stream('wxid_peer'))
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[0]['server_id'], '9007199254740993')
        self.assertEqual(rows[0]['computed_is_send'], 1)
        self.assertEqual(rows[1]['message_content'], self.text)
        self.assertEqual(rows[1]['sender_username'], 'wxid_peer')
        self.assertEqual(sum(r['message_content'] == '相同文字' for r in rows), 2)
        self.assertEqual(self.backend.getMessages('wxid_peer', 2, 1)['messages'][0]['create_time'], 1700000004)

    def test_cursor_exact_boundary_and_range(self):
        cursor = self.backend.openMessageCursor('wxid_peer', batchSize=2, ascending=True, beginTimestamp=1700000002, endTimestamp=1700000005)['cursor']
        first = self.backend.fetchMessageBatch(cursor)
        second = self.backend.fetchMessageBatch(cursor)
        self.assertTrue(first['hasMore'])
        self.assertFalse(second['hasMore'])
        self.assertEqual([len(first['rows']), len(second['rows'])], [2, 2])
        self.backend.closeMessageCursor(cursor)
        with self.assertRaises(ToolError):
            self.backend.fetchMessageBatch(cursor)

    def test_locator_and_after_position_are_exact(self):
        rows = list(self.backend.message_stream('wxid_peer', ascending=True))
        locator = {"relativeDb": rows[1]["_relative_db"], "table": rows[1]["_table_name"],
                   "localId": rows[1]["local_id"], "createTime": rows[1]["create_time"]}
        found = self.backend.getMessageByLocator('wxid_peer', locator)['message']
        self.assertEqual(found['local_id'], rows[1]['local_id'])
        self.assertEqual(found['_relative_db'], rows[1]['_relative_db'])
        opened = self.backend.openMessageCursor('wxid_peer', batchSize=2, ascending=True,
            afterPosition=[rows[1]['create_time'], rows[1]['sort_seq'], rows[1]['local_id'], rows[1]['_relative_db']])
        page = self.backend.fetchMessageBatch(opened['cursor'])
        self.assertEqual(page['rows'][0]['local_id'], rows[2]['local_id'])
        around = self.backend.openMessageCursorAround('wxid_peer', locator, 'asc', 2)
        self.assertEqual(self.backend.fetchMessageBatch(around['cursor'])['rows'][0]['local_id'], rows[2]['local_id'])

    def test_open_prepared_snapshot_never_creates_copy_or_saves_selection(self):
        result = self.backend.openPreparedData(dataDir=str(self.root), mode='snapshot')
        self.assertEqual(result['mode'], 'snapshot')
        self.assertEqual(result['capturedAt'], '2026-10-02T12:00:00+00:00')
        before = self.backend.state.settings()
        self.backend.close()
        active = self.backend.active_path(self.root)
        active.unlink()
        with self.assertRaises(ToolError) as error:
            self.backend.openPreparedData(dataDir=str(self.root), mode='snapshot')
        self.assertEqual(error.exception.code, 'SNAPSHOT_REQUIRED')
        self.assertEqual(self.backend.state.settings(), before)

    def test_sessions_search_and_stats_contract(self):
        sessions = self.backend.getSessions()['sessions']
        self.assertEqual({s['username'] for s in sessions}, {'wxid_peer', '123@chatroom'})
        hits = self.backend.searchMessages('相同')['messages']
        self.assertEqual(len(hits), 2)
        self.assertEqual(hits[0]['_session_id'], 'wxid_peer')
        types = self.backend.getSessionMessageTypeStats('wxid_peer')['data']
        self.assertEqual(types['total_messages'], 5)
        self.assertEqual(types['image_messages'], 1)
        self.assertEqual(types['first_timestamp'], 1700000001)
        self.assertEqual(sum(types['date_counts'].values()), 5)
        group = self.backend.dispatch('getGroupStats', {'chatroomId': '123@chatroom'})['data']
        self.assertEqual(group['sessions']['123@chatroom']['senders']['wxid_peer'], 2)
        self.assertEqual(self.backend.dispatch('getAvailableYears', {'sessionIds': ['wxid_peer']})['data'], [2023])

    def test_readonly_sql_and_source_is_never_opened(self):
        before = {p: hashlib.sha256(p.read_bytes()).digest() for p in self.root.rglob('*.db')}
        result = self.backend.execQuery('contact', sql='SELECT username FROM contact')
        self.assertEqual(len(result['rows']), 3)
        with self.assertRaises(sqlite3.OperationalError):
            self.backend.execQuery('contact', sql='DELETE FROM contact')
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).digest() for p in self.root.rglob('*.db')})
        with self.assertRaises(ToolError):
            self.backend.dispatch('getGroupMemberCount', {'chatroomId': '123@chatroom'})

    def test_export_raw_stream_and_range(self):
        output = self.home / 'exports'
        result = self.backend.exportRaw({'account': {'accountDir': str(self.root.parent)},
            'outputDir': str(output), 'sessionIds': ['wxid_peer'], 'options': {'dateRange': {'start': 1700000002, 'end': 1700000004}}})
        path = Path(result['rawSessionOutputPaths']['wxid_peer'])
        rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]['message_content'], self.text)
        self.assertEqual(result['rawExportManifests']['wxid_peer']['rows'], 3)
        session_db = self.root / 'session/session.db'
        session_db.parent.mkdir(parents=True)
        session_db.write_bytes(b'synthetic session database path')
        fallback = self.backend.exportRaw({'account': {'sessionDb': str(session_db)},
            'outputDir': str(self.home / 'exports-from-session-path'), 'sessionIds': ['wxid_peer']})
        self.assertEqual(fallback['successCount'], 1)
        with self.assertRaises(ToolError) as caught:
            self.backend.exportRaw({'account': {}, 'outputDir': str(self.home / 'missing-account'), 'sessionIds': []})
        self.assertEqual(caught.exception.code, 'ACCOUNT_REQUIRED')
        with self.assertRaises(ToolError):
            self.backend.exportRaw({'account': {'accountDir': str(self.root.parent)}, 'outputDir': str(self.root / 'export'), 'sessionIds': []})

    def test_persistent_stdio_protocol(self):
        requests = [dict(id=1, method='open', payload={'accountDir': str(self.root.parent)}),
                    dict(id=2, method='getMessageCount', payload={'sessionId': 'wxid_peer'}),
                    dict(id=3, method='unknown', payload={})]
        result = subprocess.run([sys.executable, '-m', 'weflow_backend', '--state-dir', str(self.home / 'state')],
            input=''.join(json.dumps(r) + '\n' for r in requests), text=True, encoding='utf-8', capture_output=True, check=True)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertIs(replies[0]['result'], True)
        self.assertEqual(replies[1]['result']['count'], 5)
        self.assertEqual(replies[2]['result']['code'], 'FEATURE_UNAVAILABLE')
        self.assertEqual(result.stderr, '')

    def test_wechat_ini_accepts_bare_path_and_key_value(self):
        bare = parse_config_paths(b'D:\\wechat\r\n')
        keyed = parse_config_paths('DataDir=D:\\wechat\r\n'.encode('utf-16'))
        self.assertEqual([str(path) for path in bare], ['D:\\wechat'])
        self.assertEqual([str(path) for path in keyed], ['D:\\wechat'])

    def test_integrity_check_limits_only_verified_missing_custom_fts_tokenizer(self):
        regular = verify_database_integrity(self.root / 'contact/contact.db')
        self.assertEqual(regular['status'], 'ok')

        path = self.home / 'custom-fts.db'
        connection = sqlite3.connect(path)
        connection.execute('CREATE VIRTUAL TABLE fts_probe USING fts5(value)')
        connection.execute("INSERT INTO fts_probe(value) VALUES('synthetic fixture text')")
        connection.execute('PRAGMA writable_schema=ON')
        connection.execute("UPDATE sqlite_master SET sql=? WHERE name='fts_probe'",
                           ("CREATE VIRTUAL TABLE fts_probe USING fts5(value, tokenize='MMFtsTokenizer disable_pinyin')",))
        connection.execute('PRAGMA writable_schema=OFF')
        connection.commit()
        connection.close()

        limited = verify_database_integrity(path)
        self.assertEqual(limited['status'], 'limited_custom_fts')
        self.assertEqual(limited['check'], 'all_btree_tables')
        self.assertEqual(limited['fts_tables_skipped'], ['fts_probe'])
        self.assertGreater(limited['tables_checked'], 0)

    def test_account_root_without_argument_uses_records(self):
        with patch('weflow_backend.backend.discover_data_dir_records',
                   return_value=[{'dataDir': self.root}]) as discover:
            self.assertEqual(account_root(), self.root.resolve())
        discover.assert_called_once_with()


@unittest.skipUnless(os.name == 'nt', 'Windows native SQLite fixture')
class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('WEFLOW_TEST_TMP'))
        self.home = Path(self.temp.name)
        self.root, keys, self.text = encrypted_account(self.home)
        self.windows = FakeWindows(keys)
        self.backend = Backend(self.home / 'state', windows=self.windows)

    def tearDown(self):
        self.backend.close()
        self.temp.cleanup()

    def test_encrypted_preparation_dpapi_reopen_and_source_preserved(self):
        before = {p: p.read_bytes() for p in self.root.rglob('*.db')}
        first = self.backend.prepareKeys(str(self.root))
        self.assertEqual(first['verifiedDatabases'], 4)
        self.assertEqual(len(self.windows.last_required), 4)
        self.backend.prepareKeys(str(self.root))
        self.assertEqual(self.windows.acquisitions, 1)
        sealed = self.backend.state.cache_path(self.root).read_bytes()
        self.assertNotIn(first['key'].encode(), sealed)
        self.windows.running = True
        with self.assertRaisesRegex(ToolError, 'NEED_EXIT'):
            self.backend.createSnapshot(str(self.root))
        self.windows.running = False
        result = self.backend.testConnection(str(self.root.parent))
        self.assertTrue(result['success'])
        self.assertTrue(Path(self.backend.read_active(self.root)['directory']).is_dir())
        self.backend.open(str(self.root.parent))
        self.assertEqual(len(list(self.backend.message_stream('wxid_peer'))), 5)
        self.assertEqual(self.backend.snapshotConfig(str(self.root))['accountId'], 'wxid_me')
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*.db')})
        self.assertEqual(list(self.backend.state.work_root().iterdir()), [])

        # A valid core cache must still trigger one bounded pass to recover
        # optional WeFlow databases missing from the cache.
        cached = self.backend.state.load_keys(self.root)
        cached.pop('media/media_0.db')
        self.backend.state.save_keys(self.root, cached, {'synthetic': True})
        repaired = self.backend.prepareKeys(str(self.root))
        self.assertEqual(repaired['verifiedDatabases'], 4)
        self.assertEqual(self.windows.acquisitions, 2)

    def test_failed_update_keeps_previous_snapshot(self):
        self.backend.prepareKeys(str(self.root))
        old = self.backend.createSnapshot(str(self.root))
        source = self.root / 'message/message_0.db'
        corrupted = bytearray(source.read_bytes())
        corrupted[-1] ^= 1
        source.write_bytes(corrupted)
        with self.assertRaisesRegex(ToolError, 'PAGE_AUTH_FAILED'):
            self.backend.createSnapshot(str(self.root))
        self.assertEqual(self.backend.read_active(self.root)['directory'], old['directory'])
        self.backend.open(str(self.root.parent))
        self.assertEqual(self.backend.dispatch('getMessageCount', {'sessionId': 'wxid_peer'})['count'], 5)

    def test_connect_refreshes_changed_sources_and_keeps_old_snapshot_on_failure(self):
        self.backend.prepareKeys(str(self.root))
        initial = self.backend.createSnapshot(str(self.root))
        source = self.root / 'message/message_0.db'
        key = self.backend.state.load_keys(self.root)['message/message_0.db']
        plaintext = self.home / 'message-update.db'
        decrypt_database(source, plaintext, key)
        connection = sqlite3.connect(plaintext)
        connection.execute(f'INSERT INTO "{message_table("wxid_peer")}" VALUES(?,?,?,?,?,?,?,?)',
                            (12, 999, 1, 15, 7, 1700000006, '更新后的新消息', 0))
        connection.commit()
        connection.close()
        encrypt_fixture(plaintext, key)
        source.write_bytes(plaintext.read_bytes())

        self.windows.running = True
        with self.assertRaisesRegex(ToolError, 'NEED_EXIT'):
            self.backend.testConnection(str(self.root.parent))
        self.assertEqual(self.backend.read_active(self.root)['directory'], initial['directory'])
        self.backend.open(str(self.root.parent))
        self.assertEqual(self.backend.dispatch('getMessageCount', {'sessionId': 'wxid_peer'})['count'], 5)
        self.backend.close()

        self.windows.running = False
        self.backend.testConnection(str(self.root.parent))
        updated = self.backend.read_active(self.root)
        self.assertNotEqual(updated['directory'], initial['directory'])
        self.backend.open(str(self.root.parent))
        rows = list(self.backend.message_stream('wxid_peer'))
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[-1]['message_content'], '更新后的新消息')

        active_before_failure = updated['directory']
        corrupted = bytearray(source.read_bytes())
        corrupted[-1] ^= 1
        source.write_bytes(corrupted)
        with self.assertRaisesRegex(ToolError, 'PAGE_AUTH_FAILED'):
            self.backend.testConnection(str(self.root.parent))
        self.assertEqual(self.backend.read_active(self.root)['directory'], active_before_failure)

    def test_duplicate_same_account_directory_is_authenticated_or_reported(self):
        stale_root, _, _ = encrypted_account(self.home / 'C')
        from fixtures import make_account, encrypt_fixture
        from wxtext.cipher import DatabaseKey
        configured_root, _ = make_account(self.home / 'D')
        configured_keys = {}
        for index, path in enumerate(sorted(configured_root.rglob('*.db'))):
            relative = path.relative_to(configured_root).as_posix()
            key = DatabaseKey(bytes([90 + index]) * 32, bytes([120 + index]) * 16)
            encrypt_fixture(path, key)
            configured_keys[relative] = key
        records = [
            {'dataDir': stale_root, 'source': 'documents'},
            {'dataDir': configured_root, 'source': 'config'},
        ]
        self.backend.windows = FakeWindows(configured_keys)
        with patch('weflow_backend.backend.discover_data_dir_records', return_value=records):
            with self.assertRaises(ToolError) as caught:
                self.backend.prepareKeys(str(stale_root))
            self.assertEqual(caught.exception.code, 'ACCOUNT_DIRECTORY_MISMATCH')
            self.assertEqual(caught.exception.details['suggestedDataDir'], str(configured_root))

            # The automatic path uses the configured directory after the
            # same current-process keys authenticate it uniquely.
            result = self.backend.prepareKeys()
        self.assertEqual(Path(result['dataDir']), configured_root)
        self.assertEqual(result['directorySource'], 'config')

    def test_complete_selected_config_cache_ignores_other_stale_cache(self):
        stale_root, stale_keys, _ = encrypted_account(self.home / 'C')
        from fixtures import make_account, encrypt_fixture
        from wxtext.cipher import DatabaseKey
        configured_root, _ = make_account(self.home / 'D')
        configured_keys = {}
        for index, path in enumerate(sorted(configured_root.rglob('*.db'))):
            relative = path.relative_to(configured_root).as_posix()
            key = DatabaseKey(bytes([110 + index]) * 32, bytes([140 + index]) * 16)
            encrypt_fixture(path, key)
            configured_keys[relative] = key
        self.backend.state.save_keys(stale_root, stale_keys, {'synthetic': True})
        self.backend.state.save_keys(configured_root, configured_keys, {'synthetic': True})
        self.backend.state.select(stale_root, 'wxid_me', 'documents')
        self.backend.windows = FakeWindows()
        records = [
            {'dataDir': stale_root, 'source': 'documents'},
            {'dataDir': configured_root, 'source': 'config'},
        ]
        with patch('weflow_backend.backend.discover_data_dir_records', return_value=records):
            explicit = self.backend.prepareKeys(str(configured_root))
            automatic = self.backend.prepareKeys()
        self.assertEqual(Path(explicit['dataDir']), configured_root)
        self.assertEqual(Path(automatic['dataDir']), configured_root)
        self.assertEqual(self.backend.windows.acquisitions, 0)


if __name__ == '__main__':
    unittest.main()
