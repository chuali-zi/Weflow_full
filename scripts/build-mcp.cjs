const { build } = require('vite');
const { build: bundleWorker } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
(async () => {
  fs.mkdirSync(path.join(root, 'build/mcp'), { recursive: true });
  await build({ configFile: path.join(root, 'vite.mcp.config.ts'), root });
  await bundleWorker({ entryPoints: [path.join(root, 'electron/heicDecodeWorker.ts')], outfile: path.join(root, 'build/mcp/heicDecodeWorker.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['sharp', 'heic-decode'] });
})().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
