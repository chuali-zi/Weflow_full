import argparse
import json
from pathlib import Path
import sqlite3
import sys

from . import __version__
from .errors import ToolError
from .service import ExportService
from .state import StateStore, default_state_root
from .windows import WindowsSource, discover_data_dirs


def parser():
    root = argparse.ArgumentParser(prog="wxtext", description="本地导出 Windows 微信 4.x 的指定私聊文字。")
    root.add_argument("--version", action="version", version=__version__)
    commands = root.add_subparsers(dest="command", required=True)
    for name, help_text in (("doctor", "检查环境与账号目录"), ("prepare", "登录时采集并缓存密钥"),
                            ("contacts", "微信退出后搜索联系人"), ("export", "微信退出后导出指定私聊")):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--data-dir", type=Path, help="自己的 db_storage 目录；首次选定后记住")
        command.add_argument("--state-dir", type=Path, default=default_state_root(), help="本地运行状态目录")
        command.add_argument("--json", action="store_true", help="JSON 结果写 stdout；诊断写 stderr")
        if name in {"prepare", "export"}:
            command.add_argument("--self-id", help="自己的稳定微信 ID；无法自动确定时使用")
        if name == "prepare":
            command.add_argument("--scan-timeout", type=float, default=60, help="主要扫描时限秒数，另有最多 10 秒主密钥回退")
            command.add_argument("--refresh", action="store_true", help="重新采集并替换该账号缓存")
        elif name == "contacts":
            command.add_argument("--query", required=True)
        elif name == "export":
            command.add_argument("--target", required=True, help="目标 user_id、微信号、唯一昵称或备注")
            command.add_argument("--out", type=Path, default=Path("exports"))
    return root


def show(result: dict, machine: bool):
    if machine:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    elif result.get("status") == "error":
        print(f"{result['code']}: {result['message']}", file=sys.stderr)
        if result.get("action"):
            print(result["action"], file=sys.stderr)
        if result.get("details"):
            print(json.dumps(result["details"], ensure_ascii=False, indent=2), file=sys.stderr)
    elif "contacts" in result:
        for contact in result["contacts"]:
            print(json.dumps(contact, ensure_ascii=False))
        print(f"匹配 {len(result['contacts'])} 位联系人。", file=sys.stderr)
    elif "output" in result:
        print(f"已导出 {result['message_count']} 条文字：{result['output']}")
    elif result.get("code") == "KEYS_READY":
        print(f"已验证并加密缓存 {result['verified_databases']} 个数据库密钥。")
        print(result["action"])
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))


def main(argv=None, service_factory=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    args = parser().parse_args(argv)
    try:
        if args.command == "prepare" and not 1 <= args.scan_timeout <= 600:
            raise ToolError("INVALID_ARGUMENT", "--scan-timeout 必须在 1 到 600 秒之间。")
        if service_factory is None:
            service = ExportService(StateStore(args.state_dir), WindowsSource(), discover_data_dirs,
                                    lambda message: print(message, file=sys.stderr, flush=True))
        else:
            service = service_factory(args)
        if args.command == "doctor":
            result = service.doctor(args.data_dir)
        elif args.command == "prepare":
            result = service.prepare(args.data_dir, args.self_id, args.scan_timeout, args.refresh)
        elif args.command == "contacts":
            result = service.contacts(args.query, args.data_dir)
        else:
            result = service.export(args.target, args.out, args.data_dir, args.self_id)
        show(result, args.json)
        return 0
    except ToolError as error:
        show(error.as_dict(), args.json)
        return 2
    except KeyboardInterrupt:
        show(ToolError("INTERRUPTED", "操作已中断；未发布的临时文件会清理。").as_dict(), args.json)
        return 130
    except sqlite3.DatabaseError:
        show(ToolError("DATABASE_ERROR", "SQLite 查询失败，导出未完成。",
                       "可能是尚未适配的数据库结构；在本机检查 schema。错误日志不包含消息正文。").as_dict(), args.json)
        return 3
    except OSError as error:
        show(ToolError("IO_ERROR", "本地文件或系统操作失败。", "检查路径、空间与文件访问权限。",
                       {"errno": error.errno, "winerror": getattr(error, "winerror", None)}).as_dict(), args.json)
        return 3
    except Exception as error:
        # Include a code location, never exception text or frame locals from user data.
        import traceback
        frame = traceback.extract_tb(error.__traceback__)[-1]
        show(ToolError("INTERNAL_ERROR", "发生尚未处理的本地适配错误，导出未完成。",
                       "根据以下代码位置在本机排查；不要上传密钥或聊天数据库。",
                       {"exception_type": type(error).__name__, "module": Path(frame.filename).name,
                        "line": frame.lineno}).as_dict(), args.json)
        return 3
