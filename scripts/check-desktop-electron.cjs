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
    if (config.preconfigured && /#\/(?:agreement-window|onboarding-window|notification-window)/.test(win.webContents.getURL())) return;
    checked = true;
    try {
      if (!config.preconfigured) await win.webContents.executeJavaScript(`location.hash = '/onboarding-window'`);
      let setupReady = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        setupReady = await win.webContents.executeJavaScript(config.preconfigured
          ? `location.hash === '#/home' && !document.querySelector('.welcome-page')`
          : `Boolean(document.querySelector('.welcome-page .welcome-sidebar'))`);
        if (setupReady) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(setupReady, true, config.preconfigured
        ? 'CLI-configured WeFlow must automatically connect and enter its original home page.'
        : 'The original WeFlow welcome page must render before checking IPC.');
      // Give the real window one painted frame; hidden-window captures can be blank.
      win.removeListener('show', hideWindow);
      win.showInactive();
      await new Promise(resolve => setTimeout(resolve, 500));
      fs.writeFileSync(path.join(config.home, config.preconfigured ? 'prepared-home.png' : 'setup.png'), (await win.webContents.capturePage()).toPNG());
      win.hide();
      win.on('show', hideWindow);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const api = window.electronAPI;
        let keyResult, testConnection, connection;
        if (${Boolean(config.preconfigured)}) {
          // Do not repair config or invoke connect here: App's startup must do it.
          keyResult = { success: true };
          testConnection = { success: true };
          connection = { success: true, automatic: true };
        } else {
        keyResult = await api.key.autoGetDbKey(${JSON.stringify(path.dirname(path.dirname(config.dataDir)))}, ${JSON.stringify(config.accountId || 'wxid_me')});
        if (!keyResult.success || !keyResult.key) throw new Error(keyResult.error || 'Key acquisition failed');
        const dbPath = keyResult.dbPath || ${JSON.stringify(path.dirname(path.dirname(config.dataDir)))};
        const accountId = keyResult.accountId || ${JSON.stringify(config.accountId || 'wxid_me')};
        testConnection = await api.wcdb.testConnection(dbPath, keyResult.key, accountId);
        if (!testConnection.success) throw new Error(testConnection.error || 'Database test connection failed');
        await api.config.set('dbPath', dbPath);
        await api.config.set('decryptKey', keyResult.key);
        await api.config.set('myAccountId', accountId);
        connection = await api.chat.connect();
        }
        const sessions = await api.chat.getSessions();
        const target = ${JSON.stringify(config.sessionId || 'wxid_peer')};
        const messages = await api.chat.getMessages(target, 0, 50);
        const search = await api.chat.searchMessages(${JSON.stringify(config.searchQuery || '相同')}, target, 20, 0);
        let analytics;
        if (${Boolean(config.checkAnalyticsCache)}) {
          const statistics = await api.analytics.getOverallStatistics(true);
          analytics = { success: statistics.success, totalMessages: statistics.data?.totalMessages, error: statistics.error,
            cachePath: await api.config.get('cachePath') };
        }
        const exports = {};
        for (const [format, extension] of [['txt','txt'], ['html','html'], ['weclone','csv'], ['json','json']]) {
          exports[format] = await api.export.exportSession(target, ${JSON.stringify(config.outputDir)} + '/chat.' + extension,
            { format, exportImages: false, exportVoices: false, exportVideos: false, exportEmojis: false, exportFiles: false });
        }
        return { keyAcquisition: { success: keyResult.success, verifiedDatabases: keyResult.verifiedDatabases }, testConnection,
          connection, sessions: { success: sessions.success, count: sessions.sessions?.length, error: sessions.error },
          messages: { success: messages.success, count: messages.messages?.length, error: messages.error },
          search: { success: search.success, count: search.messages?.length, error: search.error }, analytics, exports };
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
      if (config.checkAnalyticsCache) {
        assert.equal(result.analytics.success, true);
        assert.ok(result.analytics.totalMessages > 0);
        assert.equal(path.resolve(result.analytics.cachePath), path.resolve(config.userDataPath, 'cache'));
        const cache = JSON.parse(fs.readFileSync(path.join(result.analytics.cachePath, 'analytics_cache.json'), 'utf8'));
        assert.ok(cache.data.total > 0, 'Statistics must be persisted in the prepared cache directory.');
      }
      const jsonExport = JSON.parse(fs.readFileSync(path.join(config.outputDir, 'chat.json'), 'utf8').replace(/^\uFEFF/, ''));
      assert.ok(Array.isArray(jsonExport.messages) && jsonExport.messages.length > 0, 'JSON export must contain messages.');
      if (config.expectedMessageCount) assert.equal(jsonExport.messages.length, config.expectedMessageCount);
      if (!config.realAccount) assert.equal(jsonExport.messages.length, 5);
      assert.ok(fs.readFileSync(path.join(config.outputDir, 'chat.csv'), 'utf8').replace(/^\uFEFF/, '').startsWith('id,MsgSvrID,type_name,is_sender,talker,msg,src,CreateTime'), 'WeClone export must be CSV rather than a JSON fallback.');
      assert.match(fs.readFileSync(path.join(config.outputDir, 'chat.html'), 'utf8'), /<html\b/i);
      assert.ok(fs.readFileSync(path.join(config.outputDir, 'chat.txt'), 'utf8').trim().length > 0);
      console.log('EXPORT FILE CHECK', JSON.stringify({ jsonMessages: jsonExport.messages.length, wecloneCsvHeader: true, html: true, txt: true }));
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
