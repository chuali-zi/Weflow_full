// Synthetic SQLCipher commits through the real backend, Worker and chat page.
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const python = path.join(root, '.venv/Scripts/python.exe');
const packaged = process.argv.includes('--packaged') || process.env.WEFLOW_LIVE_SMOKE_PACKAGED === '1';
const packagedResources = path.join(root, 'release/win-unpacked/resources');
const pythonEnv = { ...process.env, PYTHONPATH: path.join(root, 'python'), PYTHONIOENCODING: 'utf-8' };
const runPython = args => {
  const result = spawnSync(python, args, { cwd: root, env: pythonEnv, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `Python exited ${result.status}`);
  return JSON.parse(result.stdout);
};

if (!process.env.WEFLOW_LIVE_SMOKE_CONFIG) {
  const config = runPython(['python/tests/create_live_smoke_fixture.py', '.runtime/live-smoke']);
  const configureArgs = ['cli', 'configure', '--mode', 'live', '--user-data', config.userDataPath, '--data-dir', config.dataDir, '--quiet'];
  let prepared;
  if (packaged) {
    const result = spawnSync(path.join(packagedResources, 'backend/weflow-backend.exe'), configureArgs,
      { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stdout || result.stderr);
    prepared = JSON.parse(result.stdout);
  } else prepared = runPython(['-m', 'weflow_backend', ...configureArgs]);
  assert.equal(prepared.success, true);
  // Synthetic profile only: initialize preferences before App reads them.
  const preferencesPath = path.join(config.userDataPath, 'WeFlow-config.json');
  const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  Object.assign(preferences, { agreementAccepted: true, analyticsConsent: false, analyticsDenyCount: 2,
    imageAesKey: '0123456789abcdef', imageXorKey: 0x53 });
  fs.writeFileSync(preferencesPath, JSON.stringify(preferences));
  const env = { ...pythonEnv, WEFLOW_LIVE_SMOKE_CONFIG: JSON.stringify(config),
    WEFLOW_PYTHON: python, WEFLOW_BACKEND_ROOT: path.join(root, 'python'),
    WEFLOW_USER_DATA_PATH: config.userDataPath, WEFLOW_CONFIG_CWD: config.userDataPath };
  if (packaged) Object.assign(env, { WEFLOW_LIVE_SMOKE_PACKAGED: '1',
    WEFLOW_PYTHON: path.join(config.home, 'missing-python.exe'), WEFLOW_BACKEND_ROOT: path.join(config.home, 'missing-source') });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
} else {
  const { app } = require('electron');
  const config = JSON.parse(process.env.WEFLOW_LIVE_SMOKE_CONFIG);
  app.setPath('userData', config.userDataPath);
  const appRoot = packaged ? path.join(packagedResources, 'app.asar') : root;
  if (packaged) {
    Object.defineProperty(app, 'isPackaged', { value: true });
    Object.defineProperty(process, 'resourcesPath', { value: packagedResources, configurable: true });
    process.chdir(path.dirname(packagedResources));
  }
  app.setAppPath(appRoot);
  let started = false;
  const deadline = setTimeout(() => { console.error('LIVE DESKTOP TIMEOUT'); app.exit(1); }, 90_000);
  app.on('browser-window-created', (_, win) => {
    win.setSkipTaskbar(true);
    win.on('show', () => win.hide());
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', details => {
      if (details.level === 'error') console.error('LIVE RENDERER ERROR', details.message);
    });
    win.webContents.on('did-finish-load', async () => {
      if (started || !win.webContents.getURL().includes('index.html') || /-window/.test(win.webContents.getURL())) return;
      started = true;
      const evaluate = code => win.webContents.executeJavaScript(code);
      const waitFor = async (code, label, timeout = 12_000) => {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
          if (await evaluate(code)) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out: ${label}`);
      };
      const scrollToBottom = async () => {
        // Virtuoso updates its estimated height while new rows mount. Settle
        // that layout before asserting changes to the last visible message.
        await evaluate(`(async () => {
          const list = document.querySelector('.message-list');
          for (let i = 0; i < 5; i++) {
            list.scrollTop = list.scrollHeight;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        })()`);
        await waitFor(`(() => { const list = document.querySelector('.message-list'); return list.scrollHeight - list.scrollTop - list.clientHeight < 12; })()`, 'bottom layout settled');
      };
      try {
        await evaluate(`(async () => {
          await window.electronAPI.config.set('agreementAccepted', true);
          window.__liveEvents = [];
          window.__liveAnchorEvents = [];
          window.addEventListener('chat:restore-live-anchor', event => window.__liveAnchorEvents.push(event.detail));
          window.electronAPI.chat.onWcdbChange((_event, data) => window.__liveEvents.push(JSON.parse(data.json)));
          const result = await window.electronAPI.chat.connect();
          if (!result.success) throw new Error(result.error);
          location.hash = '/chat';
        })()`);
        await waitFor(`Boolean([...document.querySelectorAll('.session-item')].find(el => el.textContent.includes('老朋友')))`, 'chat list');
        await evaluate(`[...document.querySelectorAll('.session-item')].find(el => el.textContent.includes('老朋友')).click()`);
        await waitFor(`document.querySelectorAll('.message-bubble').length > 0`, 'initial messages');
        await scrollToBottom();
        const status = await evaluate(`window.electronAPI.wcdb.getConnectionStatus()`);
        assert.equal(status.mode, 'live');
        assert.equal(status.complete, true);
        const durations = {};
        let historyAnchor;
        for (const action of ['append', 'edit', 'delete', 'history']) {
          if (action !== 'history') {
            await scrollToBottom();
          }
          if (action === 'history') {
            await evaluate(`document.querySelector('.message-list').scrollTop = 0`);
            await waitFor(`[...document.querySelectorAll('.message-wrapper')].some(el => el.textContent.includes('live-smoke-00'))`, 'history anchor available');
            await evaluate(`(() => {
              const list = document.querySelector('.message-list');
              const anchor = [...list.querySelectorAll('.message-wrapper')].find(el => el.textContent.includes('live-smoke-00'));
              list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
            })()`);
            await new Promise(resolve => setTimeout(resolve, 250));
            historyAnchor = await evaluate(`(() => {
              const list = document.querySelector('.message-list');
              const anchor = [...list.querySelectorAll('.message-wrapper')].find(el => el.textContent.includes('live-smoke-00'));
              if (list.scrollHeight - list.scrollTop - list.clientHeight <= 180) throw new Error('History fixture is still near the bottom');
              return {key: anchor.dataset.messageKey, offset: anchor.getBoundingClientRect().top - list.getBoundingClientRect().top};
            })()`);
            await evaluate(`window.__expectedLiveAnchor = ${JSON.stringify(historyAnchor)}`);
          }
          const initialEvents = await evaluate('window.__liveEvents.length');
          const initialPageRefreshes = await evaluate('window.__liveAnchorEvents.length');
          const start = Date.now();
          runPython(['python/tests/create_live_smoke_fixture.py', action, path.join(config.home, 'fixture.json')]);
          await waitFor(`window.__liveEvents.length > ${initialEvents}`, `${action} idle event`);
          const expectedCount = action === 'append' || action === 'edit' ? 25 : action === 'delete' ? 24 : 25;
          const rows = await evaluate(`window.electronAPI.chat.getMessages('wxid_peer', 0, 50)`);
          assert.equal(rows.success, true);
          assert.equal(rows.messages.length, expectedCount);
          // The backend event can precede the debounced page refresh. Wait
          // for that refresh and its layout before starting the next action.
          await waitFor(`window.__liveAnchorEvents.length > ${initialPageRefreshes}`, `${action} page refresh`);
          await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
          if (action === 'append') {
            assert.equal(rows.messages.filter(message => message.content?.includes('live-smoke-') || message.parsedContent?.includes('live-smoke-')).length, 20);
            await waitFor(`[...document.querySelectorAll('.message-bubble')].some(el => el.textContent.includes('live-smoke-19'))`, 'appended message rendered');
          }
          if (action === 'edit') await waitFor(`[...document.querySelectorAll('.message-bubble')].some(el => el.textContent.includes('live-smoke-edited')) && !document.querySelector('.message-list')?.innerText.includes('live-smoke-19')`, 'edited message rendered');
          if (action === 'delete') await waitFor(`![...document.querySelectorAll('.message-bubble')].some(el => el.textContent.includes('live-smoke-18'))`, 'deleted message removed');
          if (action === 'history') {
            await new Promise(resolve => setTimeout(resolve, 800));
            await waitFor(`(() => {
              const list = document.querySelector('.message-list');
              const anchor = [...list.querySelectorAll('.message-wrapper')].find(el => el.dataset.messageKey === ${JSON.stringify(historyAnchor.key)});
              return anchor && Math.abs(anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - ${historyAnchor.offset}) < 12;
            })()`, 'history scroll anchor retained');
          }
          durations[action] = Date.now() - start;
        }
        fs.mkdirSync(config.outputDir, { recursive: true });
        const exported = await evaluate(`window.electronAPI.export.exportSession('wxid_peer', ${JSON.stringify(path.join(config.outputDir, 'live.json'))}, {format: 'json', exportImages: false, exportVoices: false, exportVideos: false, exportEmojis: false, exportFiles: false})`);
        assert.equal(exported.success, true, JSON.stringify(exported));
        const data = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'live.json'), 'utf8').replace(/^\uFEFF/, ''));
        assert.equal(data.messages.length, 25);
        await scrollToBottom();
        runPython(['python/tests/create_live_smoke_fixture.py', 'image-message', path.join(config.home, 'fixture.json')]);
        await waitFor(`[...document.querySelectorAll('.message-wrapper')].some(el => el.dataset.messageKey?.includes('3000'))`, 'live image message');
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.equal(await evaluate(`Boolean(document.querySelector('.message-list img[alt="图片"]'))`), false);
        const imageStart = Date.now();
        runPython(['python/tests/create_live_smoke_fixture.py', 'image-file', path.join(config.home, 'fixture.json')]);
        await waitFor(`(() => { const image = document.querySelector('.message-list img[alt="图片"]'); return image?.complete && image.naturalWidth === 1; })()`, 'late image decrypted and rendered', 15_000);
        durations.lateImage = Date.now() - imageStart;
        const events = await evaluate(`window.__liveEvents.map(({connectionId, revision, reason}) => ({connectionId, revision, reason}))`);
        assert.ok(events.every(event => event.connectionId === status.connectionId));
        console.log('LIVE DESKTOP PASSED', JSON.stringify({ sameSecondMessages: 20, edit: true, delete: true,
          history: true, scrollAnchor: true, lateImage: true, exportMessages: data.messages.length, durations, events: events.length, home: config.home }));
        clearTimeout(deadline);
        app.exit(0);
      } catch (error) {
        console.error('LIVE DESKTOP FAILED', error);
        fs.writeFileSync(path.join(config.home, 'failed.png'), (await win.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(config.home, 'failed-page.txt'), await evaluate('document.body.innerText'));
        fs.writeFileSync(path.join(config.home, 'failed-state.json'), JSON.stringify(await evaluate(`(() => {
          const list = document.querySelector('.message-list');
          return { expected: window.__expectedLiveAnchor, restored: window.__liveAnchorEvents,
            scrollTop: list?.scrollTop, scrollHeight: list?.scrollHeight, clientHeight: list?.clientHeight,
            messages: [...document.querySelectorAll('.message-wrapper')].map(el => ({ key: el.dataset.messageKey,
              offset: el.getBoundingClientRect().top - list.getBoundingClientRect().top, height: el.getBoundingClientRect().height })) };
        })()`), null, 2));
        clearTimeout(deadline);
        app.exit(1);
      }
    });
  });
  require(path.join(appRoot, 'dist-electron/main.js'));
}
