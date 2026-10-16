// Reproducible fault injection using synthetic profiles and owned child processes only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const root = path.resolve(__dirname, '..');
const python = [process.env.WEFLOW_PYTHON, path.join(root, '.venv/Scripts/python.exe'), path.join(root, '.runtime/python/python.exe')].find(p => p && fs.existsSync(p));
const home = path.join(root, '.runtime/mcp-fuzz');
fs.mkdirSync(home, { recursive: true });
const destination = fs.mkdtempSync(path.join(home, 'cold boot '));
const launcher = path.join(root, 'weflow-mcp.cmd');
const env = { ...process.env, PYTHONPATH: path.join(root, 'python') };
const seedValue = Number(process.env.WEFLOW_FUZZ_SEED || 5762832);
let seed = seedValue >>> 0;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const metrics = { seed: seedValue, coldStarts: 0, killedServers: 0, killedBackends: 0, invalidRequests: 0, invalidFrames: 0, healthChecks: 0 };
const sessions = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function command(args) {
  const result = require('cross-spawn').sync(launcher, args, { cwd: destination, env, encoding: 'utf8', timeout: 60000 });
  assert.ok(!result.error, result.error?.message);
  return result;
}
async function connect(config) {
  const client = new Client({ name: 'weflow-reboot-fuzz', version: '1' });
  const transport = new StdioClientTransport({ ...config, env: { ...env, ...config.env }, cwd: destination, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const session = { client, transport };
  sessions.add(session);
  await client.connect(transport, { timeout: 10000 });
  assert.match(client.getInstructions(), /client-owned stdio/);
  metrics.coldStarts++;
  return session;
}
async function call(session, name, args = {}) {
  const result = await session.client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  assert.ok(result.structuredContent, name);
  return result.structuredContent;
}
async function healthy(session) {
  assert.equal((await call(session, 'get_status')).success, true);
  assert.equal((await call(session, 'find_chats', { limit: 1 })).success, true);
}
function children(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' | Where-Object { $_.Name -in @('python.exe', 'weflow-backend.exe') } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const value = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return Array.isArray(value) ? value : [value];
}
function backendTree(pid) {
  // Windows venv python.exe may launch another interpreter underneath it.
  return children(pid).flatMap(child => [child, ...backendTree(child)]);
}
async function waitExited(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await sleep(50);
  }
  assert.fail(`Owned test process ${pid} survived parent shutdown`);
}
async function close(session) { await session.client.close(); sessions.delete(session); }

async function runMode(mode) {
  const generated = spawnSync(python, ['python/tests/create_mcp_fixture.py', destination, '--mode', mode], { cwd: root, encoding: 'utf8', env, timeout: 60000 });
  assert.equal(generated.status, 0, generated.stderr);
  const fixture = JSON.parse(generated.stdout);
  const args = ['--user-data', fixture.userDataPath, '--data-dir', fixture.dataDir, '--mode', mode, '--timezone', 'UTC'];
  const printed = command(['--print-config', ...args]);
  assert.equal(printed.status, 0, printed.stderr);
  const config = JSON.parse(printed.stdout).mcpServers.weflow;
  assert.ok(path.isAbsolute(config.command));
  let session = await connect(config);
  await healthy(session);

  // Kill only this test session's backend. Its next fresh read must recover.
  const backendPids = backendTree(session.transport.pid);
  assert.ok(backendPids.length >= 1);
  process.kill(backendPids.at(-1));
  metrics.killedBackends++;
  assert.equal((await call(session, 'find_chats', { limit: 1 })).success, true);
  await healthy(session);
  for (const pid of backendPids) await waitExited(pid);

  // Leave a real continuation and in-memory reference behind, then lose all RAM.
  const chat = (await call(session, 'find_chats', { query: '工作群' })).data.chats[0];
  const page = await call(session, 'read_conversation', { chat_ids: [chat.id], limit: 1 });
  assert.ok(page.coverage.next_cursor);
  const oldCursor = page.coverage.next_cursor;
  const oldRef = page.data.messages[0].ref;
  const oldBackendPids = backendTree(session.transport.pid);
  process.kill(session.transport.pid);
  metrics.killedServers++;
  await assert.rejects(session.client.callTool({ name: 'get_status', arguments: {} }, undefined, { timeout: 2000 }));
  await close(session);
  for (const pid of oldBackendPids) await waitExited(pid);
  session = await connect(config);
  await healthy(session);
  assert.equal((await call(session, 'read_conversation', { cursor: oldCursor })).error.code, 'CURSOR_EXPIRED');
  assert.equal((await call(session, 'get_conversation_context', { message_refs: [oldRef] })).error.code, 'REFERENCE_EXPIRED');
  assert.equal((await call(session, 'read_conversation', { chat_ids: [chat.id], limit: 1 })).success, true);

  // Seeded request mutations must fail locally and leave the connection usable.
  const mutations = [
    ['find_chats', { limit: 0 }], ['find_chats', { limit: -1 }],
    ['find_chats', { limit: '500' }], ['find_chats', { kind: 'invalid' }],
    ['read_messages', { chat_ids: [] }], ['read_messages', { cursor: '' }],
    ['read_conversation', { cursor: 'x', limit: 1 }],
    ['get_message_context', { message_ids: [null] }],
    ['get_status', { unexpected: true }], ['missing_tool', {}],
    ['read_messages', { chat_ids: ['bad'], range: { start: 'yesterday', end: 'today' } }],
  ];
  for (let i = 0; i < 100; i++) {
    const [name, value] = mutations[random(mutations.length)];
    const result = await call(session, name, value);
    assert.equal(result.success, false, `${name}: ${JSON.stringify(value)}`);
    assert.ok(['INVALID_ARGUMENT', 'UNKNOWN_TOOL'].includes(result.error.code), result.error.code);
    metrics.invalidRequests++;
    if (i % 20 === 0) await healthy(session);
  }
  const frames = ['null', '[]', 'true', '42', '"text"', '{broken', '{}', '{"jsonrpc":"2.0","method":false}', '{"jsonrpc":"2.0","id":{},"method":"tools/list"}'];
  for (let i = 0; i < 100; i++) {
    // Test-only access to the SDK child pipe, to bypass its outgoing validation.
    session.transport._process.stdin.write(frames[random(frames.length)] + '\n');
    metrics.invalidFrames++;
  }
  await healthy(session);
  const parallel = await Promise.all(Array.from({ length: 8 }, () => call(session, 'find_chats', { limit: 1 })));
  assert.ok(parallel.every(result => result.success));

  // Simulate interrupted profile writes / a missing profile after reboot.
  const profileFile = path.join(fixture.userDataPath, 'WeFlow-config.json');
  const original = fs.readFileSync(profileFile);
  for (const [value, code] of [[null, 'PROFILE_NOT_PREPARED'], ['{partial', 'PROFILE_CONFIG_INVALID'], ['null', 'PROFILE_CONFIG_INVALID'], ['{"decryptKey":"lock:synthetic"}', 'PROFILE_LOCKED']]) {
    if (value === null) fs.unlinkSync(profileFile); else fs.writeFileSync(profileFile, value);
    assert.equal((await call(session, 'get_status')).error.code, code);
    fs.writeFileSync(profileFile, original);
    await healthy(session);
  }
  await close(session);

  const checked = command(['--check', ...args]);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.deepEqual(JSON.parse(checked.stdout).checks, { transport_connected: true, tools_listed: true, data_readable: true });
  metrics.healthChecks++;
  fs.writeFileSync(profileFile, '{partial');
  const broken = command(['--check', ...args]);
  assert.equal(broken.status, 1);
  assert.equal(JSON.parse(broken.stdout).error.code, 'PROFILE_CONFIG_INVALID');
  metrics.healthChecks++;
  fs.writeFileSync(profileFile, original);

  // Graceful shutdown and a later launch also use only persisted preparation.
  session = await connect(config);
  await healthy(session);
  await close(session);
  process.stdout.write(JSON.stringify({ mode, success: true, checks: ['foreign-cwd', 'backend-kill', 'server-kill', 'orphan-exit', 'cold-reconnect', 'expired-cursor-and-ref', 'input-and-frame-fuzz', 'parallel-requests', 'profile-repair', 'check-exit-codes'] }) + '\n');
}

(async () => {
  if (!python) throw new Error('Prepare the existing Python environment first.');
  if (process.platform !== 'win32') throw new Error('This launcher / process lifecycle test requires Windows.');
  try {
    for (const mode of ['snapshot', 'live']) await runMode(mode);
    process.stdout.write(JSON.stringify({ success: true, ...metrics }) + '\n');
  } finally {
    await Promise.allSettled([...sessions].map(close));
    // Only this unique synthetic fixture subtree is removed.
    fs.rmSync(destination, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
