// Electron 43 installs its binary lazily. Prepare it before marking setup complete.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const moduleRoot = path.join(root, 'node_modules', 'electron');
if (fs.existsSync(path.join(moduleRoot, 'dist', 'electron.exe'))) process.exit(0);
const mirrors = [process.env.ELECTRON_MIRROR || '', 'https://npmmirror.com/mirrors/electron/'];
for (const mirror of [...new Set(mirrors)]) {
  console.log(mirror ? 'Preparing Electron from the npm mirror (official checksum verification)...' : 'Preparing Electron from GitHub...');
  const result = spawnSync(process.execPath, [path.join(moduleRoot, 'install.js')], {
    cwd: root, stdio: 'inherit', timeout: 120_000,
    env: { ...process.env, ...(mirror ? { ELECTRON_MIRROR: mirror } : {}) }
  });
  if (result.status === 0 && fs.existsSync(path.join(moduleRoot, 'dist', 'electron.exe'))) process.exit(0);
}
console.error('Electron download failed. Check your connection and run 启动 WeFlow.cmd again.');
process.exit(1);
