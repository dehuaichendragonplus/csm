'use strict';
// CSM 桌面端更新器：检测 → 下载 → 安装 的状态机，状态变化广播给渲染进程。
//
// - Windows（打包后）：electron-updater 单流整包下载 NSIS 安装包，下载完成后 quitAndInstall 覆盖安装。
//   安装包未签名，package.json 里 win.verifyUpdateCodeSignature: false 关掉了 Authenticode 校验。
// - macOS：未签名/未公证，Squirrel.Mac 无法自替换，改为从 GitHub Release 直接下载对应架构的 .dmg
//   到「下载」目录，完成后由用户打开安装包拖入「应用程序」。
// - 其他环境（Windows 开发态、Linux）：只做检测，下载时引导去 GitHub 页面。
//
// 依赖全部可注入（autoUpdater / fetchImpl / checkImpl / downloadsDir ...），便于 node --test 单测。
const fs = require('node:fs');
const path = require('node:path');
const { checkGitHubUpdate, DEFAULT_REPO } = require('../lib/github-update');

const MISSING_ARTIFACT_RE = /Cannot find latest\.ya?ml|HttpError:\s*404|HTTP 404|未上传|未就绪/i;
const NETWORK_RE = /ERR_CONNECTION_RESET|ECONNRESET|ETIMEDOUT|timeout|超时|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ERR_INTERNET_DISCONNECTED|ERR_PROXY|socket hang up|fetch failed|无法连接/i;

function classifyError(message) {
  const msg = String(message || '');
  if (MISSING_ARTIFACT_RE.test(msg)) return 'missing-artifact';
  if (NETWORK_RE.test(msg)) return 'network-reset';
  return 'unknown';
}

function cleanErrorMessage(err) {
  let msg = String((err && err.message) || err || '未知更新错误');
  const headerIdx = msg.indexOf('\nHeaders:');
  if (headerIdx !== -1) msg = msg.slice(0, headerIdx).trim();
  if (/Cannot find latest\.ya?ml/i.test(msg) || /HttpError:\s*404/i.test(msg)) {
    msg = `新版本安装包未就绪：GitHub Release 中尚未上传 latest.yml 安装元数据或安装包（${msg.split('\n')[0]}）`;
  }
  return msg;
}

/** ~/Downloads 下不冲突的文件名：CSM-1.2.0-mac-arm64.dmg → CSM-1.2.0-mac-arm64 (1).dmg */
function uniquePath(dir, fileName, exists = p => fs.existsSync(p)) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  for (let i = 1; exists(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function readProxyEnv(env = process.env) {
  return env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || env.https_proxy || env.http_proxy || env.all_proxy || '';
}

function createAppUpdater({
  app,
  net = null,
  shell = null,
  log = () => {},
  platform = process.platform,
  arch = process.arch,
  repo = DEFAULT_REPO,
  currentVersion = app && app.getVersion ? app.getVersion() : '0.0.0',
  isPackaged = !!(app && app.isPackaged),
  autoUpdater: injectedAutoUpdater = null,
  fetchImpl = null,
  checkImpl = checkGitHubUpdate,
  downloadsDir = null,
  env = process.env,
  onBeforeInstall = () => {},
  progressIntervalMs = 150
} = {}) {
  const autoInstallSupported = platform === 'win32' && isPackaged;
  const fetchFn = fetchImpl || (net && net.fetch ? (url, opts) => net.fetch(url, opts) : globalThis.fetch);
  const listeners = new Set();

  let state = {
    status: 'idle',
    platform,
    arch,
    isPackaged,
    autoInstallSupported,
    currentVersion,
    latestVersion: null,
    hasUpdate: false,
    notes: '',
    publishedAt: null,
    htmlUrl: `https://github.com/${repo}/releases`,
    downloadUrl: null,
    fileName: null,
    assetSize: null,
    percent: 0,
    receivedBytes: 0,
    totalBytes: 0,
    downloadedFilePath: null,
    error: null,
    errorKind: null,
    checkedAt: null
  };

  function getState() {
    return { ...state };
  }

  function setState(patch) {
    state = { ...state, ...patch };
    const snapshot = getState();
    for (const cb of listeners) {
      try { cb(snapshot); } catch (err) { log(`[updater] listener error: ${err.message}`); }
    }
    return snapshot;
  }

  function onStateChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function setError(err, kind) {
    const message = typeof err === 'string' ? err : cleanErrorMessage(err);
    log(`[updater] error: ${message}`);
    return setState({ status: 'error', error: message, errorKind: kind || classifyError(message) });
  }

  // ---------- 检测 ----------
  let checking = null;

  async function doCheck() {
    const prev = state;
    setState({ status: 'checking', error: null, errorKind: null });
    const r = await checkImpl({ current: currentVersion, repo, platform, arch, fetchImpl: fetchFn, log });
    const checkedAt = new Date().toISOString();
    if (r.error) {
      // 保留上次已知的新版本信息，失败不应把「有新版本」的提示抹掉
      setState({ checkedAt });
      return setError(r.error, classifyError(r.error));
    }
    const info = {
      latestVersion: r.latest,
      hasUpdate: !!r.hasUpdate,
      notes: r.notes || '',
      publishedAt: r.publishedAt || null,
      htmlUrl: r.htmlUrl || state.htmlUrl,
      downloadUrl: r.downloadUrl || null,
      fileName: r.fileName || null,
      assetSize: r.assetSize || null,
      checkedAt
    };
    // 同一版本已经下载好了：不要把「待安装」打回「发现新版本」
    if (prev.status === 'downloaded' && prev.latestVersion === r.latest) {
      return setState({ ...info, status: 'downloaded' });
    }
    return setState({ ...info, status: r.hasUpdate ? 'available' : 'up-to-date', percent: 0, receivedBytes: 0, totalBytes: 0 });
  }

  function checkForUpdates() {
    if (state.status === 'downloading') return Promise.resolve(getState());
    if (checking) return checking;
    checking = doCheck()
      .catch(err => setError(err))
      .finally(() => { checking = null; });
    return checking;
  }

  // ---------- Windows：electron-updater ----------
  let autoUpdater = null;

  function getAutoUpdater() {
    if (autoUpdater) return autoUpdater;
    autoUpdater = injectedAutoUpdater || require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // 关掉差量分块与 WebInstaller，强制单流整包下载：
    // GitHub Release CDN 在国内网络/代理下对密集 Range 请求容易 ERR_CONNECTION_RESET。
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.logger = {
      info: m => log(`[updater] ${m}`),
      warn: m => log(`[updater] ${m}`),
      error: m => log(`[updater] ${m}`),
      debug: () => {}
    };
    const proxy = readProxyEnv(env);
    if (proxy && autoUpdater.netSession && autoUpdater.netSession.setProxy) {
      try {
        autoUpdater.netSession.setProxy({ proxyRules: proxy });
        log(`[updater] 已同步代理规则到更新会话：${proxy}`);
      } catch (err) {
        log(`[updater] 设置更新会话代理失败：${err.message}`);
      }
    }
    return autoUpdater;
  }

  function downloadWindows() {
    const au = getAutoUpdater();
    setState({ status: 'downloading', percent: 0, receivedBytes: 0, totalBytes: 0, error: null, errorKind: null });
    return new Promise(resolve => {
      let settled = false;
      const onProgress = p => {
        setState({
          status: 'downloading',
          percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))),
          receivedBytes: p.transferred || 0,
          totalBytes: p.total || 0
        });
      };
      const onAvailable = info => {
        if (info && info.version && !state.latestVersion) setState({ latestVersion: info.version, hasUpdate: true });
        Promise.resolve(au.downloadUpdate()).catch(onError);
      };
      const onNotAvailable = () => finish(() => setError(
        'GitHub Release 中的 latest.yml 没有指向比当前更新的版本，安装元数据可能尚未上传或与 Release 不一致',
        'missing-artifact'
      ));
      const onDownloaded = info => finish(() => setState({
        status: 'downloaded',
        percent: 100,
        latestVersion: (info && info.version) || state.latestVersion,
        hasUpdate: true,
        downloadedFilePath: (info && info.downloadedFile) || null,
        error: null,
        errorKind: null
      }));
      const onError = err => finish(() => setError(err));
      function cleanup() {
        au.removeListener('download-progress', onProgress);
        au.removeListener('update-available', onAvailable);
        au.removeListener('update-not-available', onNotAvailable);
        au.removeListener('update-downloaded', onDownloaded);
        au.removeListener('error', onError);
      }
      function finish(apply) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(apply());
      }
      au.on('download-progress', onProgress);
      au.on('update-available', onAvailable);
      au.on('update-not-available', onNotAvailable);
      au.on('update-downloaded', onDownloaded);
      au.on('error', onError);
      Promise.resolve(au.checkForUpdates()).catch(onError);
    });
  }

  // ---------- macOS：直接下载 .dmg ----------
  function resolveDownloadsDir() {
    if (downloadsDir) return downloadsDir;
    try { return app.getPath('downloads'); } catch (_) { return require('node:os').homedir(); }
  }

  async function downloadMac() {
    if (!state.downloadUrl) await doCheck();
    if (state.status === 'error' && !state.downloadUrl) return getState();
    if (!state.hasUpdate) return getState();
    if (!state.downloadUrl) {
      return setError(`v${state.latestVersion} 的 Release 中没有找到 ${arch} 架构的 .dmg 安装包（可能尚未上传）`, 'missing-artifact');
    }

    const dir = resolveDownloadsDir();
    const fileName = state.fileName || path.basename(new URL(state.downloadUrl).pathname);
    setState({ status: 'downloading', percent: 0, receivedBytes: 0, totalBytes: state.assetSize || 0, error: null, errorKind: null, downloadedFilePath: null });

    let tmpPath = null;
    let fh = null;
    try {
      const resp = await fetchFn(state.downloadUrl, { redirect: 'follow' });
      if (!resp.ok) {
        const msg = resp.status === 404
          ? `安装包未上传：GitHub Release 中找不到 ${fileName}（HTTP 404）`
          : `下载安装包失败：HTTP ${resp.status}`;
        return setError(msg, resp.status === 404 ? 'missing-artifact' : 'unknown');
      }
      const total = Number(resp.headers && resp.headers.get && resp.headers.get('content-length')) || state.assetSize || 0;

      // 已经完整下载过同名文件（大小一致）：直接复用，不重复下载
      const existing = path.join(dir, fileName);
      if (total > 0 && fs.existsSync(existing) && fs.statSync(existing).size === total) {
        try { if (resp.body && resp.body.cancel) await resp.body.cancel(); } catch (_) { /* 忽略 */ }
        log(`[updater] 复用已下载的安装包 ${existing}`);
        return setState({ status: 'downloaded', percent: 100, receivedBytes: total, totalBytes: total, downloadedFilePath: existing });
      }

      fs.mkdirSync(dir, { recursive: true });
      const finalPath = uniquePath(dir, fileName);
      tmpPath = `${finalPath}.download`;
      fh = await fs.promises.open(tmpPath, 'w');

      let received = 0;
      let lastPushAt = 0;
      let lastPercent = -1;
      const push = force => {
        const percent = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
        const now = Date.now();
        if (!force && now - lastPushAt < progressIntervalMs && percent - lastPercent < 1) return;
        lastPushAt = now;
        lastPercent = percent;
        setState({ status: 'downloading', percent, receivedBytes: received, totalBytes: total });
      };

      if (!resp.body) throw new Error('下载响应没有内容');
      if (typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          await fh.write(buf);
          received += buf.length;
          push(false);
        }
      } else {
        for await (const chunk of resp.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          await fh.write(buf);
          received += buf.length;
          push(false);
        }
      }
      await fh.close();
      fh = null;

      if (received <= 0) throw new Error('下载到的安装包为空');
      if (total > 0 && received !== total) throw new Error(`安装包下载不完整（${received} / ${total} 字节），请重试`);
      fs.renameSync(tmpPath, finalPath);
      tmpPath = null;
      log(`[updater] 安装包已下载：${finalPath}`);
      return setState({ status: 'downloaded', percent: 100, receivedBytes: received, totalBytes: total || received, downloadedFilePath: finalPath });
    } catch (err) {
      return setError(err);
    } finally {
      if (fh) { try { await fh.close(); } catch (_) { /* 忽略 */ } }
      if (tmpPath) { try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* 忽略 */ } }
    }
  }

  let downloading = null;

  function downloadUpdate() {
    if (downloading) return downloading;
    if (state.status === 'downloaded') return Promise.resolve(getState());
    let job;
    if (platform === 'win32') {
      if (!autoInstallSupported) {
        return Promise.resolve(setError('当前为开发模式，仅打包安装后的 CSM 支持应用内自动更新，请前往 GitHub 下载安装包', 'unsupported'));
      }
      job = (async () => {
        if (checking) await checking;
        return downloadWindows();
      })();
    } else if (platform === 'darwin') {
      job = (async () => {
        if (checking) await checking;
        return downloadMac();
      })();
    } else {
      return Promise.resolve(setError(`当前平台（${platform}）不支持应用内更新，请前往 GitHub 下载`, 'unsupported'));
    }
    downloading = job.catch(err => setError(err)).finally(() => { downloading = null; });
    return downloading;
  }

  // ---------- 安装 / 打开 ----------
  async function installUpdate() {
    if (state.status !== 'downloaded') return { ok: false, error: '安装包尚未下载完成' };
    if (platform === 'win32') {
      if (!autoInstallSupported) return { ok: false, error: '开发模式不支持自动安装' };
      try { await onBeforeInstall(); } catch (err) { log(`[updater] onBeforeInstall 失败：${err.message}`); }
      // 静默安装并在安装完成后重新启动 CSM
      getAutoUpdater().quitAndInstall(true, true);
      return { ok: true };
    }
    return openDownloaded();
  }

  async function openDownloaded() {
    const p = state.downloadedFilePath;
    if (!p || !fs.existsSync(p)) return { ok: false, error: '找不到已下载的安装包，请重新下载' };
    const err = shell ? await shell.openPath(p) : '无法调用系统 shell';
    return err ? { ok: false, error: err } : { ok: true };
  }

  async function revealDownloaded() {
    const p = state.downloadedFilePath;
    if (!p || !fs.existsSync(p)) return { ok: false, error: '找不到已下载的安装包，请重新下载' };
    if (shell) shell.showItemInFolder(p);
    return { ok: true };
  }

  async function openRelease() {
    const url = state.htmlUrl || `https://github.com/${repo}/releases`;
    if (!/^https:\/\//i.test(url)) return { ok: false, error: '无效的发布页地址' };
    if (shell) await shell.openExternal(url);
    return { ok: true };
  }

  return {
    getState,
    onStateChange,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    openDownloaded,
    revealDownloaded,
    openRelease
  };
}

module.exports = { createAppUpdater, classifyError, cleanErrorMessage, uniquePath, readProxyEnv };
