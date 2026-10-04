const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const root = path.resolve(__dirname, '..');
const python = [process.env.WEFLOW_PYTHON, path.join(root, '.venv/Scripts/python.exe'), path.join(root, '.runtime/python/python.exe')].find(p => p && fs.existsSync(p));
const temp = path.join(root, '.runtime/mcp-test/fixtures with spaces');
fs.mkdirSync(temp, { recursive: true });

async function main() {
  if (!python) throw new Error('Prepare the existing Python environment first.');
  const mode = process.env.WEFLOW_MCP_CHECK_MODE || 'snapshot';
  const fixtureRun = spawnSync(python, ['python/tests/create_mcp_fixture.py', temp, '--mode', mode], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.join(root, 'python') } });
  if (fixtureRun.status !== 0) throw new Error(fixtureRun.error?.message || fixtureRun.stderr || 'MCP fixture generation failed.');
  const fixture = JSON.parse(fixtureRun.stdout.trim());
  const client = new Client({ name: 'weflow-mcp-check', version: '1' });
  const packagedRoot = process.env.WEFLOW_MCP_CHECK_PACKAGE;
  const launcher = path.join(packagedRoot || root, 'weflow-mcp.cmd');
  const args = ['--user-data', fixture.userDataPath, '--data-dir', fixture.dataDir, '--mode', mode, '--timezone', 'America/New_York'];
  let serverConfig = { command: launcher, args, env: { ...process.env } };
  if (process.env.WEFLOW_MCP_CHECK_CONFIG === '1') {
    const printed = require('cross-spawn').sync(launcher, ['--print-config', ...args], { cwd: root, env: { ...process.env }, encoding: 'utf8' });
    if (printed.status !== 0) throw new Error(printed.error?.message || printed.stderr || 'Client configuration generation failed.');
    const generated = JSON.parse(printed.stdout).mcpServers.weflow;
    assert.ok(path.isAbsolute(generated.command));
    serverConfig = { ...generated, env: { ...process.env, ...generated.env } };
  }
  const transport = new StdioClientTransport({ ...serverConfig, cwd: root, stderr: 'pipe' });
  let stderr = '';
  const metrics = {};
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const read = async (name, arguments_, options) => {
    const started = performance.now();
    const reply = await client.callTool({ name, arguments: arguments_ }, undefined, options);
    const data = reply.structuredContent || JSON.parse(reply.content.find(x => x.type === 'text').text);
    if (reply.isError || !data.success) throw new Error(`${name}: ${JSON.stringify(data.error || data)}`);
    const metric = metrics[name] ||= { calls: 0, elapsedMs: 0, maxChars: 0 };
    metric.calls++;
    metric.elapsedMs += Math.round(performance.now() - started);
    metric.maxChars = Math.max(metric.maxChars, Array.from(JSON.stringify(data)).length);
    return data;
  };
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(x => x.name), ['get_status', 'find_chats', 'get_chat_overview', 'read_messages', 'search_messages', 'get_message_context', 'get_media', 'export_messages']);
    const status = await read('get_status', {});
    assert.equal(status.freshness.mode, mode);
    assert.equal(status.timezone, 'America/New_York');
    const found = await read('find_chats', { query: '工作群', kind: 'group' });
    assert.ok(found.data.chats.length >= 2, 'same-name groups remain separate candidates');
    const chat = found.data.chats.find(c => c.has_local_messages) || found.data.chats[0];
    const range = { start: '2000-01-01T00:00:00Z', end: new Date(Date.now() + 60000).toISOString() };
    let page = await read('read_messages', { chat_ids: [chat.id], range, limit: 1, max_chars: 4000 });
    const messages = [...page.data.messages];
    let pages = 1;
    while (page.coverage.has_more) {
      const cursor = page.coverage.next_cursor;
      assert.ok(cursor);
      const following = await read('read_messages', { cursor });
      const replay = await read('read_messages', { cursor });
      assert.deepEqual(replay, following, 'cursor replay must not advance or change timestamps');
      assert.ok(Array.from(JSON.stringify(following)).length <= 4000, 'response obeys output budget');
      messages.push(...following.data.messages);
      page = following;
      assert.ok(++pages < 100, 'pagination must make progress');
    }
    assert.ok(messages.length > 1);
    assert.ok(messages.some(m => m.text.includes('取消')), 'later cancellation must be preserved');
    const longParts = messages.filter(m => m.text_part || m.text.includes('长文本片段'));
    assert.equal(Array.from(longParts.map(m => m.text).join('')).length, fixture.longTextCharacters, 'all long-message text is recoverable');
    assert.equal(page.coverage.scan_complete, true);
    const bulk = await read('read_messages', { chat_ids: [chat.id], range, format: 'compact', limit: 1000, max_chars: 120000 });
    assert.equal(bulk.coverage.has_more, false);
    assert.equal(bulk.data.messages.length, new Set(messages.map(m => m.id)).size);
    const compactText = bulk.data.message_columns.indexOf('text');
    assert.ok(bulk.data.messages.some(m => m[compactText].includes('取消')));
    const exported = await read('export_messages', { chat_ids: [chat.id], range });
    assert.equal(exported.coverage.scan_complete, true);
    const exportedMessages = fs.readFileSync(exported.data.files.jsonl.path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(exportedMessages.length, new Set(messages.map(m => m.id)).size);
    assert.deepEqual(new Set(exportedMessages.map(m => m.id)), new Set(messages.map(m => m.id)));
    const manifest = JSON.parse(fs.readFileSync(exported.data.files.manifest.path, 'utf8'));
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.message_count, exportedMessages.length);
    assert.ok(fs.readFileSync(exported.data.files.transcript.path, 'utf8').includes('取消'));
    const exportedLong = exportedMessages.find(m => m.text.includes('长文本片段'));
    assert.equal(Array.from(exportedLong.text).length, fixture.longTextCharacters);
    assert.equal(exportedLong.text_complete, true);
    const bulkChat = (await read('find_chats', { query: '批量读取测试群' })).data.chats[0];
    assert.ok(bulkChat);
    const thousand = await read('read_messages', { chat_ids: [bulkChat.id], range, format: 'compact', limit: 1000, max_chars: 400000 });
    assert.equal(thousand.data.messages.length, 1000, 'one tool call returns 1000 complete short messages');
    assert.equal(thousand.coverage.has_more, true);
    const exportProgress = [];
    const largeExport = await read('export_messages', { chat_ids: [bulkChat.id], range }, {
      timeout: 180000, resetTimeoutOnProgress: true, onprogress: event => exportProgress.push(event.progress),
    });
    assert.equal(largeExport.data.message_count, fixture.bulkMessageCount);
    assert.equal(largeExport.coverage.scan_complete, true);
    const largeMessages = fs.readFileSync(largeExport.data.files.jsonl.path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(largeMessages.length, fixture.bulkMessageCount);
    assert.equal(new Set(largeMessages.map(m => m.id)).size, fixture.bulkMessageCount);
    assert.equal(largeMessages[0].text, '批量原文 0🙂');
    assert.equal(largeMessages.at(-1).text, `批量原文 ${fixture.bulkMessageCount - 1}🙂`);
    assert.equal(exportProgress.at(-1), fixture.bulkMessageCount);
    const quoted = messages.find(m => m.type === 'quote' && m.quote?.target_id);
    assert.ok(quoted, 'a real quote is retained');
    const quoteContext = await read('get_message_context', { message_ids: [quoted.id], before: 0, after: 0 });
    assert.ok(quoteContext.data.messages.some(m => m.id === quoted.quote.target_id));
    assert.equal(quoteContext.data.messages.find(m => m.id === quoted.id).quote.state, 'resolved');
    const search = await read('search_messages', { chat_ids: [chat.id], range, query: { terms: ['清单'], operator: 'any' } });
    assert.ok(search.data.hits.length > 0);
    const context = await read('get_message_context', { message_ids: [search.data.hits[0].message_id], before: 2, after: 50, max_chars: 4000 });
    assert.ok(context.data.messages.length >= 1);
    let contextPage = context;
    while (contextPage.coverage.has_more) {
      const cursor = contextPage.coverage.next_cursor;
      contextPage = await read('get_message_context', { cursor });
      assert.deepEqual(await read('get_message_context', { cursor }), contextPage);
      assert.ok(Array.from(JSON.stringify(contextPage)).length <= 4000);
    }
    const overview = await read('get_chat_overview', { chat_ids: [chat.id], range, bucket: 'day' });
    assert.ok(overview.data.chats.length);
    assert.equal(overview.data.chats[0].total, new Set(messages.map(m => m.id)).size, 'overview counts each complete message once');
    const media = await read('get_media', { message_id: messages[0].id, representation: 'metadata' });
    assert.ok(media.data.availability);
    const invalid = await client.callTool({ name: 'read_messages', arguments: { chat_ids: [chat.id], range: { start: '2026-01-01', end: '2026-02-01' } } });
    assert.equal(invalid.isError, true);
    if (mode === 'live') {
      const first = await read('read_messages', { chat_ids: [chat.id], range, limit: 1 });
      assert.ok(first.coverage.next_cursor);
      const changed = spawnSync(python, ['python/tests/create_mcp_fixture.py', '--mutate-live', fixture.home], { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.join(root, 'python') } });
      if (changed.status !== 0) throw new Error(changed.error?.message || changed.stderr || 'Live fixture mutation failed.');
      const stale = await client.callTool({ name: 'read_messages', arguments: { cursor: first.coverage.next_cursor } });
      assert.equal(stale.structuredContent.error.code, 'CURSOR_STALE');
    }
    fs.writeFileSync(path.join(fixture.userDataPath, 'WeFlow-config.json'), JSON.stringify({ decryptKey: 'lock:synthetic' }));
    const locked = await client.callTool({ name: 'get_status', arguments: {} });
    assert.equal(locked.structuredContent.error.code, 'PROFILE_LOCKED');
    process.stdout.write(JSON.stringify({ success: true, mode, transport: packagedRoot ? 'packaged-stdio' : 'source-stdio', tools: listed.tools.length, pages, messageParts: messages.length, metrics, checks: [mode, 'find', 'pagination', 'replay', 'budget', 'compact-bulk-read', 'complete-file-export', 'search', 'context-pagination', 'overview', 'media-state', 'time-validation', 'profile-lock', ...(mode === 'live' ? ['cursor-stale'] : [])] }) + '\n');
  } catch (error) {
    if (stderr) process.stderr.write(stderr);
    throw error;
  } finally { await client.close(); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
