'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const open = require('open');
const { findAvailablePort } = require('./lib/port-scanner');
const oauth = require('./lib/oauth');
const { loadFilelist } = require('./lib/filelist-loader');
const { loadState, saveState, updateEntry } = require('./lib/sync-state');
const { getModifiedTimes, uploadXlsxToSheet, downloadViaDrive, getFileInfo, resolveFolderPath, findSheetInFolder, createSheetFromXlsx } = require('./lib/drive-api');
const localTables = require('./lib/local-tables');
const { suggestDirection } = require('./lib/status');
const filelistEditor = require('./lib/filelist-editor');
const driveTree = require('./lib/drive-tree');
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
  const CREDENTIALS_PATH = opts.credentialsPath || path.join(ROOT, 'credentials.json');
  const openBrowser = opts.openBrowser !== undefined ? opts.openBrowser : !(process.env.CSM_NO_OPEN || process.env.SYNC_MANAGER_NO_OPEN);
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
      // 云端内容已与本地一致：记为已同步（并等 Drive 转换后修改时间稳定再记一次），避免上传后显示「有更新」
      const markSynced = modifiedTime => {
        const st = fs.statSync(entry.savePath);
        updateEntry(cfg.statePath, entry.path, { lastSyncedModifiedTime: modifiedTime, lastSyncedSize: st.size, lastSyncedMtime: st.mtime.toISOString() });
        if (cfg.sidecarPath) updateSidecar(cfg.sidecarPath, entry.path, modifiedTime);
        driveCaches.get(id).set(entry.spreadsheetId, { modifiedTime, name: info.name, error: null });
      };
      markSynced(info.modifiedTime);
      settleModifiedTime(entry.spreadsheetId, info.modifiedTime).then(t => { if (t !== info.modifiedTime) markSynced(t); }).catch(() => {});
      res.json({ ok: true, modifiedTime: info.modifiedTime, size: buf.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 配置表清单（filelist.json）预览与编辑 ----------
  const editorStatus = err => ({ INVALID: 400, INVALID_JSON: 500, NOT_FOUND: 404, DUPLICATE_PATH: 409, DUPLICATE_ID: 409 }[err.code] || 500);
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
    if (!hasToken || !entry.spreadsheetId || (entry.cloudDir && entry.cloudFile)) return entry;
    try {
      await persistCloudLocations(ctx, [entry.spreadsheetId]);
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
      // 同步状态（与主列表同一套判定）；云端修改时间缓存为空时先查一次
      const syncByPath = new Map();
      if (hasToken) {
        try {
          if (driveCaches.get(req.ctx.id).size === 0) await refreshDriveCache(req.ctx);
          for (const t of tablesOf(req.ctx)) syncByPath.set(t.path, t);
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
          direction: suggestDirection({ status: t.status, cloudModifiedTime: t.cloudModifiedTime, localMtime: local && local.mtime })
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
          lastSyncedMtime: st.mtime.toISOString()
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

  // 查询云端位置并写回 filelist.json（cloudDir / cloudFile），之后打开清单直接读取，不再重复查询
  async function persistCloudLocations(ctx, ids) {
    const locs = await tree().locateMany(ids);
    const ok = {};
    const failed = {};
    for (const [id, loc] of Object.entries(locs)) {
      if (loc.error) failed[id] = loc.error; else ok[id] = loc;
    }
    const updated = Object.keys(ok).length ? filelistEditor.setCloudLocations(ctx.cfg.filelistPath, ok) : 0;
    return { updated, failed, queried: Object.keys(locs).length };
  }

  // body: { all: true } 全部重新查询（云端文件移动 / 改名后用）；否则只查还没有云端位置的条目
  projectRouter.post('/filelist/cloud-paths', async (req, res) => {
    if (!hasToken) return res.status(401).json({ error: 'OAUTH_REQUIRED' });
    try {
      const { entries } = filelistEditor.readFilelistRaw(req.ctx.cfg.filelistPath);
      const all = !!(req.body && req.body.all);
      const ids = entries
        .filter(e => String(e.spreadsheetId || '').trim() && (all || !e.cloudDir || !e.cloudFile))
        .map(e => String(e.spreadsheetId).trim());
      res.json(ids.length ? await persistCloudLocations(req.ctx, ids) : { updated: 0, failed: {}, queried: 0 });
    } catch (err) {
      sendEditorError(res, err);
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
  // max-age=0：每次都向服务端校验，App 升级后不会用到浏览器里缓存的旧前端文件
  app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));

  const url = `http://localhost:${port}/`;
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
    srv.once('error', reject);
  });
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
