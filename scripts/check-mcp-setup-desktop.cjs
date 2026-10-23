// Real renderer + preload + main IPC, with synthetic data and disposable clients.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const python = ['.venv/Scripts/python.exe', '.runtime/python/python.exe'].map(file => path.join(root, file)).find(fs.existsSync);
  if (!python) throw new Error('Prepare project Python first.');
  const fixture = spawnSync(python, ['python/tests/create_mcp_fixture.py', '.runtime/mu'], {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'python') },
  });
  if (fixture.status !== 0) throw new Error(fixture.stderr);
  const data = JSON.parse(fixture.stdout);
  fs.writeFileSync(path.join(data.userDataPath, 'WeFlow-config.json'), JSON.stringify({ agreementAccepted: true, onboardingDone: true }));
  const env = { ...process.env, WEFLOW_SETUP_UI: JSON.stringify(data), WEFLOW_USER_DATA_PATH: data.userDataPath,
    WEFLOW_CONFIG_CWD: data.userDataPath, WEFLOW_BACKEND_ROOT: path.join(root, 'python'), WEFLOW_PYTHON: python,
    CODEX_HOME: path.join(data.home, 'codex-client'), CLAUDE_CONFIG_DIR: path.join(data.home, 'claude-client') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app } = require('electron');
  const data = JSON.parse(process.env.WEFLOW_SETUP_UI);
  app.setPath('userData', data.userDataPath);
  app.setAppPath(root);
  let checked = false;
  const deadline = setTimeout(() => { console.error('MCP SETUP UI TIMEOUT'); app.exit(1); }, 90000);
  app.on('browser-window-created', (_, win) => {
    win.setSkipTaskbar(true);
    const hide = () => win.hide();
    win.on('show', hide);
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('did-finish-load', async () => {
      if (checked || !win.webContents.getURL().includes('index.html') || /agreement-window|notification-window/.test(win.webContents.getURL())) return;
      checked = true;
      const js = code => win.webContents.executeJavaScript(code);
      const until = async (expression, limit = 600) => {
        for (let index = 0; index < limit; index++) {
          if (await js(expression)) return;
          await new Promise(resolveWait => setTimeout(resolveWait, 100));
        }
        throw new Error(`UI condition timed out: ${expression}; ` + await js('document.body.innerText.slice(-2500)'));
      };
      const capture = async name => {
        win.removeListener('show', hide);
        win.setSize(1120, 840);
        win.showInactive();
        await new Promise(resolveWait => setTimeout(resolveWait, 400));
        fs.writeFileSync(path.join(data.home, name), (await win.webContents.capturePage()).toPNG());
        win.hide();
        win.on('show', hide);
      };
      try {
        await js("location.hash = '/settings'");
        await until(`Array.from(document.querySelectorAll('.tab-btn')).some(button => button.textContent.includes('MCP 接入'))`);
        await js(`Array.from(document.querySelectorAll('.tab-btn')).find(button => button.textContent.includes('MCP 接入')).click()`);
        await until(`document.querySelectorAll('.mcp-client__details').length === 2`);
        assert.ok((await js(`document.querySelector('.mcp-setup').innerText`)).includes('离线快照'));
        await capture('mcp-setup-before.png');
        for (const index of [0, 1]) {
          await js(`document.querySelectorAll('.mcp-client')[${index}].querySelector('.btn-primary').click()`);
          await until(`document.querySelectorAll('.mcp-client')[${index}].querySelector('.mcp-result--ok') && !document.querySelectorAll('.mcp-client')[${index}].querySelector('.btn-primary').disabled`);
          assert.ok((await js(`document.querySelectorAll('.mcp-client')[${index}].innerText`)).includes('MCP 数据读取验证通过'));
        }
        await capture('mcp-setup-connected.png');
        for (const index of [0, 1]) {
          await js(`Array.from(document.querySelectorAll('.mcp-client')[${index}].querySelectorAll('button')).find(button => button.textContent.includes('移除接入')).click()`);
          await until(`!document.querySelectorAll('.mcp-client')[${index}].querySelector('.mcp-registration') && !document.querySelectorAll('.mcp-client')[${index}].querySelector('.btn-primary').disabled`);
        }
        console.log('MCP SETUP UI PASSED', data.home);
        clearTimeout(deadline);
        app.exit(0);
      } catch (error) {
        console.error('MCP SETUP UI FAILED', error.message);
        clearTimeout(deadline);
        app.exit(1);
      }
    });
  });
  require(path.join(root, 'dist-electron/main.js'));
}
