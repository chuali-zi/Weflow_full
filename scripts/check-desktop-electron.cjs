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
  win.on('show', () => win.hide());
  win.webContents.on('did-finish-load', async () => {
    if (checked || !win.webContents.getURL().includes('index.html')) return;
    checked = true;
    try {
      await win.webContents.executeJavaScript(`location.hash = '/onboarding-window'`);
      await new Promise(resolve => setTimeout(resolve, 1200));
      fs.writeFileSync(path.join(config.home, 'setup.png'), (await win.webContents.capturePage()).toPNG());
      const result = await win.webContents.executeJavaScript(`(async () => {
        const api = window.electronAPI;
        const activation = await api.integrated.activate(${JSON.stringify(config.dataDir)});
        const connection = await api.chat.connect();
        const sessions = await api.chat.getSessions();
        const messages = await api.chat.getMessages('wxid_peer', 0, 50);
        const search = await api.chat.searchMessages('相同', 'wxid_peer', 20, 0);
        const exports = {};
        for (const format of ['txt', 'html', 'csv', 'json']) {
          exports[format] = await api.export.exportSession('wxid_peer', ${JSON.stringify(config.outputDir)} + '/chat.' + format,
            { format, exportImages: false, exportVoices: false, exportVideos: false, exportEmojis: false, exportFiles: false });
        }
        return { activation, connection, sessions: { success: sessions.success, count: sessions.sessions?.length, error: sessions.error },
          messages: { success: messages.success, count: messages.messages?.length, error: messages.error },
          search: { success: search.success, count: search.messages?.length, error: search.error }, exports };
      })()`);
      fs.writeFileSync(path.join(config.home, 'result.json'), JSON.stringify(result, null, 2));
      console.log('DESKTOP RESULT', JSON.stringify(result));
      assert.equal(result.activation.success, true);
      assert.equal(result.connection.success, true);
      assert.equal(result.sessions.count, 2);
      assert.equal(result.messages.count, 5);
      assert.equal(result.search.count, 2);
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
