"""Agent-facing preparation commands sharing WeFlow's existing local backend."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

from wxtext.errors import ToolError
from wxtext.snapshot import inventory
from wxtext.cipher import verify_database_integrity
from .backend import Backend, account_root


EXIT_CODES = {'NEED_EXIT': 10, 'NEED_LOGIN': 11, 'KEY_NOT_FOUND': 12,
              'ACCOUNT_REQUIRED': 13, 'ACCOUNT_DIRECTORY_MISMATCH': 13,
              'SNAPSHOT_REQUIRED': 14, 'GUI_RUNNING': 15, 'PROFILE_LOCKED': 16,
              'CLI_USAGE': 2, 'GUI_NOT_BUILT': 17}


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
            command.add_argument('--wait-exit', type=float, default=0, metavar='SECONDS', help='等待微信退出的最长秒数；不会终止进程')
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
    backend.open(str(root))
    sessions = backend.getSessions()['sessions']
    sample_count = len(backend.getMessages(sessions[0]['username'], limit=5)['messages']) if sessions else 0
    return {'success': True, 'dataDir': str(root), 'accountId': meta['accountId'],
            'snapshotDirectory': meta['directory'], 'capturedAt': meta['capturedAt'],
            'databaseCount': len(meta['files']), 'sessionCount': len(sessions), 'sampleMessageCount': sample_count,
            'sourceChanged': backend.source_metadata_changed(root, meta), 'limitedChecks': limited}


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
    result = subprocess.run(command + ['--weflow-configure', '--data-dir', str(root)],
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
        return backend.discover()
    if command == 'doctor':
        processes = backend.source().processes()
        return {'success': True, 'userDataPath': str(profile), 'backendStatePath': str(backend.state.root),
                'frozen': bool(getattr(sys, 'frozen', False)),
                'wechat': [{'pid': p.pid, 'name': p.name, 'version': p.version} for p in processes],
                'accounts': backend.discover()['accounts']}
    if command == 'keys':
        return key_result(backend.prepareKeys(dataDir=str(args.data_dir) if args.data_dir else None, refresh=args.refresh))
    if command == 'prepare':
        acquired = backend.prepareKeys(dataDir=str(args.data_dir) if args.data_dir else None, refresh=args.refresh)
        root = Path(acquired['dataDir'])
    else:
        root = selected_root(args, backend)
    if command == 'status':
        value = backend.status(str(root))
        headers = backend.database_headers(root)
        from wxtext.cipher import verify_key
        keys = backend.state.load_keys(root)
        valid = {name for name, key in keys.items() if name in headers and verify_key(key, headers[name])}
        value.update(dataDir=str(root), verifiedDatabases=len(valid), unavailableDatabases=sorted(set(headers) - valid))
        if value.get('ready'):
            meta = backend.read_active(root)
            value.update(databaseCount=len(meta['files']), sourceChanged=backend.source_metadata_changed(root, meta))
        return value
    if command in {'decrypt', 'prepare'}:
        wait_for_exit(backend, args.wait_exit)
        backend.testConnection(str(root))
        verified = verify_snapshot(backend, root)
        if command == 'decrypt':
            return verified
        configured = configure_gui(args, profile, root)
        value = {**verified, 'configured': True, 'verifiedDatabases': acquired['verifiedDatabases'],
                 'unavailableDatabases': acquired.get('unavailableDatabases', []), 'userDataPath': str(profile)}
        if args.launch:
            value.update(launch_gui(args, profile))
        return value
    if command == 'verify':
        return verify_snapshot(backend, root)
    if command in {'configure', 'launch'}:
        verified = verify_snapshot(backend, root)
        configured = configure_gui(args, profile, root)
        value = {**verified, 'configured': True, 'userDataPath': str(profile)}
        if command == 'launch':
            value.update(launch_gui(args, profile))
        return value
    # Query commands only use an existing complete snapshot.
    backend.read_active(root)
    backend.open(str(root))
    if command == 'sessions':
        return backend.getSessions()
    if command in {'messages', 'search'} and (args.limit < 1 or args.offset < 0):
        raise ToolError('CLI_USAGE', '--limit 必须为正数，--offset 不能为负数。')
    if command == 'messages':
        return backend.getMessages(args.session, args.limit, args.offset)
    if command == 'search':
        return backend.searchMessages(args.keyword, args.session, args.limit, args.offset)
    if command == 'export':
        return backend.exportRaw({'account': {'accountDir': str(root)}, 'sessionIds': [args.session], 'exportsDir': str(args.output)})
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
