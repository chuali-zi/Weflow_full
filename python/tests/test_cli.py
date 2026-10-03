"""Focused CLI contract tests using synthetic accounts and mocked GUI edges."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from weflow_backend import cli
from weflow_backend.backend import Backend
from wxtext.errors import ToolError
from fixtures import FakeWindows, encrypted_account, install_snapshot, make_account


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('WEFLOW_TEST_TMP'))
        self.home = Path(self.temp.name)
        self.profile = self.home / 'user-data'

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, argv, windows):
        backends = []

        def create_backend(state_dir, progress=lambda message: None):
            backend = Backend(state_dir, windows=windows, progress=progress)
            backends.append(backend)
            return backend

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(cli, 'Backend', side_effect=create_backend), \
             redirect_stdout(stdout), redirect_stderr(stderr):
            code = cli.main(argv)
        return code, json.loads(stdout.getvalue()), stderr.getvalue(), backends

    @unittest.skipUnless(os.name == 'nt', 'DPAPI-backed key cache requires Windows')
    def test_keys_and_status_hide_key_and_prepare_exit_keeps_cache(self):
        root, keys, _ = encrypted_account(self.home)
        windows = FakeWindows(keys)
        common = ['--user-data', str(self.profile), '--data-dir', str(root)]

        code, result, _, backends = self.invoke(common + ['keys', '--quiet'], windows)
        self.assertEqual(code, 0)
        self.assertTrue(result['success'])
        self.assertNotIn('key', result)
        self.assertEqual(result['verifiedDatabases'], len(keys))

        code, status, _, _ = self.invoke(common + ['status', '--quiet'], windows)
        self.assertEqual(code, 0)
        self.assertNotIn('key', status)
        self.assertEqual(status['verifiedDatabases'], len(keys))

        windows.running = True
        configure = Mock(side_effect=AssertionError('GUI configuration must not run before exit'))
        launch = Mock(side_effect=AssertionError('GUI launch must not run before exit'))
        with patch.object(cli, 'configure_gui', configure), patch.object(cli, 'launch_gui', launch):
            code, blocked, _, _ = self.invoke(common + ['prepare', '--launch', '--quiet'], windows)

        self.assertEqual(code, cli.EXIT_CODES['NEED_EXIT'])
        self.assertEqual(blocked['code'], 'NEED_EXIT')
        configure.assert_not_called()
        launch.assert_not_called()
        backend = Backend(self.profile / 'backend', windows=FakeWindows())
        self.assertEqual(len(backend.state.load_keys(root)), len(keys))
        self.assertFalse(backend.active_path(root).exists())
        backend.close()

    def test_failed_gui_configuration_does_not_launch(self):
        root, _ = make_account(self.home)
        backend = Backend(self.profile / 'backend', windows=FakeWindows())
        install_snapshot(backend, root)
        backend.close()

        configure = Mock(side_effect=ToolError('GUI_CONFIG_FAILED', 'synthetic configuration failure'))
        launch = Mock(side_effect=AssertionError('launch must follow successful configuration only'))
        with patch.object(cli, 'configure_gui', configure), patch.object(cli, 'launch_gui', launch):
            code, result, _, _ = self.invoke(
                ['--user-data', str(self.profile), '--data-dir', str(root), 'launch'], FakeWindows())

        self.assertEqual(code, 1)
        self.assertEqual(result['code'], 'GUI_CONFIG_FAILED')
        configure.assert_called_once()
        launch.assert_not_called()

    def test_verify_reports_missing_and_damaged_snapshot(self):
        root, _ = make_account(self.home)
        args = ['--user-data', str(self.profile), '--data-dir', str(root), 'verify', '--quiet']

        code, missing, _, _ = self.invoke(args, FakeWindows())
        self.assertEqual(code, cli.EXIT_CODES['SNAPSHOT_REQUIRED'])
        self.assertEqual(missing['code'], 'SNAPSHOT_REQUIRED')

        backend = Backend(self.profile / 'backend', windows=FakeWindows())
        meta = install_snapshot(backend, root)
        backend.close()
        (Path(meta['directory']) / 'message/message_0.db').unlink()

        code, damaged, _, _ = self.invoke(args, FakeWindows())
        self.assertEqual(code, cli.EXIT_CODES['SNAPSHOT_REQUIRED'])
        self.assertEqual(damaged['code'], 'SNAPSHOT_REQUIRED')
        self.assertEqual(damaged['details']['file'], 'message/message_0.db')


if __name__ == '__main__':
    unittest.main()
