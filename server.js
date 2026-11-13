'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const express = require('express');
const open = require('open');
const { findAvailablePort } = require('./lib/port-scanner');
const oauth = require('./lib/oauth');
const { loadFilelist } = require('./lib/filelist-loader');
const { loadState, saveState, updateEntry, hashFile, fileVersion } = require('./lib/sync-state');
const { google } = require('googleapis');
const { getModifiedTimes, getCloudInfo, getCurrentUser, withRetry, uploadXlsxToSheet, uploadXlsxPreservingFormulas, downloadViaDrive, getFileInfo, resolveFolderPath, findSheetInFolder, createSheetFromXlsx } = require('./lib/drive-api');
const backups = require('./lib/backups');
const { appendHistory, readHistory } = require('./lib/history');
const { readWorkbook } = require('./lib/xlsx-reader');
const { diffWorkbooks, summarizeDiff, findRecords } = require('./lib/xlsx-diff');
const {
  getMemoryWorkbook,
  setMemoryWorkbook,
  localMemoryKey,
  cloudMemoryKey,
  getCachedExportPath,
  saveExportToCache,
  singleFlightExport,
  pruneOldExports
} = require('./lib/cloud-export-cache');
const updateCheck = require('./lib/update-check');
const githubUpdate = require('./lib/github-update');
const PKG = require('./package.json');
const localTables = require('./lib/local-tables');
const reveal = require('./lib/reveal');
const filelistEditor = require('./lib/filelist-editor');
const driveTree = require('./lib/drive-tree');
const { aggregateTables } = require('./lib/table-aggregator');
const { CONFIG_FILENAME, loadConfig, publicConfig } = require('./lib/config');
const { uploadConflict } = require('./lib/status');
const { loadProjects, addProject, removeProject, renameProject, moveProject, findProject } = require('./lib/projects');
const { listDirs } = require('./lib/fs-browser');
const { pickFolder } = require('./lib/native-picker');
const { sseSetup, sseEmit } = require('./lib/sse');
const bookmarksLib = require('./lib/bookmarks');
const faviconsLib = require('./lib/favicons');
const { runSteps } = require('./lib/gen-client-runner');
const { loadSidecar, updateSidecar } = require('./lib/version-sidecar');

const ROOT = __dirname;
const DEFAULT_PORT = 7321;
const SYNC_CONCURRENCY = 3; // 批量下载同时进行的表数（Drive 导出较慢，并发能明显缩短「下载所有更新」）

// 平台数据目录：项目注册表、Google 令牌、各项目的同步状态都在这里，与被管理的项目仓库互不污染
function defaultDataDir() {
  const dir = process.env.CSM_DATA || process.env.SYNC_MANAGER_DATA; // 旧变量名继续兼容
  return dir ? path.resolve(dir) : path.join(ROOT, 'data');
}

function buildOAuthClient(port, credentialsPath, tokenPath) {
  const credentials = oauth.loadCredentials(credentialsPath);
  const redirectUri = `http://localhost:${port}/oauth2callback`;
  const client = oauth.createOAuthClient(credentials, redirectUri);
  const token = oauth.loadToken(tokenPath);
  if (token) {
    client.setCredentials(token);
    attachTokenListener(client, tokenPath);
  }
  return { client, hasToken: !!token };
}

function attachTokenListener(client, tokenPath) {
  client.removeAllListeners('tokens');
  client.on('tokens', updated => {
    oauth.saveToken(tokenPath, { ...oauth.loadToken(tokenPath), ...updated });
  });
}

// 旧版把令牌放在工具目录 .tokens/，迁移到数据目录
function migrateLegacyToken(tokenPath) {
  const legacy = path.join(ROOT, '.tokens/token.json');
  if (!fs.existsSync(tokenPath) && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.copyFileSync(legacy, tokenPath);
  }
}

/**
 * 启动服务。命令行直接运行时全部用默认值；桌面 App（electron/main.js）会传入：
 * - dataDir：数据目录（App 内部只读，放到系统的应用数据目录）
 * - credentialsPath：OAuth 客户端凭证路径
 * - openBrowser：是否自动拉起系统浏览器（App 自己有窗口，传 false）
 * - pickFolder：替换原生选目录实现（App 用 Electron 自带对话框）
 * - onAuthorized：授权完成回调（App 收到后刷新窗口）
 * 返回 { port, url, hasToken, server }。
 */
async function main(opts = {}) {
  const DATA_DIR = opts.dataDir ? path.resolve(opts.dataDir) : defaultDataDir();
  const REGISTRY_PATH = path.join(DATA_DIR, 'projects.json');
  const TOKEN_PATH = path.join(DATA_DIR, '.tokens/token.json');
  const BOOKMARKS_PATH = path.join(DATA_DIR, 'bookmarks.json');
  const CREDENTIALS_PATH = opts.credentialsPath || path.join(ROOT, 'credentials.json');
  const openBrowser = opts.openBrowser !== undefined ? opts.openBrowser : !(process.env.CSM_NO_OPEN || process.env.SYNC_MANAGER_NO_OPEN);
  const pickFolderImpl = opts.pickFolder || pickFolder;
  const revealImpl = opts.revealPath || reveal.revealPath;
  const onAuthorized = opts.onAuthorized || (() => {});

  migrateLegacyToken(TOKEN_PATH);
  const listenPort = opts.port !== undefined ? opts.port : await findAvailablePort(DEFAULT_PORT);
  const app = express();

  // 拒绝跨站请求：浏览器会给跨站 POST 带上 Origin，只放行本机页面自己发的请求
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin) {
      let host = '';
      try { host = new URL(origin).host; } catch (_) { /* 非法 Origin 直接拒绝 */ }
      if (host !== req.headers.host) return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    next();
  });
  app.use(express.json());

  let { client: oauth2Client, hasToken } = buildOAuthClient(listenPort, CREDENTIALS_PATH, TOKEN_PATH);
  const driveCaches = new Map(); // projectId -> Map(spreadsheetId -> { modifiedTime, name, error })

  const statePathOf = id => path.join(DATA_DIR, 'projects', id, '.sync_state.json');
  const backupRootOf = id => path.join(DATA_DIR, 'projects', id, 'backups');
  const historyPathOf = id => path.join(DATA_DIR, 'projects', id, 'history.jsonl');
  const driveCachePathOf = id => path.join(DATA_DIR, 'projects', id, 'drive-cache.json');
  const verifyCachePathOf = id => path.join(DATA_DIR, 'projects', id, 'verify-cache.json');
  const exportCacheDir = path.join(DATA_DIR, 'cache', 'cloud-exports');
  pruneOldExports(exportCacheDir);
  const faviconCacheDir = path.join(DATA_DIR, 'cache', 'favicons');
  // 内存里的云端时间是不是本次运行实际查询过的（false = 从磁盘读的上次结果，界面会在后台补刷）
  const driveCacheFresh = new Map(); // projectId -> boolean
  const driveCacheFetchedAt = new Map(); // projectId -> ISO 时间
  const verifyCaches = new Map(); // projectId -> { [path]: { key, checkedAt, summary } }
  const diffSnapshots = new Map(); // 最近两次差异预览的工作簿，按 ID 搜索复用
  const cloudPathPreviews = new Map(); // projectId -> 最近一次待应用的云端路径预览
  const downloadsInProgress = new Set();
  const verifyStatuses = new Set(['updated', 'conflict', 'local_changed', 'never_synced']);

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
  }
  function writeJson(file, data) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (err) { console.error('[csm] write cache failed:', err.message); }
  }
  function verifyCacheOf(id) {
    if (!verifyCaches.has(id)) verifyCaches.set(id, readJson(verifyCachePathOf(id), {}) || {});
    return verifyCaches.get(id);
  }
  function clearVerifyCache(id) {
    verifyCaches.delete(id);
    writeJson(verifyCachePathOf(id), {});
  }
  const TMP_DIR = path.join(DATA_DIR, 'tmp');

  // 当前 Google 账号（写操作历史用），授权后首次需要时查询一次
  let currentUser = null;
  let authEpoch = 0;
  async function actor() {
    if (!currentUser && hasToken) {
      try { currentUser = await getCurrentUser(oauth2Client); } catch (_) { currentUser = { name: null, email: null }; }
    }
    let osUser = null;
    try { osUser = require('node:os').userInfo().username; } catch (_) { /* 忽略 */ }
    return { account: (currentUser && (currentUser.email || currentUser.name)) || null, osUser };
  }
  async function logHistory(ctx, record) {
    try { appendHistory(historyPathOf(ctx.id), { ...(await actor()), ...record }); } catch (err) { console.error('[csm] history write failed:', err.message); }
  }

  // 每次请求都重新读取项目配置，改完 syncmanager.config.json 无需重启即可生效
  function getCtx(id) {
    const project = findProject(REGISTRY_PATH, id);
    if (!project) return null;
    const cfg = loadConfig(path.join(project.dir, CONFIG_FILENAME), { statePath: statePathOf(id) });
    if (!driveCaches.has(id)) driveCaches.set(id, new Map());
    return { project, cfg, id };
  }

  async function refreshDriveCache(ctx) {
    if (!hasToken) throw new Error('OAUTH_REQUIRED');
    const filelist = loadFilelist(ctx.cfg.filelistPath);
    const ids = filelist.filter(e => e.spreadsheetId).map(e => e.spreadsheetId);
    const map = await getModifiedTimes(ids, oauth2Client);
    if (map.size && [...map.values()].every(v => v.error && !['forbidden', 'not_found'].includes(v.error))) {
      throw new Error('本次无法查询云端表格，请检查网络或 Google 授权后重试');
    }
    driveCaches.set(ctx.id, map);
    driveCacheFresh.set(ctx.id, true);
    const fetchedAt = new Date().toISOString();
    driveCacheFetchedAt.set(ctx.id, fetchedAt);
    // 只存查询成功的条目：下次启动先用它显示列表（随后后台刷新），不用等全部查询完
    writeJson(driveCachePathOf(ctx.id), { fetchedAt, items: Object.fromEntries([...map].filter(([, v]) => !v.error)) });
  }

  // 内存里还没有云端时间时：有上次的磁盘缓存就先用它（返回 true），否则需要现查
  function loadDiskDriveCache(ctx) {
    if (driveCaches.get(ctx.id).size > 0) return true;
    const saved = readJson(driveCachePathOf(ctx.id), null);
    if (!saved || !saved.items || !Object.keys(saved.items).length) return false;
    driveCaches.set(ctx.id, new Map(Object.entries(saved.items)));
    driveCacheFresh.set(ctx.id, false);
    driveCacheFetchedAt.set(ctx.id, saved.fetchedAt || null);
    return true;
  }

  // 列表要用云端时间：内存 → 磁盘缓存 → 现查。返回是否为旧数据
  async function ensureDriveCache(ctx) {
    if (!loadDiskDriveCache(ctx)) await refreshDriveCache(ctx);
    return driveCacheFresh.get(ctx.id) === false;
  }
  function markCloudChecked(res, ctx, stale = false) {
    const checkedAt = driveCacheFetchedAt.get(ctx.id);
    if (checkedAt) res.set('X-CSM-Checked-At', checkedAt);
    if (stale) res.set('X-CSM-Stale', checkedAt || '1');
  }

  // 用入仓的 sidecar 为尚无本地状态的条目补状态：xlsx 来自 git 而非过期下载，应视为已同步
  function bootstrapStateFromSidecar(ctx, filelist, state) {
    if (!ctx.cfg.sidecarPath) return false;
    const sidecar = loadSidecar(ctx.cfg.sidecarPath);
    let changed = false;
    for (const entry of filelist) {
      if (state[entry.path]) continue;
      const recordedModifiedTime = sidecar[entry.path];
      if (!recordedModifiedTime) continue;
      let stat;
      try { stat = fs.statSync(entry.savePath); } catch (_) { continue; }
      state[entry.path] = {
        lastSyncedAt: new Date().toISOString(),
        lastSyncedModifiedTime: recordedModifiedTime,
        lastSyncedSize: stat.size,
        lastSyncedMtime: stat.mtime.toISOString(),
        lastSyncedHash: hashFile(entry.savePath)
      };
      changed = true;
    }
    return changed;
  }

  // 旧的同步记录没有内容指纹：文件修改时间与记录一致（同步后没动过）时补记指纹，之后 git 操作只改时间也能识别为未改动
  function backfillHashes(filelist, state) {
    let changed = false;
    for (const entry of filelist) {
      const row = state[entry.path];
      if (!row || row.lastSyncedHash || !row.lastSyncedMtime) continue;
      let st;
      try { st = fs.statSync(entry.savePath); } catch (_) { continue; }
      if (st.mtime.toISOString() !== row.lastSyncedMtime || st.size !== row.lastSyncedSize) continue;
      const h = hashFile(entry.savePath);
      if (h) { row.lastSyncedHash = h; changed = true; }
    }
    return changed;
  }

  function verifyKey(entry, row, localHash) {
    return JSON.stringify([entry.spreadsheetId, row.cloudModifiedTime, localHash, entry.diffKeys]);
  }

  function tablesOf(ctx, { driveMap = driveCaches.get(ctx.id), persistState = true } = {}) {
    const filelist = loadFilelist(ctx.cfg.filelistPath);
    const state = loadState(ctx.cfg.statePath);
    const bootstrapped = bootstrapStateFromSidecar(ctx, filelist, state);
    const backfilled = backfillHashes(filelist, state);
    if (persistState && (bootstrapped || backfilled)) saveState(ctx.cfg.statePath, state);
    const cache = verifyCacheOf(ctx.id);
    return aggregateTables(filelist, driveMap, state).map((row, i) => {
      const saved = Object.hasOwn(cache, row.path) && cache[row.path];
      if (!saved?.summary || driveCacheFresh.get(ctx.id) !== true || !verifyStatuses.has(row.status)) return row;
      const entry = filelist[i];
      if (saved.key !== verifyKey(entry, row, hashFile(entry.savePath))) return row;
      return { ...row, changeSummary: saved.summary, checkedAt: saved.checkedAt };
    });
  }

  // ---------- 全局：授权 / 健康检查 ----------
  app.get('/auth/start', (_req, res) => {
    res.redirect(oauth.getAuthUrl(oauth2Client));
  });

  app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('missing code');
    try {
      const tokens = await oauth.exchangeCodeForToken(oauth2Client, code);
      oauth.saveToken(TOKEN_PATH, tokens);
      oauth2Client.setCredentials(tokens);
      attachTokenListener(oauth2Client, TOKEN_PATH);
      hasToken = true;
      currentUser = null;
      driveCaches.clear();
      driveCacheFresh.clear();
      diffSnapshots.clear();
      cloudPathPreviews.clear();
      authEpoch++;
      for (const project of loadProjects(REGISTRY_PATH)) clearVerifyCache(project.id);
      if (opts.authSuccessHtml) res.type('html').send(opts.authSuccessHtml);
      else res.redirect('/');
      onAuthorized();
    } catch (err) {
      res.status(500).send(`oauth error: ${err.message}`);
    }
  });

  app.get('/api/auth-status', async (_req, res) => {
    let act = null;
    if (hasToken) {
      try { act = await actor(); } catch (_) {}
    }
    res.json({
      authorized: hasToken,
      canUpload: hasToken && oauth.hasUploadScope(oauth.loadToken(TOKEN_PATH)),
      account: act ? act.account : null,
      osUser: act ? act.osUser : null
    });
  });

  app.post('/api/auth-logout', (_req, res) => {
    try {
      oauth.clearToken(TOKEN_PATH);
      const rebuilt = buildOAuthClient(port, CREDENTIALS_PATH, TOKEN_PATH);
      oauth2Client = rebuilt.client;
      hasToken = false;
      currentUser = null;
      driveCaches.clear();
      driveCacheFresh.clear();
      diffSnapshots.clear();
      cloudPathPreviews.clear();
      authEpoch++;
      for (const project of loadProjects(REGISTRY_PATH)) clearVerifyCache(project.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // ---------- 版本更新提示 ----------
  const updateSource = () => process.env.CSM_UPDATE_URL || (PKG.csm && PKG.csm.updateUrl) || '';
  let updateCache = null; // { at, result }
  const UPDATE_TTL_MS = 60 * 60 * 1000;
  app.get('/api/update-check', async (req, res) => {
    const source = updateSource();
    if (updateCache && req.query.force !== '1' && Date.now() - updateCache.at < UPDATE_TTL_MS) return res.json(updateCache.result);
    // 未显式配置自定义更新源：默认检测 GitHub Releases（dehuaichendragonplus/csm）
    if (!source) {
      const result = await githubUpdate.checkGitHubUpdate({ current: PKG.version, log: msg => console.log(msg) });
      if (!result.error) updateCache = { at: Date.now(), result };
      return res.json(result);
    }
    try {
      const result = await updateCheck.checkForUpdate({
        source,
        current: PKG.version,
        fetchJson: url => updateCheck.httpJson(url),
        fetchDrive: hasToken ? async fileId => {
          const drive = google.drive({ version: 'v3', auth: oauth2Client });
          const resp = await withRetry(() => drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' }));
          return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
        } : null
      });
      updateCache = { at: Date.now(), result };
      res.json(result);
    } catch (err) {
      res.json({ configured: true, current: PKG.version, hasUpdate: false, error: err.message });
    }
  });

  // ---------- 项目管理 ----------
  app.get('/api/projects', (_req, res) => {
    res.json(loadProjects(REGISTRY_PATH));
  });

  app.post('/api/projects', (req, res) => {
    const dir = req.body && req.body.dir;
    if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'dir 不能为空' });
    try {
      res.json(addProject(REGISTRY_PATH, dir, req.body.name));
    } catch (err) {
      res.status(err.code === 'DUPLICATE' ? 409 : 400).json({ error: err.message });
    }
  });

  app.post('/api/projects/reorder', (req, res) => {
    const { id, targetId, position } = req.body || {};
    if (typeof id !== 'string' || typeof targetId !== 'string' || !id || !targetId ||
        (position !== 'before' && position !== 'after')) {
      return res.status(400).json({ error: '缺少有效的项目或插入位置' });
    }
    const ordered = moveProject(REGISTRY_PATH, id, targetId, position);
    if (!ordered) return res.status(404).json({ error: '项目不存在' });
    res.json({ order: ordered.map(p => p.id) });
  });

  app.patch('/api/projects/:id', (req, res) => {
    try {
      const p = renameProject(REGISTRY_PATH, req.params.id, req.body && req.body.name);
      if (!p) return res.status(404).json({ error: 'unknown project' });
      res.json(p);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 只从平台移除，不删除项目目录里的任何文件
  app.delete('/api/projects/:id', (req, res) => {
    if (!removeProject(REGISTRY_PATH, req.params.id)) return res.status(404).json({ error: 'unknown project' });
    driveCaches.delete(req.params.id);
    driveCacheFresh.delete(req.params.id);
    cloudPathPreviews.delete(req.params.id);
    res.json({ ok: true });
  });

  // ---------- 本地在线文档收藏管理 ----------
  app.get('/api/bookmarks', (req, res) => {
    try {
      const projectId = req.query.projectId || null;
      const result = bookmarksLib.getBookmarks(BOOKMARKS_PATH, projectId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/bookmarks', (req, res) => {
    try {
      const valid = bookmarksLib.validateBookmarkInput(req.body);
      if (!valid.valid) {
        return res.status(400).json({ error: valid.error });
      }
      const bookmark = bookmarksLib.addBookmark(BOOKMARKS_PATH, req.body);
      res.status(201).json({ bookmark });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/bookmarks/:id', (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: '请求数据无效' });
      }
      const updated = bookmarksLib.updateBookmark(BOOKMARKS_PATH, req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: '未找到指定文档收藏' });
      res.json({ bookmark: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/bookmarks/:id', (req, res) => {
    try {
      const ok = bookmarksLib.deleteBookmark(BOOKMARKS_PATH, req.params.id);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 网站 Favicon 图标获取与缓存代理 ----------
  app.get('/api/favicon', async (req, res) => {
    const rawUrl = req.query.url;
    const title = req.query.title || '';
    if (!rawUrl || typeof rawUrl !== 'string') {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(faviconsLib.getFallbackSvg('', title));
    }
    try {
      const result = await faviconsLib.getFavicon(rawUrl, faviconCacheDir, title);
      res.setHeader('Content-Type', result.contentType || 'image/x-icon');
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 天客户端强缓存
      res.send(result.buffer);
    } catch (_) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.send(faviconsLib.getFallbackSvg(rawUrl, title));
    }
  });

  // ---------- 所有项目状态汇总（用于 Tab 角标与 Dock Badge） ----------
  function computeProjectSummary(id) {
    const ctx = getCtx(id);
    if (!ctx) return null;
    loadDiskDriveCache(ctx);
    const rows = tablesOf(ctx);
    const updated = rows.filter(r => r.status === 'updated').length;
    const conflict = rows.filter(r => r.status === 'conflict').length;
    const missing = rows.filter(r => r.status === 'missing_local').length;
    const neverSynced = rows.filter(r => r.status === 'never_synced').length;
    const pending = rows.filter(r => r.direction === 'download' || r.direction === 'conflict' || r.status === 'never_synced').length;
    return {
      id,
      name: ctx.project.name,
      dir: ctx.project.dir,
      total: rows.length,
      pending,
      updated,
      conflict,
      missing,
      neverSynced
    };
  }

  app.get('/api/projects-summary', (_req, res) => {
    try {
      const list = loadProjects(REGISTRY_PATH);
      const projects = [];
      let totalPending = 0;
      for (const p of list) {
        try {
          const s = computeProjectSummary(p.id);
          if (s) {
            projects.push(s);
            totalPending += (s.pending || 0);
          }
        } catch (e) {
          projects.push({ id: p.id, name: p.name, dir: p.dir, total: 0, pending: 0, error: e.message });
        }
      }
      res.json({ projects, totalPending });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 原生角标与通知转发接口 ----------
  app.post('/api/badge', (req, res) => {
    const count = parseInt(req.body && req.body.count, 10) || 0;
    if (typeof opts.setBadge === 'function') {
      try { opts.setBadge(count); } catch (_) {}
    }
    res.json({ ok: true, count });
  });

  app.post('/api/notify', (req, res) => {
    const { title, body } = req.body || {};
    let shown = false;
    if (typeof opts.showNotification === 'function') {
      try { shown = !!opts.showNotification({ title, body }); } catch (_) {}
    }
    res.json({ ok: true, shown });
  });

  // 目录浏览（仅列子目录），供「添加项目」弹窗使用
  app.get('/api/fs/list', (req, res) => {
    try {
      res.json(listDirs(req.query.path));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 弹出系统原生选目录对话框（macOS 访达 / Windows 资源管理器）
  app.post('/api/fs/pick', async (req, res) => {
    try {
      res.json(await pickFolderImpl(req.body && req.body.start));
    } catch (err) {
      res.status(501).json({ error: err.message });
    }
  });

  // ---------- 项目级路由：/api/p/:pid/... ----------
  const projectRouter = express.Router({ mergeParams: true });
  projectRouter.use((req, res, next) => {
    try {
      const ctx = getCtx(req.params.pid);
      if (!ctx) return res.status(404).json({ error: `unknown project: ${req.params.pid}` });
      req.ctx = ctx;
      next();
    } catch (err) {
      res.status(500).json({ error: `项目配置有误: ${err.message}` });
    }
  });

  projectRouter.get('/config', (req, res) => {
    res.json({ ...publicConfig(req.ctx.cfg), dir: req.ctx.project.dir });
  });

  projectRouter.get('/tables', async (req, res) => {
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    try {
      // 启动时先用上次的云端时间立即显示，界面看到 X-CSM-Stale 后会在后台刷新
      markCloudChecked(res, req.ctx, await ensureDriveCache(req.ctx));
      res.json(tablesOf(req.ctx));
    } catch (err) {
      if (err.message === 'OAUTH_REQUIRED') return res.status(401).json({ error: 'OAUTH_REQUIRED' });
      res.status(500).json({ error: err.message });
    }
  });

  projectRouter.post('/refresh', async (req, res) => {
    try {
      await refreshDriveCache(req.ctx);
      markCloudChecked(res, req.ctx);
      if (req.query.reuse !== '1') clearVerifyCache(req.ctx.id);
      res.json(tablesOf(req.ctx));
    } catch (err) {
      if (err.message === 'OAUTH_REQUIRED') return res.status(401).json({ error: 'OAUTH_REQUIRED' });
      res.status(500).json({ error: err.message });
    }
  });

  function skipDownload(message) {
    return Object.assign(new Error(message), { code: 'SYNC_SKIPPED' });
  }

  function checkDownloadBinding(ctx, entry) {
    try {
      const cfg = loadConfig(path.join(ctx.project.dir, CONFIG_FILENAME), { statePath: ctx.cfg.statePath });
      const latest = loadFilelist(cfg.filelistPath).find(row => row.path === entry.path);
      if (latest?.spreadsheetId === entry.spreadsheetId && latest.savePath === entry.savePath
          && JSON.stringify(latest.diffKeys) === JSON.stringify(entry.diffKeys)
          && cfg.filelistPath === ctx.cfg.filelistPath && cfg.sidecarPath === ctx.cfg.sidecarPath) return;
    } catch (_) { /* 项目配置或表清单已无法读取 */ }
    throw skipDownload('配置表绑定或导出设置已变化，请刷新后重新选择');
  }

  // 批量下载先检查用户所选版本，把云端导出到暂存文件，确认两端仍一致后再替换。
  async function downloadTable(ctx, entry, log, version) {
    const { cfg, id } = ctx;
    const epoch = authEpoch;
    const info = await getCloudInfo(entry.spreadsheetId, oauth2Client);
    let tmp;
    let summary = null;
    let backup;
    try {
      if (version) {
        if (epoch !== authEpoch) throw skipDownload('Google 账号已变更，请重新选择');
        const drive = new Map([[entry.spreadsheetId, info]]);
        checkDownloadBinding(ctx, entry);
        const state = loadState(cfg.statePath);
        bootstrapStateFromSidecar(ctx, [entry], state);
        const [row] = aggregateTables([entry], drive, state);
        const localHash = hashFile(entry.savePath);
        if (row.status === 'synced' && row.lastSyncedModifiedTime === version.cloudModifiedTime
            && row.cloudModifiedTime === version.cloudModifiedTime && row.spreadsheetId === version.spreadsheetId
            && localHash && state[entry.path]?.lastSyncedHash === localHash) {
          if (cfg.sidecarPath && loadSidecar(cfg.sidecarPath)[entry.path] !== info.modifiedTime) {
            updateSidecar(cfg.sidecarPath, entry.path, info.modifiedTime);
          }
          driveCaches.get(id).set(entry.spreadsheetId, info);
          return { info, backup: null, summary: null, alreadySynced: true };
        }
        if ((version.reviewed !== true && row.direction !== 'download') || row.status === 'error'
            || row.spreadsheetId !== version.spreadsheetId
            || row.cloudModifiedTime !== version.cloudModifiedTime || row.localVersion !== version.localVersion) {
          throw skipDownload('版本或同步方向已变化，请刷新后重新选择');
        }
        if (row.localExists && !localHash) throw new Error('无法读取本地表格');
        // 暂存文件与目标在同一目录，替换时可原子重命名。
        tmp = `${entry.savePath}.csm-${randomUUID()}.tmp`;
        const cachedExport = getCachedExportPath(exportCacheDir, entry.spreadsheetId, info.modifiedTime);
        if (cachedExport && fs.existsSync(cachedExport)) {
          fs.copyFileSync(cachedExport, tmp);
        } else {
          await downloadViaDrive(entry.spreadsheetId, tmp, oauth2Client);
          saveExportToCache(exportCacheDir, entry.spreadsheetId, info.modifiedTime, tmp);
        }
        const cKey = cloudMemoryKey(entry.spreadsheetId, info.modifiedTime);
        let cloud = getMemoryWorkbook(cKey);
        if (!cloud) {
          cloud = readWorkbook(tmp);
          setMemoryWorkbook(cKey, cloud);
        }
        try {
          let local = [];
          if (row.localExists) {
            const localStat = fs.statSync(entry.savePath);
            const lKey = localMemoryKey(entry.savePath, localStat);
            local = getMemoryWorkbook(lKey);
            if (!local) {
              local = readWorkbook(entry.savePath);
              setMemoryWorkbook(lKey, local);
            }
          }
          summary = summarizeDiff(diffWorkbooks(local, cloud, { keys: entry.diffKeys, view: false, maxChanges: 0 }));
        } catch (err) {
          log(`  ↳ 无法生成差异摘要：${err.message}\n`);
        }
        const latest = await getCloudInfo(entry.spreadsheetId, oauth2Client);
        if (epoch !== authEpoch) throw skipDownload('Google 账号已变更，请重新选择');
        checkDownloadBinding(ctx, entry);
        if (latest.modifiedTime !== info.modifiedTime || hashFile(entry.savePath) !== localHash) {
          throw skipDownload('下载期间两端版本有变化，请刷新后重新选择');
        }
      }
      backup = backups.backupFile(backupRootOf(id), entry.path, entry.savePath, { reason: '下载前自动备份' });
      if (backup && !backup.deduped) log(`  ↳ 已备份本地文件（${backup.id}）\n`);
      if (tmp) fs.renameSync(tmp, entry.savePath);
      else await downloadViaDrive(entry.spreadsheetId, entry.savePath, oauth2Client);
      const stat = fs.statSync(entry.savePath);
      updateEntry(cfg.statePath, entry.path, {
        lastSyncedModifiedTime: info.modifiedTime,
        lastSyncedSize: stat.size,
        lastSyncedMtime: stat.mtime.toISOString(),
        lastSyncedHash: hashFile(entry.savePath)
      });
      if (cfg.sidecarPath) updateSidecar(cfg.sidecarPath, entry.path, info.modifiedTime);
      delete verifyCacheOf(id)[entry.path];
      driveCaches.get(id).set(entry.spreadsheetId, info);
      return { info, backup, summary };
    } finally {
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  }

  projectRouter.post('/sync', async (req, res) => {
    const { cfg, id } = req.ctx;
    const { paths, versions } = req.body || {};
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) return res.status(400).json({ error: 'paths must be an array of strings' });
    if (versions != null && (typeof versions !== 'object' || paths.some(p => !Object.hasOwn(versions, p) || !versions[p]))) {
      return res.status(400).json({ error: '批次缺少表格版本' });
    }
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });

    sseSetup(res);
    let aborted = false;
    res.on('close', () => { aborted = !res.writableFinished; });
    const emit = (ev, data) => { if (!aborted) sseEmit(res, ev, data); };

    const byPath = new Map(loadFilelist(cfg.filelistPath).map(e => [e.path, e]));
    let successCount = 0;
    let failedCount = 0;
    const queue = [...new Set(paths)];

    async function worker() {
      while (queue.length) {
        const p = queue.shift();
        const entry = byPath.get(p);
        const downloadKey = JSON.stringify([id, p]);
        emit('table-start', { path: p });
        try {
          if (!entry || entry.incomplete) throw skipDownload(entry?.incompleteReason || '表格已从清单移除');
          if (downloadsInProgress.has(downloadKey)) throw new Error('该表正在下载，请稍后重试');
          downloadsInProgress.add(downloadKey);
          try {
            emit('log', `→ downloading ${entry.name} (${p})\n`);
            const { info, backup, summary, alreadySynced } = await downloadTable(req.ctx, entry, line => emit('log', line), versions?.[p]);
            if (!alreadySynced) {
              await logHistory(req.ctx, { op: 'download', path: p, name: entry.name, ok: true, cloudModifiedTime: info.modifiedTime, cloudModifiedBy: info.modifiedBy, backup: backup && backup.id });
            }
            emit('table-done', { path: p, success: true, backup: backup && backup.id, ...(versions ? { summary } : {}) });
            successCount++;
          } finally {
            downloadsInProgress.delete(downloadKey);
          }
        } catch (err) {
          const skipped = err.code === 'SYNC_SKIPPED';
          await logHistory(req.ctx, { op: 'download', path: p, name: entry?.name, ok: false, error: err.message });
          emit('table-done', { path: p, success: false, skipped, error: err.message });
          failedCount++;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, queue.length) }, worker));

    emit('done', { successCount, failedCount, exitCode: null });
    res.end();
  });

  // 把本地 xlsx（filelist 中的 savePath）上传覆盖云端表，?path=<filelist 中的 path>
  projectRouter.post('/upload', async (req, res) => {
    const { cfg, id } = req.ctx;
    if (!cfg.allowUpload) return res.status(403).json({ error: '配置已禁用上传' });
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    if (!oauth.hasUploadScope(oauth.loadToken(TOKEN_PATH))) {
      return res.status(403).json({ error: 'NEED_UPLOAD_SCOPE' });
    }
    const entry = loadFilelist(cfg.filelistPath).find(e => e.path === req.query.path);
    if (!entry) return res.status(404).json({ error: `unknown path: ${req.query.path}` });
    if (!entry.spreadsheetId) return res.status(400).json({ error: '该表没有 spreadsheetId，无法上传' });
    let buf;
    try { buf = fs.readFileSync(entry.savePath); } catch (_) {
      return res.status(404).json({ error: `本地文件不存在: ${entry.savePath}` });
    }
    // xlsx 是 zip，魔数 PK
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      return res.status(400).json({ error: '本地文件不是有效的 xlsx' });
    }
    // 冲突检测：上传前重新查一次云端。用户确认上传时看到的云端时间（expect）或上次同步的时间之后云端又被改过，
    // 直接覆盖会把别人的改动冲掉 —— 返回 409，由用户看过差异后决定是否强制覆盖（force=1）
    let before;
    try { before = await getCloudInfo(entry.spreadsheetId, oauth2Client); } catch (err) {
      return res.status(502).json({ error: `查询云端状态失败：${err.message}` });
    }
    const stateRow = loadState(cfg.statePath)[entry.path] || null;
    const cached = driveCaches.get(id).get(entry.spreadsheetId);
    const conflict = uploadConflict({
      cloudModifiedTime: before.modifiedTime,
      expect: req.query.expect,
      lastSyncedModifiedTime: stateRow && stateRow.lastSyncedModifiedTime,
      cachedModifiedTime: cached && cached.modifiedTime,
      force: req.query.force === '1'
    });
    if (conflict) {
      return res.status(409).json({
        error: 'CLOUD_CHANGED',
        message: `云端在 ${before.modifiedTime} 被${before.modifiedBy ? `「${before.modifiedBy}」` : '其他人'}修改过，晚于你确认时看到的版本`,
        cloudModifiedTime: before.modifiedTime,
        cloudModifiedBy: before.modifiedBy,
        baseline: conflict.baseline
      });
    }
    try {
      // 默认保留云端公式：云端有公式（如 IMPORTRANGE 镜像主表）时按单元格写入、不动公式；镜像区的改动写回源表（需 writeThrough=1 确认）。
      // 配置 preserveCloudFormulas:false 可退回整表替换
      const info = cfg.preserveCloudFormulas === false
        ? await uploadXlsxToSheet(entry.spreadsheetId, buf, oauth2Client)
        : await uploadXlsxPreservingFormulas(entry.spreadsheetId, buf, oauth2Client, { writeThrough: req.query.writeThrough === '1' });
      const extra = info.formulaProtected ? {
        formulaProtected: true, written: info.written, sourceWriteCount: info.sourceWriteCount, sources: info.sources,
        derivedCount: info.derivedCount, derivedSamples: info.derivedSamples,
        blockedCount: info.blockedCount, blockedSamples: info.blockedSamples,
        formulaSheets: info.formulaSheets, localOnlySheets: info.localOnlySheets, cloudOnlySheets: info.cloudOnlySheets
      } : {};
      // 需要改源表：先把预览给用户确认，此时什么都没写
      if (info.needsWriteThrough) return res.status(409).json({ error: 'NEEDS_WRITE_THROUGH', ...extra });
      // 还有写不进去的差异（源表有公式 / 源表刚被改过 / 超出公式范围 / 冲突）：云端与本地不一致，不记为「已同步」
      const partial = !!(info.formulaProtected && (info.blockedCount > 0 || (info.localOnlySheets || []).length > 0));
      // 云端内容已与本地一致：记为已同步（并等 Drive 转换后修改时间稳定再记一次），避免上传后显示「有更新」
      const markSynced = modifiedTime => {
        const st = fs.statSync(entry.savePath);
        updateEntry(cfg.statePath, entry.path, { lastSyncedModifiedTime: modifiedTime, lastSyncedSize: st.size, lastSyncedMtime: st.mtime.toISOString(), lastSyncedHash: hashFile(entry.savePath) });
        if (cfg.sidecarPath) updateSidecar(cfg.sidecarPath, entry.path, modifiedTime);
        delete verifyCacheOf(id)[entry.path];
        driveCaches.get(id).set(entry.spreadsheetId, { modifiedTime, name: info.name, modifiedBy: currentUser && (currentUser.name || currentUser.email), error: null });
      };
      if (!partial) {
        markSynced(info.modifiedTime);
        settleModifiedTime(entry.spreadsheetId, info.modifiedTime).then(t => { if (t !== info.modifiedTime) markSynced(t); }).catch(() => {});
      }
      await logHistory(req.ctx, {
        op: 'upload', path: entry.path, name: entry.name, ok: true, forced: req.query.force === '1',
        cloudModifiedTime: info.modifiedTime, replacedCloudModifiedTime: before.modifiedTime, replacedCloudModifiedBy: before.modifiedBy,
        ...(info.formulaProtected ? {
          formulaProtected: true, written: info.written, sourceWriteCount: info.sourceWriteCount, blockedCount: info.blockedCount,
          sources: (info.sources || []).map(x => ({ sourceId: x.sourceId, name: x.name, count: x.sheets.reduce((n, t) => n + t.count, 0) }))
        } : {})
      });
      res.json({ ok: true, modifiedTime: info.modifiedTime, size: buf.length, ...(info.formulaProtected ? { ...extra, partial } : {}) });
    } catch (err) {
      await logHistory(req.ctx, { op: 'upload', path: entry.path, name: entry.name, ok: false, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 配置表清单（filelist.json）预览与编辑 ----------
  const editorStatus = err => ({ INVALID: 400, INVALID_JSON: 500, NOT_FOUND: 404, DUPLICATE_PATH: 409, DUPLICATE_ID: 409, STALE_PREVIEW: 409 }[err.code] || 500);
  const sendEditorError = (res, err) => res.status(err.status || editorStatus(err)).json({ error: err.message, code: err.code, paths: err.paths });

  // 云端目录树：文件夹元信息全局缓存；云端根目录按项目缓存
  let treeClient = null;
  const tree = () => (treeClient = treeClient || driveTree.createTreeClient(oauth2Client));
  const rootResolver = driveTree.createRootResolver();

  // 当前项目的「云端根目录 ↔ 本地目录」：优先用配置里的 cloudRoot，否则按已有条目推断
  async function projectRoot(ctx, entries) {
    const conf = ctx.cfg.cloudRoot;
    if (conf) {
      const meta = await tree().getMeta(conf.folderId);
      if (!meta) return { error: `配置的云端根目录无法访问（${conf.folderId}）`, source: 'config' };
      const chain = await tree().parentChain(conf.folderId, meta);
      return {
        rootId: meta.id,
        rootName: meta.name,
        rootPath: [...chain.map(f => f.name), meta.name].join(' / '),
        localRoot: conf.local,
        source: 'config'
      };
    }
    return rootResolver.resolve({ projectId: ctx.id, cacheKey: ctx.cfg.filelistPath, entries, tree: tree() });
  }

  // 根据云端表的位置推荐表名 / 本地路径 / 备注
  async function suggestForSheet(ctx, spreadsheetId, entries) {
    const info = await getFileInfo(spreadsheetId, oauth2Client);
    const chain = await tree().parentChain(spreadsheetId, info.parents ? info : null);
    const root = await projectRoot(ctx, entries);
    const usable = root && !root.error ? root : null;
    const align = driveTree.alignDir(chain, usable);
    return {
      info,
      suggestion: filelistEditor.suggestEntry(info.name, entries, align.dir),
      location: {
        cloudDir: align.cloudDir,
        mode: align.mode,
        root: root ? { rootPath: root.rootPath, localRoot: root.localRoot, source: root.source, error: root.error } : null
      }
    };
  }

  // 保存时没填路径（或新增时没填表名 / 备注）：按云端表自动补全
  async function fillFromCloud(ctx, entry, isAdd) {
    if (!entry || typeof entry !== 'object') return entry;
    const id = filelistEditor.parseSpreadsheetId(entry.spreadsheetId) || String(entry.spreadsheetId || '').trim();
    const needPath = !String(entry.path || '').trim();
    const needMeta = isAdd && (!String(entry.name || '').trim() || entry.description == null || entry.description === '');
    if (!id || (!needPath && !needMeta) || !hasToken) return { ...entry, spreadsheetId: id };
    const { entries } = filelistEditor.readFilelistRaw(ctx.cfg.filelistPath);
    const { suggestion } = await suggestForSheet(ctx, id, entries);
    return {
      ...entry,
      spreadsheetId: id,
      path: needPath ? suggestion.path : entry.path,
      name: String(entry.name || '').trim() || suggestion.name,
      description: entry.description || (isAdd ? suggestion.description : entry.description)
    };
  }

  // 新增 / 修改后条目还没有云端位置时补查并写回；查询失败不影响保存
  async function withCloudLocation(ctx, entry) {
    if (!hasToken || !entry.spreadsheetId || (typeof entry.cloudDir === 'string' && entry.cloudFile)) return entry;
    try {
      const locs = await tree().locateMany([entry.spreadsheetId]);
      filelistEditor.setCloudLocations(ctx.cfg.filelistPath, locs);
      const { entries } = filelistEditor.readFilelistRaw(ctx.cfg.filelistPath);
      return entries.find(e => e.path === entry.path) || entry;
    } catch (_) {
      return entry;
    }
  }

  // 新增 / 修改后只补查这一个表的云端修改时间，避免整表刷新
  async function refreshOneInCache(ctx, spreadsheetId) {
    if (!hasToken || !spreadsheetId) return;
    try {
      const m = await getModifiedTimes([spreadsheetId], oauth2Client);
      driveCaches.get(ctx.id).set(spreadsheetId, m.get(spreadsheetId));
    } catch (_) { /* 下次刷新时再查 */ }
  }

  projectRouter.get('/filelist', async (req, res) => {
    const { cfg, project } = req.ctx;
    try {
      const { entries } = filelistEditor.readFilelistRaw(cfg.filelistPath);
      const baseDir = path.dirname(cfg.filelistPath);
      // 与主列表用同一套状态判定；打开清单只读，查询结果和补出的同步基准仅供本次显示。
      const syncByPath = new Map();
      if (hasToken) {
        try {
          const driveMap = loadDiskDriveCache(req.ctx) ? driveCaches.get(req.ctx.id) :
            await getModifiedTimes(entries.map(e => e.spreadsheetId), oauth2Client);
          for (const t of tablesOf(req.ctx, { driveMap, persistState: false })) syncByPath.set(t.path, t);
        } catch (_) { /* 查不到云端时只是不显示同步按钮 */ }
      }
      const rows = entries.map(e => {
        let local = null;
        try {
          const st = fs.statSync(path.resolve(baseDir, String(e.path || '')));
          local = { size: st.size, mtime: st.mtime.toISOString() };
        } catch (_) { /* 本地还没有这个文件 */ }
        const t = syncByPath.get(e.path);
        const sync = t ? {
          status: t.status,
          cloudModifiedTime: t.cloudModifiedTime,
          cloudModifiedBy: t.cloudModifiedBy,
          localVersion: t.localVersion,
          direction: t.direction // 与主列表同一个判定结果
        } : null;
        return { ...e, local, sync };
      });
      const relBase = path.relative(project.dir, baseDir);
      const scanRoot = localTables.scanRootOf(entries, cfg.cloudRoot && cfg.cloudRoot.local);
      res.json({
        // 本地表：本地目录下存在但还没加入清单的 xlsx
        local: { root: scanRoot, tables: localTables.scanLocalTables(baseDir, scanRoot, entries) },
        filelist: path.relative(project.dir, cfg.filelistPath) || path.basename(cfg.filelistPath),
        // 条目路径相对的目录，用于界面展示，如 Configs/Input/
        baseLabel: `${[path.basename(project.dir), relBase].filter(Boolean).join('/')}/`,
        entries: rows,
        dirs: filelistEditor.listDirs(entries),
        defaultDir: filelistEditor.mostCommonDir(entries)
      });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  // 粘贴 Google 表格链接 / ID → 查询云端表名，给出推荐的表名、路径，并提示是否已在清单中
  projectRouter.post('/filelist/resolve', async (req, res) => {
    const input = req.body && req.body.input;
    const spreadsheetId = filelistEditor.parseSpreadsheetId(input);
    if (!spreadsheetId) return res.status(400).json({ error: '无法从输入中识别出 Google 表格 ID，请粘贴形如 https://docs.google.com/spreadsheets/d/xxxx/edit 的链接' });
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    try {
      const { entries } = filelistEditor.readFilelistRaw(req.ctx.cfg.filelistPath);
      const { info, suggestion, location } = await suggestForSheet(req.ctx, spreadsheetId, entries);
      res.json({
        spreadsheetId,
        cloud: info,
        suggestion,
        location,
        existing: entries.filter(e => String(e.spreadsheetId || '').trim() === spreadsheetId).map(e => ({ path: e.path, name: e.name }))
      });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  projectRouter.post('/filelist', async (req, res) => {
    const body = req.body || {};
    try {
      const input = await fillFromCloud(req.ctx, body.entry, true);
      let entry = filelistEditor.addEntry(req.ctx.cfg.filelistPath, input, { allowDuplicateId: !!body.allowDuplicateId });
      entry = await withCloudLocation(req.ctx, entry);
      await refreshOneInCache(req.ctx, entry.spreadsheetId);
      res.json({ entry });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  projectRouter.put('/filelist', async (req, res) => {
    const body = req.body || {};
    if (!body.originalPath) return res.status(400).json({ error: 'originalPath 不能为空' });
    try {
      const input = await fillFromCloud(req.ctx, body.entry, false);
      let entry = filelistEditor.updateEntry(req.ctx.cfg.filelistPath, body.originalPath, input, { allowDuplicateId: !!body.allowDuplicateId });
      entry = await withCloudLocation(req.ctx, entry);
      await refreshOneInCache(req.ctx, entry.spreadsheetId);
      res.json({ entry });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  // 本地表上传：在云端对应目录新建 Google 表格（缺的文件夹自动创建），加入清单并记为已同步。
  // onExisting：云端同目录已有同名表时 'ask'（默认，返回 409）/ 'link'（直接关联已有表，不上传）/ 'create'（仍新建）
  projectRouter.post('/filelist/upload-local', async (req, res) => {
    const { cfg, id } = req.ctx;
    const body = req.body || {};
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    if (!oauth.hasUploadScope(oauth.loadToken(TOKEN_PATH))) return res.status(403).json({ error: 'NEED_UPLOAD_SCOPE' });
    try {
      const { entries } = filelistEditor.readFilelistRaw(cfg.filelistPath);
      const baseDir = path.dirname(cfg.filelistPath);
      const localPath = String(body.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
      const abs = path.resolve(baseDir, localPath);
      if (!localPath || !abs.startsWith(baseDir + path.sep) || !/\.xlsx$/i.test(localPath)) {
        return res.status(400).json({ error: `无效的本地表路径：${localPath}` });
      }
      if (entries.some(e => String(e.path || '').toLowerCase() === localPath.toLowerCase())) {
        return res.status(409).json({ error: `已在清单中：${localPath}`, code: 'DUPLICATE_PATH' });
      }
      let buf;
      try { buf = fs.readFileSync(abs); } catch (_) { return res.status(404).json({ error: `本地文件不存在：${localPath}` }); }
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return res.status(400).json({ error: '本地文件不是有效的 xlsx' });

      const root = await projectRoot(req.ctx, entries);
      if (!root || root.error) {
        return res.status(400).json({ error: root && root.error ? root.error : '还没有云端目录映射：请先在清单顶部「设置映射」指定云端根目录', code: 'NO_ROOT' });
      }
      const subDirs = localTables.subDirsUnder(localPath, root.localRoot);
      if (!subDirs) return res.status(400).json({ error: `该文件不在映射的本地目录 ${root.localRoot}/ 下，无法对应云端目录`, code: 'OUTSIDE_ROOT' });

      const baseName = path.basename(localPath).replace(/\.xlsx$/i, '');
      const cloudName = String(body.cloudName || '').trim() || baseName;
      const cloudDir = [root.rootPath, ...subDirs].join(' / ');
      const onExisting = ['link', 'create'].includes(body.onExisting) ? body.onExisting : 'ask';

      // 先只查不建：目录都存在时才检查同名表，避免确认前就在云端建出空目录
      const probe = await resolveFolderPath(root.rootId, subDirs, oauth2Client, { create: false });
      const existing = probe.folderId ? await findSheetInFolder(probe.folderId, cloudName, oauth2Client) : null;
      if (existing && onExisting === 'ask') {
        return res.status(409).json({
          error: `云端目录 ${cloudDir} 下已有同名表「${existing.name}」`,
          code: 'CLOUD_EXISTS',
          existing: { id: existing.id, name: existing.name, link: existing.webViewLink, modifiedTime: existing.modifiedTime }
        });
      }

      let cloud;
      let createdFolders = [];
      let linked = false;
      if (existing && onExisting === 'link') {
        cloud = existing;
        linked = true;
      } else {
        const folder = probe.folderId ? probe : await resolveFolderPath(root.rootId, subDirs, oauth2Client, { create: true });
        createdFolders = folder.created;
        cloud = await createSheetFromXlsx(folder.folderId, cloudName, buf, oauth2Client);
      }

      const entry = filelistEditor.addEntry(cfg.filelistPath, {
        path: localPath,
        spreadsheetId: cloud.id,
        name: String(body.name || '').trim() || baseName,
        description: body.description != null && String(body.description).trim() !== '' ? String(body.description).trim() : cloudName
      }, {
        allowDuplicateId: true,
        extra: filelistEditor.cloudFields({ dirs: [...String(root.rootPath).split(' / '), ...subDirs], name: cloud.name })
      });

      // 新建的云端表内容就是本地文件，记为已同步；关联已有表时内容可能不同，不记状态，让列表按实际情况显示
      const markSynced = modifiedTime => {
        const st = fs.statSync(abs);
        updateEntry(cfg.statePath, entry.path, {
          lastSyncedModifiedTime: modifiedTime,
          lastSyncedSize: st.size,
          lastSyncedMtime: st.mtime.toISOString(),
          lastSyncedHash: hashFile(abs)
        });
        if (cfg.sidecarPath) updateSidecar(cfg.sidecarPath, entry.path, modifiedTime);
        driveCaches.get(id).set(cloud.id, { modifiedTime, name: cloud.name, error: null });
      };
      if (linked) driveCaches.get(id).set(cloud.id, { modifiedTime: cloud.modifiedTime, name: cloud.name, error: null });
      else {
        markSynced(cloud.modifiedTime);
        // Drive 把 xlsx 转成表格后约 1 秒还会再改一次修改时间；后台等它稳定后再记一次，避免刚上传就显示「有更新」
        settleModifiedTime(cloud.id, cloud.modifiedTime).then(t => { if (t !== cloud.modifiedTime) markSynced(t); }).catch(() => {});
      }
      await logHistory(req.ctx, { op: linked ? 'link' : 'create', path: entry.path, name: entry.name, ok: true, cloudModifiedTime: cloud.modifiedTime, cloudDir });
      res.json({ entry, cloud, cloudDir, createdFolders, linked });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  async function settleModifiedTime(fileId, initial) {
    let prev = initial;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const info = (await getModifiedTimes([fileId], oauth2Client)).get(fileId);
      if (!info || !info.modifiedTime) return prev;
      if (info.modifiedTime === prev) return prev;
      prev = info.modifiedTime;
    }
    return prev;
  }

  function cloudPathScope(ctx) {
    if (!ctx) return null;
    return JSON.stringify([ctx.project.dir, ctx.cfg.filelistPath, ctx.cfg.cloudRoot, authEpoch]);
  }

  function staleCloudPreview() {
    return Object.assign(new Error('项目、目录映射或预览已变化，请重新查询云端路径'), { code: 'STALE_PREVIEW' });
  }

  // 只查询已关联的表，逐行展示旧位置与新位置。应用只接受本项目服务端保留的预览。
  projectRouter.post('/filelist/cloud-paths', async (req, res) => {
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    const { ctx } = req;
    let preview;
    try {
      const { entries, raw } = filelistEditor.readFilelistRaw(ctx.cfg.filelistPath);
      preview = { id: randomUUID(), scope: cloudPathScope(ctx), raw };
      cloudPathPreviews.set(ctx.id, preview);
      const ids = [...new Set(entries.map(e => String(e.spreadsheetId || '').trim()).filter(Boolean))];
      // 此次查询也要识别父文件夹改名或移动，因此使用本次查询独有的文件夹缓存。
      const locs = ids.length ? await driveTree.createTreeClient(oauth2Client).locateMany(ids) : {};
      if (cloudPathPreviews.get(ctx.id) !== preview || cloudPathScope(getCtx(ctx.id)) !== preview.scope) {
        throw staleCloudPreview();
      }
      filelistEditor.readFilelistRaw(ctx.cfg.filelistPath, raw);
      const changes = [];
      const failures = [];
      const usable = {};
      for (const e of entries) {
        const id = String(e.spreadsheetId || '').trim();
        if (!id) continue;
        const loc = Object.hasOwn(locs, id) ? locs[id] : null;
        const row = { path: e.path, name: e.name };
        if (loc?.error || !filelistEditor.cloudFields(loc)) {
          failures.push({ ...row, error: loc?.error || '无法取得云端位置' });
          continue;
        }
        const after = filelistEditor.cloudLocationChange(e, loc);
        if (!after) continue;
        usable[id] = loc;
        const before = { cloudDir: e.cloudDir ?? null, cloudFile: e.cloudFile ?? null };
        changes.push({ ...row, before, after });
      }
      if (changes.length) preview.locs = usable;
      else cloudPathPreviews.delete(ctx.id);
      res.json({ previewId: changes.length ? preview.id : null, queried: ids.length, changes, failures });
    } catch (err) {
      if (cloudPathPreviews.get(ctx.id) === preview) cloudPathPreviews.delete(ctx.id);
      sendEditorError(res, err);
    }
  });

  projectRouter.post('/filelist/cloud-paths/apply', (req, res) => {
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    const { ctx } = req;
    const preview = cloudPathPreviews.get(ctx.id);
    try {
      if (!preview?.locs || preview.id !== req.body?.previewId || preview.scope !== cloudPathScope(ctx)) {
        throw staleCloudPreview();
      }
      cloudPathPreviews.delete(ctx.id);
      const updated = filelistEditor.setCloudLocations(ctx.cfg.filelistPath, preview.locs, preview.raw);
      res.json({ updated });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  // 在访达中定位本地文件 / 打开目录。body: { path: 相对 filelist 所在目录的路径 }，空则打开该目录本身；
  // 文件不存在时打开最近的存在的上级目录。只允许打开 filelist 所在目录之内的路径
  projectRouter.post('/reveal', async (req, res) => {
    const baseDir = path.dirname(req.ctx.cfg.filelistPath);
    const rel = String((req.body && req.body.path) || '').replace(/\\/g, '/');
    const target = path.resolve(baseDir, rel || '.');
    if (!reveal.insideBase(baseDir, target)) return res.status(400).json({ error: '只能打开配置表目录之内的路径' });
    try {
      const shown = reveal.nearestExisting(target);
      await revealImpl(target);
      res.json({ ok: true, shown, exact: shown === target });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 云端根目录映射：查看（未配置时返回自动推断结果）
  projectRouter.get('/filelist/cloud-root', async (req, res) => {
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    try {
      const { entries } = filelistEditor.readFilelistRaw(req.ctx.cfg.filelistPath);
      res.json({ root: await projectRoot(req.ctx, entries), configured: req.ctx.cfg.cloudRoot });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  // 设置 / 清除映射：写入项目的 syncmanager.config.json（cloudRoot 字段）
  function writeCloudRoot(ctx, value) {
    const configPath = ctx.cfg.configPath;
    const rawText = fs.readFileSync(configPath, 'utf8');
    const raw = JSON.parse(rawText);
    if (value) raw.cloudRoot = value; else delete raw.cloudRoot;
    filelistEditor.writeFilelistRaw(configPath, raw, filelistEditor.detectFormat(rawText));
    rootResolver.invalidate(ctx.id);
  }

  projectRouter.put('/filelist/cloud-root', async (req, res) => {
    const body = req.body || {};
    const folderId = filelistEditor.parseSpreadsheetId(body.folder);
    if (!folderId) return res.status(400).json({ error: '请粘贴 Google Drive 文件夹链接（https://drive.google.com/drive/folders/…）或文件夹 ID' });
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    const local = String(body.local == null ? '' : body.local).trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (local && (local.startsWith('/') || local.split('/').includes('..'))) {
      return res.status(400).json({ error: '本地目录必须是相对 filelist.json 所在目录的相对路径' });
    }
    try {
      const meta = await tree().getMeta(folderId);
      if (!meta) return res.status(404).json({ error: '找不到这个文件夹，或当前 Google 账号没有访问权限' });
      if (meta.mimeType !== 'application/vnd.google-apps.folder') return res.status(400).json({ error: `这不是文件夹（${meta.name}）` });
      writeCloudRoot(req.ctx, { folderId, local });
      const ctx = getCtx(req.ctx.id);
      const { entries } = filelistEditor.readFilelistRaw(ctx.cfg.filelistPath);
      res.json({ root: await projectRoot(ctx, entries), configured: ctx.cfg.cloudRoot });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  projectRouter.delete('/filelist/cloud-root', async (req, res) => {
    try {
      writeCloudRoot(req.ctx, null);
      res.json({ ok: true });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  // 只从清单移除，不删除本地 xlsx
  projectRouter.delete('/filelist', (req, res) => {
    try {
      res.json({ removed: filelistEditor.removeEntry(req.ctx.cfg.filelistPath, req.query.path) });
    } catch (err) {
      sendEditorError(res, err);
    }
  });

  projectRouter.post('/clear-state', (req, res) => {
    try {
      saveState(req.ctx.cfg.statePath, {});
      clearVerifyCache(req.ctx.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 执行配置里的自定义动作（如 Luban 导出），日志经 SSE 实时回传
  projectRouter.post('/action/:id', async (req, res) => {
    const action = req.ctx.cfg.actions.find(a => a.id === req.params.id);
    if (!action) return res.status(404).json({ error: `unknown action: ${req.params.id}` });
    sseSetup(res);
    const startedAt = Date.now();
    try {
      const code = await runSteps({ steps: action.steps, onLog: line => sseEmit(res, 'log', line) });
      await logHistory(req.ctx, { op: 'action', action: action.id, name: action.label, ok: code === 0, exitCode: code, durationMs: Date.now() - startedAt });
      sseEmit(res, 'done', { exitCode: code });
    } catch (err) {
      await logHistory(req.ctx, { op: 'action', action: action.id, name: action.label, ok: false, error: err.message });
      sseEmit(res, 'error', { message: err.message });
      sseEmit(res, 'done', { exitCode: -1 });
    }
    res.end();
  });

  // ---------- 差异预览：本地 xlsx 与云端表逐单元格比较 ----------
  projectRouter.get('/diff', async (req, res) => {
    const { cfg } = req.ctx;
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    const entry = loadFilelist(cfg.filelistPath).find(e => e.path === req.query.path);
    if (!entry) return res.status(404).json({ error: `unknown path: ${req.query.path}` });
    if (!entry.spreadsheetId) return res.status(400).json({ error: '该表没有 spreadsheetId' });
    if (typeof req.query.record === 'string') {
      const snapshot = diffSnapshots.get(req.query.snapshot);
      if (!snapshot || snapshot.id !== req.ctx.id || snapshot.path !== entry.path) {
        return res.status(410).json({ error: '差异预览已过期，请重新打开后再查找' });
      }
      return res.json({ sheets: findRecords(snapshot.local, snapshot.cloud, req.query.record, snapshot.keys) });
    }

    const force = req.query.force === '1';
    const epoch = authEpoch;

    let localStat = null;
    let localWb = [];
    let localErr = null;
    const readLocal = () => {
      try {
        localStat = fs.statSync(entry.savePath);
        const lKey = localMemoryKey(entry.savePath, localStat);
        localWb = getMemoryWorkbook(lKey);
        if (!localWb) {
          localWb = readWorkbook(entry.savePath);
          setMemoryWorkbook(lKey, localWb);
        }
      } catch (err) {
        if (localStat) localErr = err;
      }
    };

    // 快速路径：若 driveCaches 中有该表信息，且对应版本的云端导出已在缓存中，直接免调网络接口
    loadDiskDriveCache(req.ctx);
    const cachedDriveInfo = !force && driveCaches.get(req.ctx.id)?.get(entry.spreadsheetId);
    let info = null;
    let cloudWb = null;

    if (cachedDriveInfo?.modifiedTime) {
      const memKey = cloudMemoryKey(entry.spreadsheetId, cachedDriveInfo.modifiedTime);
      cloudWb = getMemoryWorkbook(memKey);
      if (!cloudWb) {
        const cachedPath = getCachedExportPath(exportCacheDir, entry.spreadsheetId, cachedDriveInfo.modifiedTime);
        if (cachedPath) {
          cloudWb = readWorkbook(cachedPath);
          setMemoryWorkbook(memKey, cloudWb);
        }
      }
      if (cloudWb) {
        info = cachedDriveInfo;
      }
    }

    try {
      if (!cloudWb) {
        // 并行拉取云端元数据与本地文件解析
        const [infoResult] = await Promise.all([
          getCloudInfo(entry.spreadsheetId, oauth2Client),
          Promise.resolve().then(readLocal).catch(() => {})
        ]);
        info = infoResult;
        if (epoch !== authEpoch) return res.status(409).json({ error: 'Google 账号已变更，请重新打开差异预览' });
        if (!info || !info.modifiedTime) {
          return res.status(502).json({ error: '无法取得云端表格信息，请检查网络或授权' });
        }
        driveCaches.get(req.ctx.id).set(entry.spreadsheetId, info);

        const memKey = cloudMemoryKey(entry.spreadsheetId, info.modifiedTime);
        if (!force) {
          cloudWb = getMemoryWorkbook(memKey);
          if (!cloudWb) {
            const cachedPath = getCachedExportPath(exportCacheDir, entry.spreadsheetId, info.modifiedTime);
            if (cachedPath) {
              cloudWb = readWorkbook(cachedPath);
              setMemoryWorkbook(memKey, cloudWb);
            }
          }
        }

        if (!cloudWb) cloudWb = await fetchCloudWorkbook(entry.spreadsheetId, info.modifiedTime, `diff-${req.ctx.id}`);
      } else {
        readLocal();
      }

      if (localErr) return res.status(422).json({ error: `本地文件无法解析：${localErr.message}` });
      if (!cloudWb) return res.status(500).json({ error: '云端表格导出失败' });

      const snapshot = randomUUID();
      diffSnapshots.set(snapshot, { id: req.ctx.id, path: entry.path, local: localWb, cloud: cloudWb, keys: entry.diffKeys });
      if (diffSnapshots.size > 2) diffSnapshots.delete(diffSnapshots.keys().next().value);
      res.json({
        snapshot,
        path: entry.path,
        name: entry.name,
        downloadVersion: {
          spreadsheetId: entry.spreadsheetId,
          cloudModifiedTime: info.modifiedTime,
          localVersion: localStat ? fileVersion(localStat) : null,
          reviewed: true
        },
        local: localStat ? { exists: true, size: localStat.size, mtime: localStat.mtime.toISOString() } : { exists: false },
        cloud: { spreadsheetId: entry.spreadsheetId, modifiedTime: info.modifiedTime, modifiedBy: info.modifiedBy, name: info.name },
        diff: diffWorkbooks(localWb, cloudWb, { keys: entry.diffKeys })
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 内容核对：修改时间 / 文件字节变了，但内容可能没变 ----------
  // 云端：有人打开又关闭、改了格式 / 批注等；本地：Excel 打开后重新保存、git 操作改写文件等（字节指纹变了，单元格没变）。
  // 对「有更新 / 冲突 / 本地变更」的表导出云端、与本地逐单元格比较；值完全一致就记为已同步（等同于下载了一份相同的内容），
  // 不再出现在对应分组里。不一致的结果按「路径 + 云端时间 + 本地指纹」缓存，同一版本不重复导出。
  // 同一时刻最多核对几张表（跨请求共享）：前端逐表并发请求，这里兜底防止一次打出太多导出请求
  const VERIFY_CONCURRENCY = 6;
  let verifyActive = 0;
  const verifyWaiters = [];
  async function withVerifySlot(fn) {
    if (verifyActive >= VERIFY_CONCURRENCY) await new Promise(resolve => verifyWaiters.push(resolve));
    verifyActive++;
    try { return await fn(); } finally {
      verifyActive--;
      const next = verifyWaiters.shift();
      if (next) next();
    }
  }

  // 导出云端某个版本并解析（不读缓存），同时落盘缓存供下载复用。同一版本并发请求只导出一次。
  // 注：不改用 Sheets API 直接取值——公式单元格经 xlsx 导出只保留 10 位有效数字，直接取值是完整精度，
  // 而本地文件通常就是导出下载的，两边会对不上，导致内容一致的表被误判为有差异；实测速度也没有明显优势。
  function fetchCloudWorkbook(spreadsheetId, modifiedTime, tag) {
    const memKey = cloudMemoryKey(spreadsheetId, modifiedTime);
    return singleFlightExport(`wb:${memKey}`, async () => {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const tmp = path.join(TMP_DIR, `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`);
      try {
        await downloadViaDrive(spreadsheetId, tmp, oauth2Client);
        saveExportToCache(exportCacheDir, spreadsheetId, modifiedTime, tmp);
        const wb = readWorkbook(tmp);
        setMemoryWorkbook(memKey, wb);
        return wb;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  }

  async function verifyTable(ctx, row, entry, { force = false } = {}) {
    const cache = verifyCacheOf(ctx.id);
    const epoch = authEpoch;
    const localHash = hashFile(entry.savePath);
    const key = verifyKey(entry, row, localHash);
    if (!force && cache[entry.path]?.key === key) return { path: entry.path, identical: false, cached: true };
    const cKey = cloudMemoryKey(entry.spreadsheetId, row.cloudModifiedTime);
    let cloud = getMemoryWorkbook(cKey);
    if (!cloud && !force) {
      const cachedExport = getCachedExportPath(exportCacheDir, entry.spreadsheetId, row.cloudModifiedTime);
      if (cachedExport) {
        cloud = readWorkbook(cachedExport);
        setMemoryWorkbook(cKey, cloud);
      }
    }
    if (!cloud) cloud = await fetchCloudWorkbook(entry.spreadsheetId, row.cloudModifiedTime, `verify-${ctx.id}`);
    const localStat = fs.statSync(entry.savePath);
    const lKey = localMemoryKey(entry.savePath, localStat);
    let local = getMemoryWorkbook(lKey);
    if (!local) {
      local = readWorkbook(entry.savePath);
      setMemoryWorkbook(lKey, local);
    }
    const diff = diffWorkbooks(local, cloud, { keys: entry.diffKeys, maxChanges: 0, view: false });
    // 核对期间本地被改过时，等下次刷新重新比较。
    if (epoch !== authEpoch || verifyCacheOf(ctx.id) !== cache || hashFile(entry.savePath) !== localHash) {
      return { path: entry.path, identical: false, changed: true };
    }
    if (!diff.identical) {
      cache[entry.path] = { key, checkedAt: new Date().toISOString(), summary: summarizeDiff(diff) };
      writeJson(verifyCachePathOf(ctx.id), cache);
      return { path: entry.path, identical: false };
    }
    const stat = fs.statSync(entry.savePath);
    updateEntry(ctx.cfg.statePath, entry.path, {
      lastSyncedModifiedTime: row.cloudModifiedTime,
      lastSyncedSize: stat.size,
      lastSyncedMtime: stat.mtime.toISOString(),
      lastSyncedHash: localHash
    });
    delete cache[entry.path];
    writeJson(verifyCachePathOf(ctx.id), cache);
    await logHistory(ctx, { op: 'verify', path: entry.path, name: entry.name, ok: true, cloudModifiedTime: row.cloudModifiedTime, cloudModifiedBy: row.cloudModifiedBy || null, previousStatus: row.status });
    return { path: entry.path, identical: true, previousStatus: row.status };
  }

  projectRouter.post('/verify', async (req, res) => {
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    const ctx = req.ctx;
    const force = !!(req.body && req.body.force);
    const want = Array.isArray(req.body && req.body.paths) ? new Set(req.body.paths) : null;
    try {
      const byPath = new Map(loadFilelist(ctx.cfg.filelistPath).map(e => [e.path, e]));
      const rows = tablesOf(ctx).filter(r => verifyStatuses.has(r.status) && r.cloudModifiedTime && (!want || want.has(r.path)) && byPath.has(r.path));
      const results = [];
      const queue = [...rows];
      async function worker() {
        while (queue.length) {
          const row = queue.shift();
          try { results.push(await withVerifySlot(() => verifyTable(ctx, row, byPath.get(row.path), { force }))); }
          catch (err) { results.push({ path: row.path, identical: false, error: err.message }); }
        }
      }
      await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, worker));
      res.json({ results, tables: tablesOf(ctx) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 本地备份 ----------
  function entryOf(ctx, p) {
    const entry = loadFilelist(ctx.cfg.filelistPath).find(e => e.path === p);
    if (!entry) { const e = new Error(`unknown path: ${p}`); e.status = 404; throw e; }
    return entry;
  }

  projectRouter.get('/backups', (req, res) => {
    try {
      const entry = entryOf(req.ctx, req.query.path);
      res.json({ path: entry.path, backups: backups.listBackups(backupRootOf(req.ctx.id), entry.path) });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  projectRouter.post('/backups/restore', async (req, res) => {
    const body = req.body || {};
    try {
      const entry = entryOf(req.ctx, body.path);
      const result = backups.restoreBackup(backupRootOf(req.ctx.id), entry.path, body.id, entry.savePath);
      await logHistory(req.ctx, { op: 'restore', path: entry.path, name: entry.name, ok: true, backup: body.id, backupBefore: result.backupBefore && result.backupBefore.id });
      res.json(result);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  projectRouter.post('/backups/reveal', async (req, res) => {
    const body = req.body || {};
    try {
      const entry = entryOf(req.ctx, body.path);
      await revealImpl(backups.backupPath(backupRootOf(req.ctx.id), entry.path, body.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // ---------- 操作历史 ----------
  projectRouter.get('/history', (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    res.json(readHistory(historyPathOf(req.ctx.id), { limit, path: req.query.path || undefined }));
  });

  app.use('/api/p/:pid', projectRouter);
  // max-age=0：每次都向服务端校验，App 升级后不会用到浏览器里缓存的旧前端文件
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));

  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(listenPort, '127.0.0.1', () => resolve(srv));
    srv.once('error', reject);
  });
  const port = server.address().port;
  const url = `http://localhost:${port}/`;
  console.log(`[csm] listening on ${url}`);
  console.log(`[csm] data dir: ${DATA_DIR}`);
  if (!hasToken) {
    console.log(`[csm] no OAuth token; visit ${url}auth/start to authorize`);
  }
  if (openBrowser) {
    try {
      await open(hasToken ? url : `${url}auth/start`);
    } catch (_err) { /* ignore */ }
  }
  return { port, url, hasToken, server };
}

if (require.main === module) {
  main().catch(err => {
    console.error('[csm] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
