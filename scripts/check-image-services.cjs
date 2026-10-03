const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, '.runtime/image-check.cjs');
require('esbuild').buildSync({ entryPoints: [path.join(root, 'scripts/check-image-services.ts')],
  outfile: target, bundle: true, packages: 'external', platform: 'node', format: 'cjs' });
fs.copyFileSync(path.join(root, 'dist-electron/localWcdbWorker.js'), path.join(root, '.runtime/localWcdbWorker.js'));
const heicWorker = path.join(root, '.runtime/heicDecodeWorker.js');
if (process.env.WEFLOW_IMAGE_RESOURCES) {
  // Resolve both the worker and its decoder dependencies from the actual asar.
  fs.writeFileSync(heicWorker, `require(${JSON.stringify(path.join(process.env.WEFLOW_IMAGE_RESOURCES, 'app.asar/dist-electron/heicDecodeWorker.js'))});`);
} else {
  fs.copyFileSync(path.join(root, 'dist-electron/heicDecodeWorker.js'), heicWorker);
}
const env = { ...process.env, WEFLOW_PYTHON: path.join(root, '.venv/Scripts/python.exe'),
  WEFLOW_BACKEND_ROOT: path.join(root, 'python'), WEFLOW_CONFIG_CWD: process.env.WEFLOW_USER_DATA_PATH };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [target], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code || 0; });
child.on('error', error => { console.error(error); process.exitCode = 1; });
