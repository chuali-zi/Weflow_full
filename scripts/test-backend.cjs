const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const python = [process.env.WEFLOW_PYTHON, path.join(root, '.venv/Scripts/python.exe'),
  path.join(root, '.runtime/python/python.exe')].find(p => p && fs.existsSync(p));
if (!python) throw new Error('Run 启动 WeFlow.cmd -SetupOnly first.');
const temp = path.join(root, '.runtime', 'tests');
fs.mkdirSync(temp, { recursive: true });
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'python/tests', '-v'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONPATH: path.join(root, 'python'), WEFLOW_TEST_TMP: temp }
});
process.exitCode = result.status || 0;
