const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAppUpdater, classifyError, uniquePath } = require('../electron/updater');

const fakeApp = { getVersion: () => '1.1.3', isPackaged: true, getPath: () => os.tmpdir() };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csm-updater-'));
}

function checkResult(extra = {}) {
  return async () => ({
    configured: true, current: '1.1.3', latest: '1.2.0', tag: 'v1.2.0', hasUpdate: true,
    notes: 'n', publishedAt: null, htmlUrl: 'https://github.com/o/r/releases/tag/v1.2.0',
    downloadUrl: 'https://github.com/o/r/releases/download/v1.2.0/CSM-1.2.0-mac-arm64.dmg',
    fileName: 'CSM-1.2.0-mac-arm64.dmg', assetSize: null, ...extra
  });
}

function streamResp(chunks, { status = 200, contentLength } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => (k.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: new Uint8Array(Buffer.from(chunks[i++])) } : { done: true })
      }),
      cancel: async () => {}
    }
  };
}

class MockAutoUpdater extends EventEmitter {
  constructor(script) {
    super();
    this.script = script;
    this.calls = [];
    this.netSession = { setProxy: cfg => this.calls.push(['setProxy', cfg]) };
  }
  async checkForUpdates() {
    this.calls.push(['checkForUpdates']);
    setImmediate(() => this.script.onCheck(this));
  }
  async downloadUpdate() {
    this.calls.push(['downloadUpdate']);
    setImmediate(() => this.script.onDownload && this.script.onDownload(this));
  }
  quitAndInstall(silent, runAfter) {
    this.calls.push(['quitAndInstall', silent, runAfter]);
  }
}

test('classifyError / uniquePath', () => {
  assert.strictEqual(classifyError('Error: Cannot find latest.yml in the latest release artifacts'), 'missing-artifact');
  assert.strictEqual(classifyError('HttpError: 404 Not Found'), 'missing-artifact');
  assert.strictEqual(classifyError('net::ERR_CONNECTION_RESET'), 'network-reset');
  assert.strictEqual(classifyError('socket hang up'), 'network-reset');
  assert.strictEqual(classifyError('boom'), 'unknown');
  const existing = new Set(['/d/a.dmg', '/d/a (1).dmg']);
  assert.strictEqual(uniquePath('/d', 'a.dmg', p => existing.has(p)), path.join('/d', 'a (2).dmg'));
  assert.strictEqual(uniquePath('/d', 'b.dmg', p => existing.has(p)), path.join('/d', 'b.dmg'));
});

test('检测：状态流转 checking → available，并广播给订阅者', async () => {
  const u = createAppUpdater({ app: fakeApp, platform: 'darwin', arch: 'arm64', checkImpl: checkResult() });
  const seen = [];
  const off = u.onStateChange(s => seen.push(s.status));
  const s = await u.checkForUpdates();
  off();
  assert.deepStrictEqual(seen, ['checking', 'available']);
  assert.strictEqual(s.latestVersion, '1.2.0');
  assert.strictEqual(s.hasUpdate, true);
  assert.ok(s.checkedAt);
  // 并发保护：同时触发两次只检测一次
  let calls = 0;
  const u2 = createAppUpdater({ app: fakeApp, platform: 'darwin', checkImpl: async () => { calls++; return checkResult({ hasUpdate: false })(); } });
  await Promise.all([u2.checkForUpdates(), u2.checkForUpdates()]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(u2.getState().status, 'up-to-date');
});

test('检测失败：保留已知的新版本信息', async () => {
  let fail = false;
  const u = createAppUpdater({ app: fakeApp, platform: 'darwin', checkImpl: async () => (fail ? { configured: true, hasUpdate: false, error: '无法连接 GitHub 检查更新：ETIMEDOUT' } : checkResult()()) });
  await u.checkForUpdates();
  fail = true;
  const s = await u.checkForUpdates();
  assert.strictEqual(s.status, 'error');
  assert.strictEqual(s.errorKind, 'network-reset');
  assert.strictEqual(s.hasUpdate, true);
  assert.strictEqual(s.latestVersion, '1.2.0');
});

test('macOS：流式下载 dmg，.download 原子重命名，同名文件自动加序号', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'CSM-1.2.0-mac-arm64.dmg'), 'old-different-size');
  const progress = [];
  const u = createAppUpdater({
    app: fakeApp, platform: 'darwin', arch: 'arm64', downloadsDir: dir, progressIntervalMs: 0,
    checkImpl: checkResult(),
    fetchImpl: async (url, opts) => {
      assert.match(url, /mac-arm64\.dmg$/);
      assert.strictEqual(opts.redirect, 'follow');
      return streamResp(['abc', 'defg', 'hij'], { contentLength: 10 });
    }
  });
  u.onStateChange(s => s.status === 'downloading' && progress.push(s.percent));
  await u.checkForUpdates();
  const s = await u.downloadUpdate();
  assert.strictEqual(s.status, 'downloaded');
  assert.strictEqual(s.downloadedFilePath, path.join(dir, 'CSM-1.2.0-mac-arm64 (1).dmg'));
  assert.strictEqual(fs.readFileSync(s.downloadedFilePath, 'utf8'), 'abcdefghij');
  assert.strictEqual(s.percent, 100);
  assert.ok(progress.includes(30) && progress.includes(70), `progress=${progress}`);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.download')), []);
  // 原有文件不被覆盖
  assert.strictEqual(fs.readFileSync(path.join(dir, 'CSM-1.2.0-mac-arm64.dmg'), 'utf8'), 'old-different-size');
});

test('macOS：同名且大小一致的已下载文件直接复用', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'CSM-1.2.0-mac-arm64.dmg'), '0123456789');
  const u = createAppUpdater({
    app: fakeApp, platform: 'darwin', arch: 'arm64', downloadsDir: dir,
    checkImpl: checkResult(), fetchImpl: async () => streamResp(['x'], { contentLength: 10 })
  });
  const s = await u.downloadUpdate(); // 未检测过：会先自动检测
  assert.strictEqual(s.status, 'downloaded');
  assert.strictEqual(s.downloadedFilePath, path.join(dir, 'CSM-1.2.0-mac-arm64.dmg'));
  assert.deepStrictEqual(fs.readdirSync(dir), ['CSM-1.2.0-mac-arm64.dmg']);
});

test('macOS：字节数校验失败时清理临时文件并报错', async () => {
  const dir = tmpDir();
  const u = createAppUpdater({
    app: fakeApp, platform: 'darwin', arch: 'arm64', downloadsDir: dir,
    checkImpl: checkResult(), fetchImpl: async () => streamResp(['abc'], { contentLength: 10 })
  });
  const s = await u.downloadUpdate();
  assert.strictEqual(s.status, 'error');
  assert.match(s.error, /不完整/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('macOS：404 / 没有对应架构 dmg → missing-artifact', async () => {
  const dir = tmpDir();
  const u404 = createAppUpdater({
    app: fakeApp, platform: 'darwin', arch: 'arm64', downloadsDir: dir,
    checkImpl: checkResult(), fetchImpl: async () => streamResp([], { status: 404 })
  });
  const s1 = await u404.downloadUpdate();
  assert.strictEqual(s1.status, 'error');
  assert.strictEqual(s1.errorKind, 'missing-artifact');
  assert.ok(s1.htmlUrl);

  const noAsset = createAppUpdater({
    app: fakeApp, platform: 'darwin', arch: 'x64', downloadsDir: dir,
    checkImpl: checkResult({ downloadUrl: null, fileName: null }), fetchImpl: async () => { throw new Error('不应下载'); }
  });
  const s2 = await noAsset.downloadUpdate();
  assert.strictEqual(s2.errorKind, 'missing-artifact');
  assert.match(s2.error, /x64/);
});

test('macOS：openDownloaded / revealDownloaded 调用 shell，installUpdate 等同打开安装包', async () => {
  const dir = tmpDir();
  const calls = [];
  const shell = {
    openPath: async p => { calls.push(['openPath', p]); return ''; },
    showItemInFolder: p => calls.push(['showItemInFolder', p]),
    openExternal: async url => calls.push(['openExternal', url])
  };
  const u = createAppUpdater({
    app: fakeApp, platform: 'darwin', arch: 'arm64', downloadsDir: dir, shell,
    checkImpl: checkResult(), fetchImpl: async () => streamResp(['ok'], { contentLength: 2 })
  });
  assert.strictEqual((await u.openDownloaded()).ok, false);
  const s = await u.downloadUpdate();
  assert.deepStrictEqual(await u.openDownloaded(), { ok: true });
  assert.deepStrictEqual(await u.revealDownloaded(), { ok: true });
  assert.deepStrictEqual(await u.installUpdate(), { ok: true });
  assert.deepStrictEqual(await u.openRelease(), { ok: true });
  assert.deepStrictEqual(calls, [
    ['openPath', s.downloadedFilePath],
    ['showItemInFolder', s.downloadedFilePath],
    ['openPath', s.downloadedFilePath],
    ['openExternal', 'https://github.com/o/r/releases/tag/v1.2.0']
  ]);
});

test('Windows：electron-updater 下载成功 → 设置项、代理、进度、quitAndInstall', async () => {
  const au = new MockAutoUpdater({
    onCheck: me => me.emit('update-available', { version: '1.2.0' }),
    onDownload: me => {
      me.emit('download-progress', { percent: 42.4, transferred: 42, total: 100 });
      me.emit('update-downloaded', { version: '1.2.0', downloadedFile: 'C:\\cache\\CSM-Setup-1.2.0-x64.exe' });
    }
  });
  let beforeInstall = 0;
  const u = createAppUpdater({
    app: fakeApp, platform: 'win32', arch: 'x64', isPackaged: true, autoUpdater: au,
    env: { HTTPS_PROXY: 'http://127.0.0.1:7890' }, checkImpl: checkResult({ downloadUrl: null }),
    onBeforeInstall: () => { beforeInstall++; }
  });
  const percents = [];
  u.onStateChange(s => s.status === 'downloading' && percents.push(s.percent));
  await u.checkForUpdates();
  const s = await u.downloadUpdate();
  assert.strictEqual(s.status, 'downloaded');
  assert.strictEqual(s.downloadedFilePath, 'C:\\cache\\CSM-Setup-1.2.0-x64.exe');
  assert.ok(percents.includes(42));
  assert.strictEqual(au.autoDownload, false);
  assert.strictEqual(au.autoInstallOnAppQuit, false);
  assert.strictEqual(au.disableDifferentialDownload, true);
  assert.strictEqual(au.disableWebInstaller, true);
  assert.deepStrictEqual(au.calls[0], ['setProxy', { proxyRules: 'http://127.0.0.1:7890' }]);
  // 监听器全部清理，避免下次下载重复触发
  assert.strictEqual(au.listenerCount('update-downloaded'), 0);
  assert.strictEqual(au.listenerCount('error'), 0);

  assert.deepStrictEqual(await u.installUpdate(), { ok: true });
  assert.strictEqual(beforeInstall, 1);
  assert.deepStrictEqual(au.calls.at(-1), ['quitAndInstall', true, true]);
});

test('Windows：latest.yml 404 → missing-artifact；连接重置 → network-reset', async () => {
  const mk = err => new MockAutoUpdater({ onCheck: me => me.emit('error', new Error(err)) });
  const u1 = createAppUpdater({ app: fakeApp, platform: 'win32', isPackaged: true, env: {}, autoUpdater: mk('Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1.2.0/latest.yml): HttpError: 404 \nHeaders: {...}'), checkImpl: checkResult() });
  const s1 = await u1.downloadUpdate();
  assert.strictEqual(s1.status, 'error');
  assert.strictEqual(s1.errorKind, 'missing-artifact');
  assert.match(s1.error, /latest\.yml/);
  assert.doesNotMatch(s1.error, /Headers:/);

  const u2 = createAppUpdater({ app: fakeApp, platform: 'win32', isPackaged: true, env: {}, autoUpdater: mk('net::ERR_CONNECTION_RESET'), checkImpl: checkResult() });
  const s2 = await u2.downloadUpdate();
  assert.strictEqual(s2.errorKind, 'network-reset');
});

test('Windows 开发态：不支持自动安装，下载返回 unsupported', async () => {
  const u = createAppUpdater({ app: fakeApp, platform: 'win32', isPackaged: false, checkImpl: checkResult() });
  assert.strictEqual(u.getState().autoInstallSupported, false);
  const s = await u.downloadUpdate();
  assert.strictEqual(s.errorKind, 'unsupported');
  assert.match(s.error, /开发模式/);
});
