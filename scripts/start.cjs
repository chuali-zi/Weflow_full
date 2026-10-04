const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const candidates = [process.env.WEFLOW_PYTHON, path.join(root, '.venv', 'Scripts', 'python.exe'),
  path.join(root, '.runtime', 'python', 'python.exe')];
const python = candidates.find((candidate) => candidate && fs.existsSync(candidate));
if (!python || !fs.existsSync(path.join(root, 'dist-electron', 'main.js'))) {
  console.error('Please double-click "启动 WeFlow.cmd" to install and build the app first.');
  process.exit(1);
}
const env = { ...process.env, WEFLOW_PYTHON: python, WEFLOW_BACKEND_ROOT: path.join(root, 'python') };
delete env.ELECTRON_RUN_AS_NODE;
const args = process.argv.slice(2);
if (!args.some(arg => arg === '--mode' || arg.startsWith('--mode='))) args.push('--mode', 'live');
const child = spawn(require('electron'), ['.', '--show', ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code || 0; });
