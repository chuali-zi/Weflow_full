const { build } = require('esbuild');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
(async () => {
  const output = path.join(root, 'build/mcp-tests/mcp-setup.test.cjs');
  await build({ entryPoints: [path.join(root, 'tests/mcp-setup.test.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const result = spawnSync(process.execPath, ['--test', output], {
    cwd: root, stdio: 'inherit', env: { ...process.env, WEFLOW_SETUP_INTEGRATION: '1' },
  });
  process.exitCode = result.status ?? 1;
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
