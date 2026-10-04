"""Agent-facing preparation commands sharing WeFlow's existing local backend."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from datetime import datetime

from wxtext.errors import ToolError
from wxtext.snapshot import inventory
from wxtext.cipher import verify_database_integrity
from .backend import Backend, account_root, clean_id


EXIT_CODES = {'NEED_EXIT': 10, 'NEED_LOGIN': 11, 'KEY_NOT_FOUND': 12,
              'ACCOUNT_REQUIRED': 13, 'ACCOUNT_DIRECTORY_MISMATCH': 13,
              'SNAPSHOT_REQUIRED': 14, 'GUI_RUNNING': 15, 'PROFILE_LOCKED': 16,
              'CLI_USAGE': 2, 'GUI_NOT_BUILT': 17,
              'LIVE_ENGINE_UNAVAILABLE': 18, 'LIVE_BUSY': 19,
              'LIVE_READ_TIMEOUT': 20, 'SOURCE_REPLACED': 21,
              'CURSOR_STALE': 22, 'CANCELLED': 23}

MODES = ('snapshot', 'live')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ToolError('CLI_USAGE', message, '运行 weflow --help 查看命令。')


def default_profile():
    explicit = os.environ.get('WEFLOW_USER_DATA_PATH')
    return Path(explicit) if explicit else Path(os.environ.get('APPDATA', Path.home())) / 'WeFlow-full'


def parser():
    root = Parser(prog='weflow', description='先在 CLI 准备数据库，再打开 WeFlow 原界面。结果为 JSON，进度写入 stderr。')
    def common(target, suppress=False):
        default = argparse.SUPPRESS if suppress else None
        target.add_argument('--user-data', type=Path, default=default, help='WeFlow 配置及后端状态目录')
        target.add_argument('--data-dir', type=Path, default=default, help='账号 db_storage 或其上级目录')
        target.add_argument('--app', type=Path, default=default, help='指定已安装的 WeFlow.exe')
        target.add_argument('--mode', choices=MODES, default=default,
                            help='读取模式：snapshot（离线副本）或 live（在线短事务）')
        target.add_argument('--quiet', action='store_true', default=argparse.SUPPRESS if suppress else False, help='关闭进度输出')
    common(root)
    commands = root.add_subparsers(dest='command', required=True)
    descriptions = {'doctor': '检查运行环境、微信进程与数据目录', 'accounts': '列出账号目录',
                    'status': '查看密钥缓存及副本状态', 'keys': '获取并缓存逐库密钥',
                    'decrypt': '使用已缓存密钥准备或更新解密副本', 'verify': '验证现有副本与聊天查询',
                    'configure': '将已验证的副本接入原 WeFlow 配置', 'launch': '配置并启动原 WeFlow GUI',
                    'prepare': '依次获取密钥、解密、验证并配置 GUI', 'sessions': '查询副本中的会话',
                    'messages': '分页读取消息', 'search': '搜索消息', 'export': '导出原始 JSONL'}
    for name, description in descriptions.items():
        command = commands.add_parser(name, help=description, description=description)
        common(command, True)
        if name in {'keys', 'prepare'}:
            command.add_argument('--refresh', action='store_true', help='重新扫描密钥，不复用缓存')
        if name in {'decrypt', 'prepare'}:
            command.add_argument('--wait-exit', type=float, default=None, metavar='SECONDS', help='等待微信退出的最长秒数；不会终止进程')
        if name == 'prepare':
            command.add_argument('--launch', action='store_true', help='准备成功后打开 GUI')
        if name in {'messages', 'search', 'export'}:
            command.add_argument('--session', required=name != 'search', help='会话 username')
        if name in {'messages', 'search'}:
            command.add_argument('--limit', type=int, default=50)
            command.add_argument('--offset', type=int, default=0)
        if name == 'search':
            command.add_argument('--keyword', required=True)
        if name == 'export':
            command.add_argument('--output', type=Path, required=True, help='JSONL 输出目录')
    return root


def selected_root(args, backend):
    if args.data_dir:
        return account_root(args.data_dir)
    selected = backend.state.settings().get('data_dir')
    if selected:
        return account_root(selected)
    accounts = backend.discover()['accounts']
    configured = [item for item in accounts if item.get('directorySource') == 'config']
    choices = configured or accounts
    if len(choices) != 1:
        raise ToolError('ACCOUNT_REQUIRED', '请用 --data-dir 选择目标账号目录。',
                        details={'accounts': accounts})
    return Path(choices[0]['dataDir'])


def saved_mode(backend, root):
    """Read the mode without making old backends or old profiles unreadable."""
    state = getattr(backend, 'state', None)
    reader = getattr(state, 'mode', None)
    if callable(reader):
        try:
            value = reader(Path(root).resolve())
        except TypeError:
            value = reader(Path(root).resolve(), None)
        if value in MODES:
            return value
    try:
        settings = state.settings()
        modes = settings.get('database_modes', {}) if isinstance(settings, dict) else {}
        key = os.path.normcase(str(Path(root).resolve()))
        value = modes.get(key) or modes.get(str(Path(root).resolve()))
        if value in MODES:
            return value
    except (AttributeError, TypeError):
        pass
    return 'snapshot'


def selected_mode(args, backend, root):
    explicit = getattr(args, 'mode', None)
    if explicit in MODES:
        return explicit
    return saved_mode(backend, root)


def save_mode(backend, root, mode, explicit=False):
    """Persist only after a successful configure/launch/prepare operation."""
    if not explicit:
        return
    writer = getattr(getattr(backend, 'state', None), 'set_mode', None)
    if not callable(writer):
        return
    writer(Path(root).resolve(), mode)


def connection_status(backend, root, mode):
    getter = getattr(backend, 'getConnectionStatus', None)
    if not callable(getter):
        return None
    try:
        value = getter(str(root), mode=mode)
    except TypeError:
        value = getter(str(root))
    return value if isinstance(value, dict) else None


def freshness(status):
    if not isinstance(status, dict):
        return None
    value = status.get('freshness')
    if isinstance(value, dict):
        result = {key: value[key] for key in ('connectionId', 'revision', 'queriedAt', 'consistency')
                  if key in value}
    else:
        fields = ('connectionId', 'revision', 'queriedAt', 'consistency')
        result = {key: status[key] for key in fields if key in status}
    if not result:
        return None
    result.setdefault('queriedAt', datetime.now().astimezone().isoformat(timespec='seconds'))
    result.setdefault('consistency', 'per_database')
    return result


def with_query_metadata(value, backend, root, mode):
    result = dict(value) if isinstance(value, dict) else {'value': value}
    result.setdefault('mode', mode)
    status = connection_status(backend, root, mode)
    fresh = freshness(status)
    if fresh:
        result.setdefault('freshness', fresh)
    else:
        # A legacy backend cannot provide a connection identity. Keep the
        # timestamp useful while avoiding a made-up identity or revision.
        result.setdefault('freshness', {
            'queriedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
            'consistency': 'per_database'})
    return result


def key_result(result):
    return {name: result[name] for name in ('success', 'accountId', 'dbPath', 'dataDir', 'directorySource',
            'verifiedDatabases', 'unavailableDatabases') if name in result}


def wait_for_exit(backend, seconds):
    if seconds < 0:
        raise ToolError('CLI_USAGE', '--wait-exit 不能为负数。')
    deadline = time.monotonic() + seconds
    notified = False
    while True:
        try:
            backend.source().ensure_stopped()
            return
        except ToolError as error:
            if error.code != 'NEED_EXIT' or time.monotonic() >= deadline:
                raise
            if not notified:
                backend.progress('密钥已缓存，正在等待微信退出。')
                notified = True
            time.sleep(min(1, max(0, deadline - time.monotonic())))


def verify_snapshot(backend, root):
    meta = backend.read_active(root)
    missing = set(inventory(root)) - set(meta.get('files', []))
    if missing:
        raise ToolError('SNAPSHOT_REQUIRED', '副本缺少消息数据库，请重新 decrypt。', details={'missing': sorted(missing)})
    limited = []
    for name in meta['files']:
        path = Path(meta['directory']) / name
        if not path.is_file():
            raise ToolError('SNAPSHOT_REQUIRED', '副本中的数据库文件已不存在，请重新 decrypt。', details={'file': name})
        backend.progress(f'验证副本 {name}')
        validation = verify_database_integrity(path)
        if validation['status'] != 'ok':
            limited.append({'file': name, **validation})
    # An explicit snapshot command must bypass a saved live preference.
    backend.open(str(root), mode='snapshot')
    sessions = backend.getSessions()['sessions']
    sample_count = len(backend.getMessages(sessions[0]['username'], limit=5)['messages']) if sessions else 0
    return {'success': True, 'dataDir': str(root), 'accountId': meta['accountId'],
            'snapshotDirectory': meta['directory'], 'capturedAt': meta['capturedAt'],
            'databaseCount': len(meta['files']), 'sessionCount': len(sessions), 'sampleMessageCount': sample_count,
            'sourceChanged': backend.source_metadata_changed(root, meta), 'limitedChecks': limited}


def verify_live(backend, root):
    """Open and minimally query the source without creating an offline copy."""
    tested = backend.testConnection(str(root), mode='live')
    if isinstance(tested, dict) and tested.get('success') is False:
        raise ToolError(tested.get('code', 'LIVE_ENGINE_UNAVAILABLE'),
                        tested.get('error') or tested.get('message') or '在线连接验证失败。',
                        tested.get('action'), tested.get('details'))
    opened = backend.open(str(root), mode='live')
    if isinstance(opened, dict) and opened.get('success') is False:
        raise ToolError(opened.get('code', 'LIVE_ENGINE_UNAVAILABLE'),
                        opened.get('error') or opened.get('message') or '在线连接打开失败。',
                        opened.get('action'), opened.get('details'))
    sessions = backend.getSessions(mode='live')
    if not isinstance(sessions, dict) or sessions.get('success') is False:
        if isinstance(sessions, dict):
            raise ToolError(sessions.get('code', 'LIVE_ENGINE_UNAVAILABLE'),
                            sessions.get('error') or sessions.get('message') or '在线会话验证失败。',
                            sessions.get('action'), sessions.get('details'))
        raise ToolError('LIVE_ENGINE_UNAVAILABLE', '在线会话验证失败。')
    session_rows = sessions.get('sessions') if isinstance(sessions.get('sessions'), list) else []
    sample_count = 0
    if session_rows:
        sample = backend.getMessages(session_rows[0].get('username', ''), limit=5, mode='live')
        if isinstance(sample, dict):
            sample_count = len(sample.get('messages') or [])
    status = connection_status(backend, root, 'live') or {}
    value = {'success': True, 'mode': 'live', 'dataDir': str(root),
             'accountId': (tested.get('accountId') if isinstance(tested, dict) else None)
             or getattr(backend, 'owner', None) or clean_id(root.parent.name),
             'sessionCount': len(session_rows), 'sampleMessageCount': sample_count}
    for key in ('state', 'complete', 'missingDatabases', 'connectionId', 'revision', 'engine', 'capabilities'):
        if key in status:
            value[key] = status[key]
    if isinstance(tested, dict):
        for key in ('engine', 'capabilities', 'missingDatabases'):
            if key in tested and key not in value:
                value[key] = tested[key]
    fresh = freshness(status)
    value['freshness'] = fresh or {
        'queriedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
        'consistency': 'per_database'}
    return value


def gui_command(args, profile):
    env = dict(os.environ, WEFLOW_USER_DATA_PATH=str(profile), WEFLOW_CONFIG_CWD=str(profile))
    env.pop('ELECTRON_RUN_AS_NODE', None)
    if args.app:
        executable = args.app.resolve()
        if not executable.is_file():
            raise ToolError('GUI_NOT_BUILT', '指定的 WeFlow.exe 不存在。')
        return [str(executable)], executable.parent, env
    if getattr(sys, 'frozen', False):
        directory = Path(sys.executable).resolve().parent.parent.parent
        executable = directory / 'WeFlow.exe'
        if executable.is_file():
            return [str(executable)], directory, env
    else:
        directory = Path(__file__).resolve().parents[2]
        executable = directory / 'node_modules/electron/dist/electron.exe'
        if executable.is_file() and (directory / 'dist-electron/main.js').is_file():
            env.update(WEFLOW_PYTHON=sys.executable, WEFLOW_BACKEND_ROOT=str(directory / 'python'))
            return [str(executable), str(directory)], directory, env
    raise ToolError('GUI_NOT_BUILT', 'WeFlow GUI 尚未构建或找不到。',
                    '源码版先运行“启动 WeFlow.cmd -BuildOnly”；也可用 --app 指定 WeFlow.exe。')


def configure_gui(args, profile, root):
    command, directory, env = gui_command(args, profile)
    mode = getattr(args, '_resolved_mode', None) or getattr(args, 'mode', None) or 'snapshot'
    result = subprocess.run(command + ['--weflow-configure', '--data-dir', str(root), '--mode', mode],
                            cwd=directory, env=env, capture_output=True, encoding='utf-8', errors='replace',
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    lines = [line.split('WEFLOW_CLI_RESULT=', 1)[1] for line in result.stdout.splitlines()
             if line.startswith('WEFLOW_CLI_RESULT=')]
    if not lines:
        raise ToolError('GUI_CONFIG_FAILED', 'WeFlow 未返回配置结果。',
                        '请确认 GUI 已重新构建且支持 --weflow-configure。', {'exitCode': result.returncode})
    value = json.loads(lines[-1])
    if not value.get('success'):
        raise ToolError(value.get('code', 'GUI_CONFIG_FAILED'), value.get('error') or value.get('message') or 'GUI 配置失败。',
                        value.get('action'), value.get('details'))
    if result.returncode:
        raise ToolError('GUI_CONFIG_FAILED', 'WeFlow 配置进程异常退出。', details={'exitCode': result.returncode})
    return value


def launch_gui(args, profile):
    command, directory, env = gui_command(args, profile)
    mode = getattr(args, '_resolved_mode', None) or getattr(args, 'mode', None)
    command += ['--show'] + (['--mode', mode] if mode else [])
    logs = profile / 'logs'
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / 'cli-gui.log'
    with log_path.open('ab') as output:
        process = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=output, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    time.sleep(0.5)
    if process.poll() is not None and process.returncode != 0:
        raise ToolError('GUI_LAUNCH_FAILED', 'WeFlow 启动失败。', details={'exitCode': process.returncode, 'logPath': str(log_path)})
    return {'success': True, 'launched': True, 'pid': process.pid, 'userDataPath': str(profile), 'logPath': str(log_path)}


def execute(args, backend, profile):
    command = args.command
    if command == 'accounts':
        result = backend.discover()
        for item in result.get('accounts', []):
            try:
                item.setdefault('mode', saved_mode(backend, item['dataDir']))
            except (KeyError, TypeError):
                pass
        return result
    if command == 'doctor':
        processes = backend.source().processes()
        accounts = backend.discover()['accounts']
        for item in accounts:
            try:
                item.setdefault('mode', saved_mode(backend, item['dataDir']))
            except (KeyError, TypeError):
                pass
        return {'success': True, 'userDataPath': str(profile), 'backendStatePath': str(backend.state.root),
                'frozen': bool(getattr(sys, 'frozen', False)),
                'wechat': [{'pid': p.pid, 'name': p.name, 'version': p.version} for p in processes],
                'accounts': accounts}
    if command == 'decrypt' and getattr(args, 'mode', None) == 'live':
        raise ToolError('CLI_USAGE', 'decrypt 只支持 snapshot 模式；live 不会创建离线副本。')
    if command in {'prepare', 'decrypt'} and getattr(args, 'mode', None) == 'live' and args.wait_exit is not None:
        raise ToolError('CLI_USAGE', '--wait-exit 只对 snapshot 模式有效。')
    if command == 'keys':
        return key_result(backend.prepareKeys(dataDir=str(args.data_dir) if args.data_dir else None, refresh=args.refresh))
    if command == 'prepare':
        acquired = backend.prepareKeys(dataDir=str(args.data_dir) if args.data_dir else None, refresh=args.refresh)
        root = Path(acquired['dataDir'])
        mode = selected_mode(args, backend, root)
    else:
        root = selected_root(args, backend)
        # decrypt is intentionally snapshot-only. A saved live preference
        # must never turn it into an online operation.
        mode = 'snapshot' if command == 'decrypt' else selected_mode(args, backend, root)
    args._resolved_mode = mode
    if command == 'status':
        value = backend.status(str(root), mode=mode)
        headers = backend.database_headers(root)
        from wxtext.cipher import verify_key
        keys = backend.state.load_keys(root)
        valid = {name for name, key in keys.items() if name in headers and verify_key(key, headers[name])}
        value.update(dataDir=str(root), verifiedDatabases=len(valid), unavailableDatabases=sorted(set(headers) - valid))
        if value.get('ready'):
            meta = backend.read_active(root)
            value.update(databaseCount=len(meta['files']), sourceChanged=backend.source_metadata_changed(root, meta))
        value.setdefault('mode', mode)
        fresh = freshness(value)
        if fresh:
            value.setdefault('freshness', fresh)
        else:
            value['freshness'] = {'queriedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
                                  'consistency': 'per_database'}
        return value
    if command in {'decrypt', 'prepare'}:
        if mode == 'live':
            verified = verify_live(backend, root)
        else:
            wait_for_exit(backend, 0 if args.wait_exit is None else args.wait_exit)
            backend.testConnection(str(root), mode='snapshot')
            verified = verify_snapshot(backend, root)
        if command == 'decrypt':
            return verified
        configured = configure_gui(args, profile, root)
        value = {**verified, 'configured': True, 'verifiedDatabases': acquired['verifiedDatabases'],
                 'unavailableDatabases': acquired.get('unavailableDatabases', []), 'userDataPath': str(profile)}
        save_mode(backend, root, mode, explicit=getattr(args, 'mode', None) is not None)
        if args.launch:
            value.update(launch_gui(args, profile))
        return value
    if command == 'verify':
        return verify_live(backend, root) if mode == 'live' else verify_snapshot(backend, root)
    if command in {'configure', 'launch'}:
        verified = verify_live(backend, root) if mode == 'live' else verify_snapshot(backend, root)
        configured = configure_gui(args, profile, root)
        value = {**verified, 'configured': True, 'userDataPath': str(profile)}
        save_mode(backend, root, mode, explicit=getattr(args, 'mode', None) is not None)
        if command == 'launch':
            value.update(launch_gui(args, profile))
        return value
    if mode == 'snapshot':
        backend.read_active(root)
    backend.open(str(root), mode=mode)
    if command == 'sessions':
        return with_query_metadata(backend.getSessions(mode=mode), backend, root, mode)
    if command in {'messages', 'search'} and (args.limit < 1 or args.offset < 0):
        raise ToolError('CLI_USAGE', '--limit 必须为正数，--offset 不能为负数。')
    if command == 'messages':
        return with_query_metadata(backend.getMessages(args.session, args.limit, args.offset, mode=mode), backend, root, mode)
    if command == 'search':
        return with_query_metadata(backend.searchMessages(args.keyword, args.session, args.limit, args.offset, mode=mode), backend, root, mode)
    if command == 'export':
        return with_query_metadata(backend.exportRaw({'account': {'accountDir': str(root)}, 'sessionIds': [args.session],
                                                      'exportsDir': str(args.output), 'mode': mode}), backend, root, mode)
    raise ToolError('CLI_USAGE', '未知命令。')


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    backend = None
    code = 0
    try:
        args = parser().parse_args(argv)
        profile = (args.user_data or default_profile()).expanduser().resolve()
        def progress(message):
            if not args.quiet:
                print(json.dumps({'type': 'progress', 'message': message}, ensure_ascii=False), file=sys.stderr, flush=True)
        backend = Backend(profile / 'backend', progress=progress)
        result = execute(args, backend, profile)
    except ToolError as error:
        code = EXIT_CODES.get(error.code, 1)
        result = {'success': False, 'code': error.code, 'error': error.message, 'action': error.action, 'details': error.details}
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        code = 1
        result = {'success': False, 'code': type(error).__name__, 'error': '命令执行失败。请检查路径、运行环境和数据库结构。'}
    finally:
        if backend:
            backend.close()
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
