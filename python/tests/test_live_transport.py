"""Persistent RPC checks with native SQLCipher commits and no real account."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from create_live_smoke_fixture import create, mutate


class LiveTransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('WEFLOW_TEST_TMP'))
        self.config = create(self.temp.name)
        self.messages = queue.Queue()
        self.process = subprocess.Popen([sys.executable, '-u', '-m', 'weflow_backend', '--state-dir',
            str(Path(self.config['userDataPath']) / 'backend')], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, encoding='utf-8', env=os.environ.copy())
        def collect():
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        self.reader = threading.Thread(target=collect, daemon=True)
        self.reader.start()
        self.send(71, 'open', {'accountDir': self.config['dataDir'], 'mode': 'live'})
        self.assertIs(self.until(lambda event: event.get('id') == 71)['result'], True)

    def tearDown(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.reader.join(timeout=1)
        self.process.stdout.close()
        self.temp.cleanup()

    def send(self, request_id, method, payload):
        self.process.stdin.write(json.dumps({'id': request_id, 'method': method, 'payload': payload}) + '\n')
        self.process.stdin.flush()

    def until(self, predicate, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                break
            if predicate(event):
                return event
        self.fail('No matching RPC response or change event before deadline')

    def test_idle_commit_event_and_next_query(self):
        mutate(Path(self.config['home']) / 'fixture.json', 'append')
        event = self.until(lambda value: value.get('type') == 'change', timeout=4)
        self.assertEqual(event['payload']['reason'], 'database_commit')
        self.assertEqual(event['payload']['revision'], 1)
        self.assertTrue(event['payload']['connectionId'])
        self.send(83, 'getMessages', {'sessionId': 'wxid_peer', 'limit': 50})
        response = self.until(lambda value: value.get('id') == 83)['result']
        self.assertTrue(response['success'])
        self.assertEqual(len(response['messages']), 25)

    def test_cancel_bypasses_long_request_and_connection_survives(self):
        sql = 'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000000) SELECT sum(x) FROM n'
        self.send(1001, 'execQuery', {'kind': 'contact', 'sql': sql, 'timeoutMs': 10000})
        time.sleep(0.1)
        self.send(1002, 'cancel', {'requestId': 1001})
        response = self.until(lambda value: value.get('id') == 1001)['result']
        self.assertEqual(response.get('code'), 'CANCELLED')
        self.send(1003, 'getMessages', {'sessionId': 'wxid_peer', 'limit': 5})
        self.assertTrue(self.until(lambda value: value.get('id') == 1003)['result']['success'])


if __name__ == '__main__':
    unittest.main()
