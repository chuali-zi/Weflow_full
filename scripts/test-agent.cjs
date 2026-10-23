const { build } = require('esbuild');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
(async () => {
  const output = path.join(root, 'build/agent-tools.test.cjs');
  await build({ entryPoints: [path.join(root, 'tests/agent-tools.test.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const result = spawnSync(process.execPath, ['--test', output], { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
