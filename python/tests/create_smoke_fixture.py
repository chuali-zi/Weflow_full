"""Generate a synthetic account for the Electron integration check."""
import json
from pathlib import Path
import sys
import uuid

from fixtures import make_account, install_snapshot
from weflow_backend.backend import Backend
from wxtext.cipher import DatabaseKey

home = Path(sys.argv[1]).resolve() / uuid.uuid4().hex
home.mkdir(parents=True)
root, _ = make_account(home)
state = home / 'app-data' / 'backend'
backend = Backend(state)
install_snapshot(backend, root)
keys = {p.relative_to(root).as_posix(): DatabaseKey(bytes([index + 1]) * 32, bytes([index + 10]) * 16)
        for index, p in enumerate(sorted(root.rglob('*.db')))}
backend.state.save_keys(root, keys, {'synthetic': True})
backend.state.select(root, 'wxid_me')
backend.close()
print(json.dumps({'dataDir': str(root), 'userDataPath': str(state.parent), 'outputDir': str(home / 'exports'), 'home': str(home)}))
