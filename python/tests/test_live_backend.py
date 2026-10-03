import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from create_live_smoke_fixture import create, mutate, writer
from weflow_backend.backend import Backend
from wxtext.adapter import message_table
from wxtext.cipher import DatabaseKey
from wxtext.errors import ToolError


class LiveBackendTests(unittest.TestCase):
    def test_image_hardlink_and_late_attachment(self):
        relative = 'hardlink/hardlink.db'
        path = self.root / relative
        key = self.keys[relative]
        connection = writer(path, key)
        connection.executescript('DELETE FROM dir2id; DELETE FROM image_hardlink_info_v4;')
        connection.executemany('INSERT INTO dir2id VALUES(?)', [('a' * 32,), ('2026-10',)])
        connection.execute('INSERT INTO image_hardlink_info_v4 VALUES(?,?,?,?,?,?)', ('b' * 32, 'b' * 32 + '_t.dat', 2, 1, 1, 2))
        connection.close()
        self.keys[relative] = key
        self.backend.state.save_keys(self.root, self.keys, {})
        self.backend.open(str(self.root), mode='live')
        self.assertFalse(self.backend.resolveImageHardlink('b' * 32)['success'])
        attachment = self.root.parent / 'msg/attach' / ('a' * 32) / '2026-10/Img' / ('b' * 32 + '_t.dat')
        attachment.parent.mkdir(parents=True)
        attachment.write_bytes(b'late attachment')
        result = self.backend.resolveImageHardlink('b' * 32)
        self.assertTrue(result['success'])
        self.assertEqual(result['data']['full_path'], str(attachment))
        self.assertTrue(self.backend.resolveImageHardlinkBatch([{'md5': 'b' * 32}])['rows'][0]['success'])
        self.assertFalse(self.backend.resolveImageHardlink('../outside')['success'])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('WEFLOW_TEST_TMP'))
        self.config = create(self.temp.name)
        self.root = Path(self.config['dataDir'])
        self.backend = Backend(Path(self.config['userDataPath']) / 'backend')
        self.backend.open(str(self.root), mode='live')
        self.keys = self.backend.state.load_keys(self.root)

    def tearDown(self):
        self.backend.close()
        self.temp.cleanup()

    def test_same_tuple_across_shards_and_cross_page_deduplication(self):
        for index in range(2):
            relative = f'message/message_{index}.db'
            connection = writer(self.root / relative, self.keys[relative])
            connection.execute(f'INSERT INTO {message_table("wxid_peer")} VALUES(?,?,?,?,?,?,?,?)',
                (4000, 5000 + index, 1, 4000, 13 if index == 0 else 1, 1700000020, f'tie-{index}', 0))
            connection.close()
        for ascending in (True, False):
            cursor = self.backend.openMessageCursor('wxid_peer', batchSize=1, ascending=ascending)['cursor']
            rows = []
            while True:
                batch = self.backend.fetchMessageBatch(cursor)
                rows.extend(batch['rows'])
                if not batch['hasMore']:
                    break
            self.backend.closeMessageCursor(cursor)
            self.assertEqual(len(rows), 7)
            self.assertEqual(sum(row['server_id'] == '9007199254740993' for row in rows), 1)
            self.assertEqual(sum(row['server_id'] == '0' for row in rows), 3)
            self.assertEqual({row['message_content'] for row in rows if row['create_time'] == 1700000020}, {'tie-0', 'tie-1'})

    def test_commit_invalidates_cache_and_cursor_without_waiting_for_tick(self):
        self.backend.getSessions()
        self.backend.stats('wxid_peer')
        cursor = self.backend.openMessageCursor('wxid_peer', batchSize=1)['cursor']
        self.backend.fetchMessageBatch(cursor)
        mutate(Path(self.config['home']) / 'fixture.json', 'append')
        with self.assertRaises(ToolError) as caught:
            self.backend.fetchMessageBatch(cursor)
        self.assertEqual(caught.exception.code, 'CURSOR_STALE')
        sessions = self.backend.getSessions()['sessions']
        self.assertEqual(next(row for row in sessions if row['username'] == 'wxid_peer')['summary'], 'live-smoke-19')
        self.assertEqual(self.backend.stats('wxid_peer')['total'], 25)

    def test_missing_new_shard_blocks_partial_results_then_recovers(self):
        previous = self.backend.connection_id
        relative = 'message/message_2.db'
        key = DatabaseKey(bytes([75]) * 32, bytes([85]) * 16)
        connection = writer(self.root / relative, key)
        connection.execute('CREATE TABLE Name2Id(user_name TEXT)')
        connection.close()
        self.backend._last_inventory_check = 0
        self.backend.pollLiveChanges()
        self.backend._reconnect_at = 0
        self.backend.pollLiveChanges()
        status = self.backend.getConnectionStatus()
        self.assertEqual(status['state'], 'needs_key')
        self.assertFalse(status['complete'])
        self.assertIn(relative, status['missingDatabases'])
        with self.assertRaises(ToolError) as caught:
            self.backend.getMessages('wxid_peer')
        self.assertEqual(caught.exception.code, 'KEY_NOT_FOUND')
        self.keys[relative] = key
        self.backend.state.save_keys(self.root, self.keys, {'synthetic': True})
        self.backend._reconnect_at = 0
        events = self.backend.pollLiveChanges()
        self.assertEqual(self.backend.getConnectionStatus()['state'], 'ready')
        self.assertNotEqual(previous, self.backend.connection_id)
        self.assertTrue(any(event.get('payload', {}).get('reason') == 'reconnected' for event in events))
        self.assertEqual(len(self.backend.getMessages('wxid_peer')['messages']), 5)

    def test_readonly_and_wal_commit_checkpoint(self):
        relative = 'message/message_0.db'
        connection = writer(self.root / relative, self.keys[relative])
        table = message_table('wxid_peer')
        connection.execute('BEGIN IMMEDIATE')
        connection.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)',
                           (7000, 7100, 1, 7100, 13, 1700000030, 'committed', 0))
        self.assertEqual(len(self.backend.getMessages('wxid_peer')['messages']), 5)
        connection.execute('COMMIT')
        self.assertEqual(len(self.backend.getMessages('wxid_peer')['messages']), 6)
        connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchall()
        self.assertEqual(len(self.backend.getMessages('wxid_peer')['messages']), 6)
        connection.close()
        with self.assertRaises(Exception):
            self.backend.execQuery('contact', sql='DELETE FROM contact')
        self.assertFalse(any(conn.in_transaction for conn in self.backend.connections.values()))

    def test_export_keeps_one_fixed_transaction_per_database(self):
        original = self.backend.shard_messages
        changed = False
        def capture(*args, **kwargs):
            nonlocal changed
            for row in original(*args, **kwargs):
                if not changed and args[0] == 'message/message_0.db':
                    changed = True
                    connection = writer(self.root / args[0], self.keys[args[0]])
                    connection.execute(f'INSERT INTO {message_table("123@chatroom")} VALUES(?,?,?,?,?,?,?,?)',
                                       (333, 444, 1, 333, 13, 1700000040, 'new group row', 0))
                    connection.close()
                yield row
        output = Path(self.config['home']) / 'exports'
        request = {'account': {'accountDir': str(self.root)}, 'outputDir': str(output),
                   'sessionIds': ['wxid_peer', '123@chatroom'], 'mode': 'live'}
        with patch.object(self.backend, 'shard_messages', side_effect=capture):
            result = self.backend.exportRaw(request)
        self.assertEqual(result['rawExportManifests']['123@chatroom']['rows'], 2)
        self.assertEqual(len(result['databases']), 2)
        self.assertTrue(all(item['captureStartedAt'] <= item['captureFinishedAt'] for item in result['databases']))
        later = self.backend.exportRaw(request)
        self.assertEqual(later['rawExportManifests']['123@chatroom']['rows'], 3)

    def test_export_timeout_rolls_back_and_publishes_nothing(self):
        original = self.backend.shard_messages
        def expired(*args, **kwargs):
            for row in original(*args, **kwargs):
                self.backend._deadline = time.monotonic() - 1
                yield row
        output = Path(self.config['home']) / 'failed-export'
        with patch.object(self.backend, 'shard_messages', side_effect=expired):
            with self.assertRaises(ToolError) as caught:
                self.backend.exportRaw({'account': {'accountDir': str(self.root)}, 'outputDir': str(output),
                                        'sessionIds': ['wxid_peer'], 'mode': 'live'})
        self.assertEqual(caught.exception.code, 'LIVE_READ_TIMEOUT')
        self.assertEqual(list(output.iterdir()), [])
        self.assertFalse(any(conn.in_transaction for conn in self.backend.connections.values()))
        self.assertEqual(len(self.backend.getMessages('wxid_peer')['messages']), 5)


if __name__ == '__main__':
    unittest.main()
