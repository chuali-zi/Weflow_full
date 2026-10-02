"""One persistent stdin/stdout connection; no HTTP service or listening ports."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

from wxtext.errors import ToolError
from .backend import Backend


def serve(state_dir):
    def send(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)
    backend = Backend(state_dir, progress=lambda message: send({"type": "progress", "message": message}))
    try:
        for line in sys.stdin:
            request_id = None
            try:
                request = json.loads(line)
                request_id = request["id"]
                result = backend.dispatch(request["method"], request.get("payload") or {})
                send({"id": request_id, "result": result})
            except ToolError as error:
                send({"id": request_id, "result": {"success": False, "error": error.message,
                      "code": error.code, "action": error.action, "details": error.details}})
            except (sqlite3.Error, OSError, ValueError, KeyError, TypeError) as error:
                # Exceptions from SQLite can contain user data. Return only the class.
                send({"id": request_id, "result": {"success": False,
                      "error": "本地数据库操作失败，请检查目录和数据库结构。", "code": type(error).__name__}})
    finally:
        backend.close()


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    serve(args.state_dir)


if __name__ == "__main__":
    main()
