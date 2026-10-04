// Open Chat before App's automatic connection completes. No manual connect,
// settings reset, or profile repair may mask the startup routing race.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const shortcut = process.argv.includes('--shortcut');
const packaged = process.argv.includes('--packaged') || process.env.WEFLOW_CHAT_STARTUP_PACKAGED === '1';
const resources = path.join(root, 'release/win-unpacked/resources');
if (!process.env.WEFLOW_CHAT_STARTUP_PROFILE) {
  const index = process.argv.indexOf('--user-data');
  let profile;
  if (index !== -1) profile = path.resolve(process.argv[index + 1]);
  else {
    const python = path.join(root, '.venv/Scripts/python.exe');
    const env = { ...process.env, PYTHONPATH: path.join(root, 'python') };
    const run = args => {
      const result = spawnSync(python, args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const fixture = run(['python/tests/create_live_smoke_fixture.py', '.runtime/chat-startup']);
    profile = fixture.userDataPath;
    // Hide the fixture snapshot: a live configuration must work without one.
    const snapshots = path.join(profile, 'backend/snapshots');
    if (fs.existsSync(snapshots)) fs.renameSync(snapshots, snapshots + '-unused');
    assert.equal(run(['-m', 'weflow_backend', 'cli', 'configure', '--mode', 'live', '--user-data', profile,
      '--data-dir', fixture.dataDir, '--quiet']).success, true);
    const file = path.join(profile, 'WeFlow-config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(config, { agreementAccepted: true, analyticsConsent: false, analyticsDenyCount: 2,
      ...(shortcut ? { silentStartup: true } : {}) });
    fs.writeFileSync(file, JSON.stringify(config));
    if (shortcut) {
      // A desktop launch must use live even when the last CLI selection was snapshot.
      const settingsFile = path.join(profile, 'backend/settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      for (const key of Object.keys(settings.database_modes || {})) settings.database_modes[key] = 'snapshot';
      fs.writeFileSync(settingsFile, JSON.stringify(settings));
    }
  }
  const env = { ...process.env, WEFLOW_CHAT_STARTUP_PROFILE: profile,
    WEFLOW_CHAT_STARTUP_PACKAGED: packaged ? '1' : '0', WEFLOW_USER_DATA_PATH: profile, WEFLOW_CONFIG_CWD: profile,
    WEFLOW_PYTHON: path.join(root, '.venv/Scripts/python.exe'), WEFLOW_BACKEND_ROOT: path.join(root, 'python') };
  delete env.ELECTRON_RUN_AS_NODE;
  if (shortcut && !packaged) {
    // Explorer does not supply the test harness's Python/backend/profile environment.
    for (const key of ['WEFLOW_USER_DATA_PATH', 'WEFLOW_CONFIG_CWD', 'WEFLOW_PYTHON', 'WEFLOW_BACKEND_ROOT']) delete env[key];
  }
  const args = shortcut ? [__filename, '--shortcut', '--mode', 'live', '--show', '--user-data', profile] : [__filename];
  const child = spawn(require('electron'), args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => { process.exitCode = code || 0; });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
} else {
  const { app } = require('electron');
  const profile = process.env.WEFLOW_CHAT_STARTUP_PROFILE;
  app.setPath('userData', profile);
  const appRoot = packaged ? path.join(resources, 'app.asar') : root;
  app.setAppPath(appRoot);
  if (packaged) {
    Object.defineProperty(app, 'isPackaged', { value: true });
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
  }
  let started = false;
  const deadline = setTimeout(() => app.exit(1), 45_000);
  app.on('browser-window-created', (_, win) => {
    win.setSkipTaskbar(true);
    win.on('show', () => win.hide());
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('did-finish-load', async () => {
      const url = win.webContents.getURL();
      if (started || !url.includes('index.html') || /-window/.test(url)) return;
      started = true;
      const evaluate = code => win.webContents.executeJavaScript(code);
      const wait = async (code, label) => {
        for (let i = 0; i < 120; i++) {
          if (await evaluate(code)) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(label);
      };
      try {
        await wait(`Boolean(document.querySelector('a[href="#/chat"]'))`, 'Sidebar missing');
        await evaluate(`document.querySelector('a[href="#/chat"]').click()`);
        // Observe every frame: a bounce to Home must fail even if a later
        // refresh happened to put the user back on Chat.
        const result = await evaluate(`new Promise((resolve, reject) => {
          const until = Date.now() + 15000;
          const frame = () => {
            if (location.hash !== '#/chat') return reject(new Error('Chat route was replaced: ' + location.hash));
            const sessions = document.querySelectorAll('.session-item').length;
            if (sessions) return resolve({hash:location.hash, sessions});
            if (Date.now() > until) return reject(new Error('Sessions did not load'));
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        })`);
        const status = await evaluate('window.electronAPI.wcdb.getConnectionStatus()');
        assert.equal(status.mode, 'live');
        assert.equal(status.state, 'ready');
        if (shortcut) {
          let secondInstance = false;
          app.once('second-instance', () => { secondInstance = true; });
          const second = spawn(process.execPath, [root, '--mode', 'live', '--show', '--user-data', profile],
            { cwd: root, env: process.env, stdio: 'ignore', windowsHide: true });
          const code = await new Promise((resolve, reject) => {
            second.once('error', reject);
            second.once('exit', resolve);
          });
          assert.equal(code, 0);
          assert.equal(secondInstance, true, 'Second click must activate the running GUI.');
          assert.equal((await evaluate('window.electronAPI.wcdb.getConnectionStatus()')).connectionId, status.connectionId);
        }
        await evaluate(`document.querySelector('.session-item').click()`);
        await wait(`Boolean(document.querySelector('.message-list'))`, 'Conversation did not open');
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(await evaluate('location.hash'), '#/chat');
        console.log('CHAT STARTUP PASSED', JSON.stringify({ ...result, mode: status.mode, repeatedShortcut: shortcut }));
        clearTimeout(deadline); app.exit(0);
      } catch (error) {
        console.error('CHAT STARTUP FAILED', String(error));
        clearTimeout(deadline); app.exit(1);
      }
    });
  });
  require(path.join(appRoot, 'dist-electron/main.js'));
}
