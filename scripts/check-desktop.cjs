// Exercise the real Electron IPC, database Worker and export Worker with synthetic data.
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = path.join(root, '.venv/Scripts/python.exe');
const fixture = spawnSync(python, ['python/tests/create_smoke_fixture.py', '.runtime/smoke'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.join(root, 'python') }
});
if (fixture.status !== 0) throw new Error(fixture.stderr);
const config = JSON.parse(fixture.stdout);
const env = { ...process.env, WEFLOW_SMOKE_CONFIG: JSON.stringify(config),
  WEFLOW_PYTHON: python, WEFLOW_BACKEND_ROOT: path.join(root, 'python'),
  WEFLOW_USER_DATA_PATH: config.userDataPath, WEFLOW_CONFIG_CWD: config.userDataPath };
if (process.argv.includes('--packaged')) {
  env.WEFLOW_SMOKE_PACKAGED = '1';
  env.WEFLOW_PYTHON = path.join(config.home, 'no-python.exe');
  env.WEFLOW_BACKEND_ROOT = path.join(config.home, 'no-python-source');
}
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['scripts/check-desktop-electron.cjs'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
