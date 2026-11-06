'use strict';
// CSM（Config Sync Manager）桌面 App 外壳：在主进程里启动原有的 Express 服务，窗口加载本地页面。
// 业务逻辑全部复用 server.js / lib/，这里只处理桌面环境特有的问题：
// 数据目录、OAuth 凭证、Google 登录走系统浏览器、PATH 补全、原生选目录。
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, shell, ipcMain, Notification: ElectronNotification } = require('electron');
const { fixProcessEnv } = require('../lib/shell-env');
const oauth = require('../lib/oauth');

if (app) app.setName('CSM');

const ROOT = path.join(__dirname, '..');
const ENV_DATA_DIR = process.env.CSM_DATA || process.env.SYNC_MANAGER_DATA; // 旧变量名继续兼容
const DATA_DIR = ENV_DATA_DIR ? path.resolve(ENV_DATA_DIR) : app.getPath('userData');
// 改名前（Sync Manager）的数据目录，首次启动时迁移过来
const LEGACY_DATA_DIR = path.join(app.getPath('appData'), 'Sync Manager');
const USER_CREDENTIALS = path.join(DATA_DIR, 'credentials.json');

let mainWindow = null;
let serverInfo = null;

// ---------- 日志：打包后没有终端，写一份到数据目录便于排查 ----------
function setupFileLog() {
  const logDir = path.join(DATA_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const stream = fs.createWriteStream(path.join(logDir, 'main.log'), { flags: 'a' });
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      stream.write(`[${new Date().toISOString()}] [${level}] ${args.map(String).join(' ')}\n`);
    };
  }
}

// ---------- OAuth 凭证：数据目录 > 随包内置 > 源码目录（开发模式） ----------
function validCredentials(p) {
  try { oauth.loadCredentials(p); return true; } catch (_) { return false; }
}

async function resolveCredentials() {
  const candidates = [
    USER_CREDENTIALS,
    process.resourcesPath && path.join(process.resourcesPath, 'credentials.json'),
    path.join(ROOT, 'credentials.json')
  ].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p) && validCredentials(p));
  if (found) return found;

  // 首次使用：让用户选一次 credentials.json，复制到数据目录，之后不再询问
  while (true) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'CSM',
      message: '首次使用需要 Google OAuth 客户端凭证',
      detail: '请选择 credentials.json（从团队 wiki 或维护者处获取，格式见 credentials.json.example）。\n选择后会保存到：\n' + USER_CREDENTIALS,
      buttons: ['选择文件…', '退出'],
      defaultId: 0,
      cancelId: 1
    });
    if (response !== 0) return null;
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择 credentials.json',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths[0]) continue;
    if (!validCredentials(filePaths[0])) {
      await dialog.showMessageBox({ type: 'error', message: '这个文件不是有效的 OAuth 凭证', detail: '缺少 client_id / client_secret，请确认选的是 Desktop 类型 OAuth 客户端的 JSON。' });
      continue;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(filePaths[0], USER_CREDENTIALS);
    fs.chmodSync(USER_CREDENTIALS, 0o600);
    return USER_CREDENTIALS;
  }
}

// ---------- 原生选目录：替换 osascript / PowerShell 实现 ----------
async function pickFolder(startDir) {
  let defaultPath;
  try { if (startDir && fs.statSync(startDir).isDirectory()) defaultPath = startDir; } catch (_) { /* 忽略 */ }
  const opts = { title: '选择项目的配置表目录', properties: ['openDirectory'], defaultPath };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  return { path: result.filePaths[0] };
}

const AUTH_SUCCESS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权完成</title>
<style>body{font:16px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f6f7f9;color:#222}
div{text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#666;margin:0}</style></head>
<body><div><h1>✅ Google 授权完成</h1><p>可以关闭此页面，回到 CSM。</p></div></body></html>`;

function onAuthorized() {
  if (!mainWindow) return;
  mainWindow.reload();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  app.focus({ steal: true });
}

// ---------- macOS 原生角标与横幅通知 ----------
function setAppBadge(count) {
  if (process.platform === 'darwin' && app && app.dock) {
    const num = parseInt(count, 10) || 0;
    app.dock.setBadge(num > 0 ? (num > 99 ? '99+' : String(num)) : '');
  }
}

function showBannerNotification({ title, body, silent = false }) {
  if (!ElectronNotification.isSupported()) return false;
  try {
    const n = new ElectronNotification({
      title: title || 'CSM',
      body: body || '',
      silent: !!silent
    });
    n.on('click', () => {
      if (!mainWindow && serverInfo) {
        createWindow();
      } else if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
    return true;
  } catch (err) {
    console.error('[app] showBannerNotification error:', err);
    return false;
  }
}

ipcMain.on('set-badge', (_event, count) => {
  setAppBadge(count);
});

ipcMain.handle('show-notification', (_event, payload) => {
  return showBannerNotification(payload || {});
});

// ---------- 窗口 ----------
function isAppUrl(url) {
  try { return new URL(url).origin === new URL(serverInfo.url).origin; } catch (_) { return false; }
}

function openExternalSafe(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'CSM',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 13 },
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Google 禁止在内嵌浏览器里登录（disallowed_useragent），授权一律交给系统浏览器；
  // 回调仍打到本机服务，服务通过 onAuthorized 通知窗口刷新
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url) && new URL(url).pathname !== '/auth/start') return;
    event.preventDefault();
    openExternalSafe(url);
  });
  // 页面里的云端表链接等 target=_blank 一律用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(serverInfo.url);
}

// 只搬业务数据（项目注册表、令牌、同步状态、凭证），不搬 Chromium 缓存；旧目录原样保留
const LEGACY_ITEMS = ['projects.json', '.tokens', 'projects', 'credentials.json'];

function migrateLegacyDataDir() {
  if (ENV_DATA_DIR) return false;
  if (fs.existsSync(path.join(DATA_DIR, 'projects.json'))) return false;
  if (!fs.existsSync(path.join(LEGACY_DATA_DIR, 'projects.json'))) return false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const item of LEGACY_ITEMS) {
    const from = path.join(LEGACY_DATA_DIR, item);
    const to = path.join(DATA_DIR, item);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
  }
  return true;
}

async function start() {
  const migrated = migrateLegacyDataDir();
  setupFileLog();
  if (migrated) console.log(`[app] migrated data from ${LEGACY_DATA_DIR}`);
  const envOk = fixProcessEnv();
  console.log(`[app] version ${app.getVersion()}, data dir ${DATA_DIR}, shell env ${envOk ? 'loaded' : 'fallback'}`);

  const credentialsPath = await resolveCredentials();
  if (!credentialsPath) return app.quit();

  const { main } = require('../server');
  serverInfo = await main({
    dataDir: DATA_DIR,
    credentialsPath,
    openBrowser: false,
    pickFolder,
    // 文件存在时在访达中选中它，目录则直接打开
    revealPath: async target => {
      const { nearestExisting } = require('../lib/reveal');
      const p = nearestExisting(target);
      if (!p) throw new Error(`路径不存在：${target}`);
      if (fs.statSync(p).isFile()) shell.showItemInFolder(p);
      else { const err = await shell.openPath(p); if (err) throw new Error(err); }
    },
    setBadge: setAppBadge,
    showNotification: showBannerNotification,
    onAuthorized,
    authSuccessHtml: AUTH_SUCCESS_HTML
  });
  createWindow();
}

// 只允许一个实例：重复双击时聚焦已有窗口，避免起两个服务抢同一份数据
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return serverInfo && createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(start).catch(err => {
    console.error('[app] fatal:', err && err.stack || err);
    dialog.showErrorBox('CSM 启动失败', `${err && err.message || err}\n\n日志：${path.join(DATA_DIR, 'logs', 'main.log')}`);
    app.quit();
  });

  // macOS 习惯：关窗口不退出，点 Dock 图标重新打开；其他平台关窗即退出
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!mainWindow && serverInfo) createWindow();
  });
}
