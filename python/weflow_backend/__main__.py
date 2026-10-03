"""One persistent stdin/stdout connection; no HTTP service or listening ports."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys
import queue
import threading
import time

from wxtext.errors import ToolError
from .backend import Backend


def serve(state_dir):
    def send(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)
    backend = Backend(state_dir, progress=lambda message: send({"type": "progress", "message": message}))
    requests = queue.Queue()
    eof = threading.Event()

    def read_input():
        try:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                    # Cancellation is deliberately only a flag write here.  SQL
                    # remains exclusively on the main/backend thread.
                    if request.get("method") == "cancel":
                        backend.request_cancel((request.get("payload") or {}).get("requestId"))
                    requests.put(request)
                except Exception:
                    requests.put({"id": None, "method": "__invalid__", "payload": {}})
        finally:
            eof.set()

    reader = threading.Thread(target=read_input, name="weflow-rpc-reader", daemon=True)
    reader.start()
    next_tick = time.monotonic() + 1.0
    try:
        while not (eof.is_set() and requests.empty()):
            request_id = None
            try:
                try:
                    request = requests.get(timeout=0.1)
                except queue.Empty:
                    now = time.monotonic()
                    if now >= next_tick:
                        for event in backend.drain_events() + backend.pollLiveChanges():
                            send(event)
                        next_tick = now + 1.0
                    continue
                request_id = request["id"]
                if request.get("method") == "__invalid__":
                    raise ValueError("invalid request")
                for event in backend.pollLiveChanges():
                    send(event)
                payload = request.get("payload") or {}
                for event in backend.drain_events() + backend.pollLiveChanges():
                    send(event)
                backend.begin_request(request_id, payload.get("timeoutMs", 0 if request.get("method") == "exportRaw" else None))
                result = backend.dispatch(request["method"], payload)
                send({"id": request_id, "result": result})
            except ToolError as error:
                send({"id": request_id, "result": {"success": False, "error": error.message,
                      "code": error.code, "action": error.action, "details": error.details}})
            except Exception as error:
                # Exceptions from SQLite can contain user data. Return only the class.
                message = str(error).casefold()
                code = ("CANCELLED" if "interrupt" in message and backend._request_id in backend._cancelled
                        else "LIVE_READ_TIMEOUT" if "interrupt" in message else type(error).__name__)
                send({"id": request_id, "result": {"success": False,
                      "error": "在线读取已取消。" if code == "CANCELLED" else "在线读取超过时间限制。" if code == "LIVE_READ_TIMEOUT" else "本地数据库操作失败，请检查目录和数据库结构。", "code": code}})
            finally:
                backend.end_request()
            for event in backend.drain_events():
                send(event)
            now = time.monotonic()
            if now >= next_tick:
                for event in backend.pollLiveChanges():
                    send(event)
                next_tick = now + 1.0
    finally:
        backend.close()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'cli':
        from .cli import main as cli_main
        raise SystemExit(cli_main(sys.argv[2:]))
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    serve(args.state_dir)


if __name__ == "__main__":
    main()
