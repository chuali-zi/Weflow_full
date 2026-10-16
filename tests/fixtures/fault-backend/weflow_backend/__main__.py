"""Synthetic transport peer. Never opens account data or external services."""
import json
import os
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    payload = request.get("payload", {})
    if request["method"] == "cancel":
        continue
    for frame in payload.get("frames", []):
        print(frame, flush=True)
    if payload.get("exit"):
        os._exit(23)
    if payload.get("hang"):
        time.sleep(60)
    if payload.get("malformed"):
        print(json.dumps({"id": request["id"]}), flush=True)
    else:
        print(json.dumps({"id": request["id"], "result": {"success": True, "pid": os.getpid()}}), flush=True)
