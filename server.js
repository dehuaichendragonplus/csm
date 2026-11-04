'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const open = require('open');
const { findAvailablePort } = require('./lib/port-scanner');
const oauth = require('./lib/oauth');
const { loadFilelist } = require('./lib/filelist-loader');
const { loadState, saveState, updateEntry } = require('./lib/sync-state');
const { getModifiedTimes, uploadXlsxToSheet, downloadViaDrive } = require('./lib/drive-api');
const { aggregateTables } = require('./lib/table-aggregator');
const { downloadOne } = require('./lib/downloader');
const { CONFIG_FILENAME, loadConfig, publicConfig } = require('./lib/config');
const { loadProjects, addProject, removeProject, renameProject, findProject } = require('./lib/projects');
const { listDirs } = require('./lib/fs-browser');
const { pickFolder } = require('./lib/native-picker');
const { sseSetup, sseEmit } = require('./lib/sse');
const { runSteps } = require('./lib/gen-client-runner');
const { loadSidecar, updateSidecar } = require('./lib/version-sidecar');

const ROOT = __dirname;
const DEFAULT_PORT = 7321;

// 平台数据目录：项目注册表、Google 令牌、各项目的同步状态都在这里，与被管理的项目仓库互不污染
function defaultDataDir() {
  return process.env.SYNC_MANAGER_DATA ? path.resolve(process.env.SYNC_MANAGER_DATA) : path.join(ROOT, 'data');
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
  const CREDENTIALS_PATH = opts.credentialsPath || path.join(ROOT, 'credentials.json');
  const openBrowser = opts.openBrowser !== undefined ? opts.openBrowser : !process.env.SYNC_MANAGER_NO_OPEN;
  const pickFolderImpl = opts.pickFolder || pickFolder;
  const onAuthorized = opts.onAuthorized || (() => {});

  migrateLegacyToken(TOKEN_PATH);
  const port = await findAvailablePort(DEFAULT_PORT);
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

  let { client: oauth2Client, hasToken } = buildOAuthClient(port, CREDENTIALS_PATH, TOKEN_PATH);
  const driveCaches = new Map(); // projectId -> Map(spreadsheetId -> { modifiedTime, name, error })

  const statePathOf = id => path.join(DATA_DIR, 'projects', id, '.sync_state.json');

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
    driveCaches.set(ctx.id, await getModifiedTimes(ids, oauth2Client));
  }

  // 用入仓的 sidecar 为尚无本地状态的条目补状态：xlsx 来自 git 而非过期下载，应视为已同步
  function bootstrapStateFromSidecar(ctx, filelist) {
    if (!ctx.cfg.sidecarPath) return;
    const sidecar = loadSidecar(ctx.cfg.sidecarPath);
    if (Object.keys(sidecar).length === 0) return;
    const statePath = ctx.cfg.statePath;
    const state = loadState(statePath);
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
        lastSyncedMtime: stat.mtime.toISOString()
      };
      changed = true;
    }
    if (changed) saveState(statePath, state);
  }

  function tablesOf(ctx) {
    const filelist = loadFilelist(ctx.cfg.filelistPath);
    bootstrapStateFromSidecar(ctx, filelist);
    return aggregateTables(filelist, driveCaches.get(ctx.id), loadState(ctx.cfg.statePath));
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
      driveCaches.clear();
      if (opts.authSuccessHtml) res.type('html').send(opts.authSuccessHtml);
      else res.redirect('/');
      onAuthorized();
    } catch (err) {
      res.status(500).send(`oauth error: ${err.message}`);
    }
  });

  app.get('/api/auth-status', (_req, res) => {
    res.json({ authorized: hasToken, canUpload: hasToken && oauth.hasUploadScope(oauth.loadToken(TOKEN_PATH)) });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
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
    res.json({ ok: true });
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
      if (driveCaches.get(req.ctx.id).size === 0) await refreshDriveCache(req.ctx);
      res.json(tablesOf(req.ctx));
    } catch (err) {
      if (err.message === 'OAUTH_REQUIRED') return res.status(401).json({ error: 'OAUTH_REQUIRED' });
      res.status(500).json({ error: err.message });
    }
  });

  projectRouter.post('/refresh', async (req, res) => {
    try {
      await refreshDriveCache(req.ctx);
      res.json(tablesOf(req.ctx));
    } catch (err) {
      if (err.message === 'OAUTH_REQUIRED') return res.status(401).json({ error: 'OAUTH_REQUIRED' });
      res.status(500).json({ error: err.message });
    }
  });

  projectRouter.post('/sync', async (req, res) => {
    const { cfg, id } = req.ctx;
    const { paths } = req.body || {};
    if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be an array' });
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });

    sseSetup(res);

    const byPath = new Map(loadFilelist(cfg.filelistPath).map(e => [e.path, e]));
    let successCount = 0;
    let failedCount = 0;

    for (const p of paths) {
      const entry = byPath.get(p);
      if (!entry) {
        sseEmit(res, 'log', `! unknown path: ${p}\n`);
        failedCount++;
        continue;
      }
      if (entry.incomplete) {
        sseEmit(res, 'log', `! skipped (incomplete): ${p} - ${entry.incompleteReason}\n`);
        failedCount++;
        continue;
      }
      sseEmit(res, 'table-start', { path: entry.path });
      sseEmit(res, 'log', `→ downloading ${entry.name} (${p})\n`);
      try {
        if (cfg.exportUrl) {
          await downloadOne({
            baseUrl: cfg.exportUrl,
            spreadsheetId: entry.spreadsheetId,
            password: cfg.exportPassword,
            savePath: entry.savePath,
            mergeCells: !!entry.mergeCells,
            onProgress: ({ received, total }) => {
              if (total > 0) sseEmit(res, 'progress', { table: entry.name, pct: Math.round(received / total * 100) });
            },
            onRetry: ({ attempt, waitMs, error }) => {
              sseEmit(res, 'log', `  ⟳ retrying (${attempt}/${3}) after ${waitMs / 1000}s… (${error.message})\n`);
            }
          });
        } else {
          await downloadViaDrive(entry.spreadsheetId, entry.savePath, oauth2Client);
        }
        const driveInfo = driveCaches.get(id).get(entry.spreadsheetId);
        const modifiedTime = driveInfo ? driveInfo.modifiedTime : new Date().toISOString();
        const stat = fs.statSync(entry.savePath);
        updateEntry(cfg.statePath, entry.path, {
          lastSyncedModifiedTime: modifiedTime,
          lastSyncedSize: stat.size,
          lastSyncedMtime: stat.mtime.toISOString()
        });
        if (cfg.sidecarPath) updateSidecar(cfg.sidecarPath, entry.path, modifiedTime);
        sseEmit(res, 'table-done', { path: entry.path, success: true });
        successCount++;
      } catch (err) {
        sseEmit(res, 'log', `✗ failed: ${p} — ${err.message}\n`);
        sseEmit(res, 'table-done', { path: entry.path, success: false, error: err.message });
        failedCount++;
      }
    }

    sseEmit(res, 'done', { successCount, failedCount, exitCode: null });
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
    try {
      const info = await uploadXlsxToSheet(entry.spreadsheetId, buf, oauth2Client);
      driveCaches.get(id).set(entry.spreadsheetId, { modifiedTime: info.modifiedTime, name: info.name, error: null });
      res.json({ ok: true, modifiedTime: info.modifiedTime, size: buf.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  projectRouter.post('/clear-state', (req, res) => {
    try {
      saveState(req.ctx.cfg.statePath, {});
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
    try {
      const code = await runSteps({ steps: action.steps, onLog: line => sseEmit(res, 'log', line) });
      sseEmit(res, 'done', { exitCode: code });
    } catch (err) {
      sseEmit(res, 'error', { message: err.message });
      sseEmit(res, 'done', { exitCode: -1 });
    }
    res.end();
  });

  app.use('/api/p/:pid', projectRouter);
  app.use(express.static(path.join(ROOT, 'public')));

  const url = `http://localhost:${port}/`;
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
    srv.once('error', reject);
  });
  console.log(`[sync-manager] listening on ${url}`);
  console.log(`[sync-manager] data dir: ${DATA_DIR}`);
  if (!hasToken) {
    console.log(`[sync-manager] no OAuth token; visit ${url}auth/start to authorize`);
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
    console.error('[sync-manager] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
