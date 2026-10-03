const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = [process.env.WEFLOW_PYTHON, path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.runtime', 'python', 'python.exe')].find((item) => item && fs.existsSync(item));
if (!python) throw new Error('Run 启动 WeFlow.cmd -SetupOnly before packaging.');
for (const args of [
  ['-m', 'pip', 'install', '--disable-pip-version-check', '--cache-dir', '.runtime/pip-cache', '-r', 'python/requirements.txt'],
  ['-m', 'pip', 'install', '--disable-pip-version-check', '--cache-dir', '.runtime/pip-cache', 'pyinstaller>=6'],
  ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--name', 'weflow-backend', '--paths', 'python',
    '--collect-all', 'sqlcipher3', '--copy-metadata', 'sqlcipher3',
    '--distpath', 'build/backend', '--workpath', 'build/pyinstaller', '--specpath', 'build', 'python/backend_entry.py']
]) {
  const result = spawnSync(python, args, { cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONPATH: path.join(root, 'python') } });
  if (result.status !== 0) process.exit(result.status || 1);
}
