const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const config = JSON.parse(process.env.WEFLOW_SMOKE_CONFIG);
const root = path.resolve(__dirname, '..');
app.setPath('userData', config.userDataPath);
const packaged = process.env.WEFLOW_SMOKE_PACKAGED === '1';
const resources = path.join(root, 'release/win-unpacked/resources');
const appRoot = packaged ? path.join(resources, 'app.asar') : root;
if (packaged) {
  assert.ok(fs.existsSync(path.join(resources, 'backend/weflow-backend.exe')));
  Object.defineProperty(app, 'isPackaged', { value: true });
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
  process.chdir(path.dirname(resources));
}
app.setAppPath(appRoot);
let checked = false;
const deadline = setTimeout(() => { console.error('DESKTOP CHECK TIMEOUT'); app.exit(1); }, 90_000);
app.on('browser-window-created', (_, win) => {
  win.setSkipTaskbar(true);
  const hideWindow = () => win.hide();
  win.on('show', hideWindow);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error('RENDERER ERROR', details.message);
  });
  win.webContents.on('did-finish-load', async () => {
    if (checked || !win.webContents.getURL().includes('index.html')) return;
    checked = true;
    try {
      await win.webContents.executeJavaScript(`location.hash = '/onboarding-window'`);
      let setupReady = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        setupReady = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.welcome-page .welcome-sidebar'))`);
        if (setupReady) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(setupReady, true, 'The original WeFlow welcome page must render before checking IPC.');
      // Give the real window one painted frame; hidden-window captures can be blank.
      win.removeListener('show', hideWindow);
      win.showInactive();
      await new Promise(resolve => setTimeout(resolve, 500));
      fs.writeFileSync(path.join(config.home, 'setup.png'), (await win.webContents.capturePage()).toPNG());
      win.hide();
      win.on('show', hideWindow);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const api = window.electronAPI;
        const keyResult = await api.key.autoGetDbKey(${JSON.stringify(path.dirname(path.dirname(config.dataDir)))}, ${JSON.stringify(config.accountId || 'wxid_me')});
        if (!keyResult.success || !keyResult.key) throw new Error(keyResult.error || 'Key acquisition failed');
        const dbPath = keyResult.dbPath || ${JSON.stringify(path.dirname(path.dirname(config.dataDir)))};
        const accountId = keyResult.accountId || ${JSON.stringify(config.accountId || 'wxid_me')};
        const testConnection = await api.wcdb.testConnection(dbPath, keyResult.key, accountId);
        if (!testConnection.success) throw new Error(testConnection.error || 'Database test connection failed');
        await api.config.set('dbPath', dbPath);
        await api.config.set('decryptKey', keyResult.key);
        await api.config.set('myAccountId', accountId);
        const connection = await api.chat.connect();
        const sessions = await api.chat.getSessions();
        const target = ${JSON.stringify(config.sessionId || 'wxid_peer')};
        const messages = await api.chat.getMessages(target, 0, 50);
        const search = await api.chat.searchMessages(${JSON.stringify(config.searchQuery || '相同')}, target, 20, 0);
        const exports = {};
        for (const format of ['txt', 'html', 'csv', 'json']) {
          exports[format] = await api.export.exportSession(target, ${JSON.stringify(config.outputDir)} + '/chat.' + format,
            { format, exportImages: false, exportVoices: false, exportVideos: false, exportEmojis: false, exportFiles: false });
        }
        return { keyAcquisition: { success: keyResult.success, verifiedDatabases: keyResult.verifiedDatabases }, testConnection,
          connection, sessions: { success: sessions.success, count: sessions.sessions?.length, error: sessions.error },
          messages: { success: messages.success, count: messages.messages?.length, error: messages.error },
          search: { success: search.success, count: search.messages?.length, error: search.error }, exports };
      })()`);
      fs.writeFileSync(path.join(config.home, 'result.json'), JSON.stringify(result, null, 2));
      console.log('DESKTOP RESULT', JSON.stringify(result));
      assert.equal(result.keyAcquisition.success, true);
      assert.equal(result.testConnection.success, true);
      assert.equal(result.connection.success, true);
      if (config.realAccount) {
        assert.ok(result.sessions.count > 0);
        assert.ok(result.messages.count > 0);
        assert.ok(result.search.count > 0);
      } else {
        assert.equal(result.sessions.count, 2);
        assert.equal(result.messages.count, 5);
        assert.equal(result.search.count, 2);
      }
      for (const exported of Object.values(result.exports)) assert.equal(exported.success, true);
      console.log('DESKTOP CHECK PASSED', config.home);
      clearTimeout(deadline);
      app.exit(0);
    } catch (error) {
      console.error('DESKTOP CHECK FAILED', error);
      clearTimeout(deadline);
      app.exit(1);
    }
  });
});
require(path.join(appRoot, 'dist-electron/main.js'));
