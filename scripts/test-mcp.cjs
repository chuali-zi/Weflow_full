const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
(async () => {
  const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => /^mcp-.*\.test\.ts$/.test(name));
  if (!tests.length) throw new Error('No MCP tests found.');
  const out = path.join(root, 'build/mcp-tests');
  fs.mkdirSync(out, { recursive: true });
  await build({ entryPoints: tests.map(name => path.join(root, 'tests', name)), outdir: out, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['sharp', 'heic-decode'] });
  const result = spawnSync(process.execPath, ['--test', ...tests.map(name => path.join(out, name.replace(/\.ts$/, '.cjs')))], { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
