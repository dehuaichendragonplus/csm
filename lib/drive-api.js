'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { google } = require('googleapis');

const DEFAULT_CONCURRENCY = 5;

// ---------- 限流 / 临时故障重试 ----------
// Drive 对每个用户有 QPS 限制，表多时并发查询容易遇到 429 或 403 rateLimitExceeded；5xx 也多是临时故障
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError', 'internalError']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);

function errorStatus(err) {
  if (!err) return null;
  const s = err.code != null ? err.code : (err.response && err.response.status);
  const n = Number(s);
  return Number.isInteger(n) ? n : s;
}

function isRetryable(err) {
  const status = errorStatus(err);
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return true;
  if (typeof status === 'string' && NETWORK_CODES.has(status)) return true;
  if (status === 403) {
    const errors = (err.errors || (err.response && err.response.data && err.response.data.error && err.response.data.error.errors)) || [];
    return errors.some(e => RATE_LIMIT_REASONS.has(e && e.reason));
  }
  return false;
}

const RETRY_DEFAULTS = { retries: 4, baseMs: 1000, maxMs: 16000 };

// fn 每次重试都会重新调用，带上传内容的请求要在 fn 里重新创建流
async function withRetry(fn, opts = {}) {
  const { retries, baseMs, maxMs, sleep = ms => new Promise(r => setTimeout(r, ms)), onRetry } = { ...RETRY_DEFAULTS, ...opts };
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      // 指数退避 + 随机抖动，避免并发的几个请求同时重试再次撞上限流
      const waitMs = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      if (onRetry) onRetry({ attempt: attempt + 1, waitMs, error: err });
      await sleep(waitMs);
    }
  }
}

function describeError(err) {
  const status = errorStatus(err);
  return status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : (err && err.message) || 'unknown';
}

const CLOUD_FIELDS = 'id, modifiedTime, name, lastModifyingUser, owners';

function toCloudInfo(data) {
  const u = data.lastModifyingUser || null;
  let modifiedBy = (u && ((u.displayName && u.displayName.trim()) || (u.emailAddress && u.emailAddress.trim()))) || null;
  if (!modifiedBy && Array.isArray(data.owners) && data.owners.length > 0) {
    const o = data.owners[0];
    modifiedBy = (o && ((o.displayName && o.displayName.trim()) || (o.emailAddress && o.emailAddress.trim()))) || null;
  }
  if (!modifiedBy && data.sharingUser) {
    const s = data.sharingUser;
    modifiedBy = (s && ((s.displayName && s.displayName.trim()) || (s.emailAddress && s.emailAddress.trim()))) || null;
  }
  return {
    modifiedTime: data.modifiedTime,
    name: data.name,
    modifiedBy: modifiedBy || null,
    error: null
  };
}

// 查询单个表的当前云端状态（上传前冲突检测、下载前记录基准时间用）；失败抛错
async function getCloudInfo(fileId, oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const resp = await withRetry(() => drive.files.get({ fileId, fields: CLOUD_FIELDS, supportsAllDrives: true }));
  return toCloudInfo(resp.data);
}

const REQUEST_TIMEOUT_MS = 30000;  // 单个请求超时：网络卡住时不至于让整轮刷新一直挂着

// 逐个查询（批量请求失败或个别条目被限流时的兜底）
async function getModifiedTimesEach(spreadsheetIds, oauth2Client, concurrency = DEFAULT_CONCURRENCY, retryOpts = {}) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const results = new Map();
  const queue = [...new Set(spreadsheetIds)];
  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) return;
      try {
        // supportsAllDrives：放在共享云端硬盘里的表不带这个参数会返回 404
        const resp = await withRetry(() => drive.files.get({ fileId: id, fields: CLOUD_FIELDS, supportsAllDrives: true }, { timeout: REQUEST_TIMEOUT_MS }), retryOpts);
        results.set(id, toCloudInfo(resp.data));
      } catch (err) {
        results.set(id, { modifiedTime: null, name: null, modifiedBy: null, error: describeError(err) });
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------- 批量查询：一个 HTTP 请求查最多 100 个文件（Drive batch API） ----------
// 表多时逐个查询受网络往返时间限制（实测 81 张表约 48 秒），批量只要 1～3 秒
const BATCH_URL = 'https://www.googleapis.com/batch/drive/v3';
const BATCH_SIZE = 100;
// 批量请求正常 1～3 秒；偶尔首个连接会卡住，与其干等 30 秒，不如 10 秒超时后再试一次，仍失败才逐个查询
const BATCH_TIMEOUT_MS = 10000;
const BATCH_ATTEMPTS = 2;

function buildBatchBody(ids, boundary) {
  const fields = CLOUD_FIELDS.replace(/\s+/g, '');
  return ids.map((id, i) => [
    `--${boundary}`,
    'Content-Type: application/http',
    `Content-ID: <item${i}>`,
    '',
    `GET /drive/v3/files/${encodeURIComponent(id)}?fields=${fields}&supportsAllDrives=true HTTP/1.1`,
    '', ''
  ].join('\r\n')).join('') + `--${boundary}--`;
}

/** 解析 multipart/mixed 批量响应：返回 Map(下标 → { status, body }) */
function parseBatchResponse(text, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!m) throw new Error('批量响应缺少 boundary');
  const out = new Map();
  for (const part of String(text).split(`--${m[1]}`)) {
    const idm = /Content-ID:\s*<response-item(\d+)>/i.exec(part);
    const sm = /HTTP\/1\.1 (\d{3})/.exec(part);
    if (!idm || !sm) continue;
    const jsonStart = part.indexOf('{', sm.index);
    let body = null;
    if (jsonStart >= 0) {
      try { body = JSON.parse(part.slice(jsonStart, part.lastIndexOf('}') + 1)); } catch (_) { body = null; }
    }
    out.set(Number(idm[1]), { status: Number(sm[1]), body });
  }
  return out;
}

function batchItemError(status, body) {
  const err = new Error((body && body.error && body.error.message) || `HTTP ${status}`);
  err.code = status;
  err.errors = (body && body.error && body.error.errors) || [];
  return err;
}

/**
 * 查询一批表格的云端修改时间 / 名称 / 最后修改人。返回 Map(id → { modifiedTime, name, modifiedBy, error })
 * 先用批量请求；被限流 / 临时故障的条目、整批失败的分块再逐个查询（带退避重试）
 * request：测试用，替代 oauth2Client.request
 */
async function getModifiedTimes(spreadsheetIds, oauth2Client, { request, concurrency = DEFAULT_CONCURRENCY, retryOpts = {} } = {}) {
  const ids = [...new Set(spreadsheetIds.filter(Boolean))];
  const results = new Map();
  if (ids.length === 0) return results;
  const send = request || (opts => oauth2Client.request(opts));
  const retry = [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) chunks.push(ids.slice(i, i + BATCH_SIZE));
  await Promise.all(chunks.map(async chunk => {
    const boundary = `csm_batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let parts = null;
    for (let attempt = 0; attempt < BATCH_ATTEMPTS && !parts; attempt++) {
      try {
        const resp = await send({
          url: BATCH_URL,
          method: 'POST',
          headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` },
          data: buildBatchBody(chunk, boundary),
          responseType: 'text',
          timeout: BATCH_TIMEOUT_MS
        });
        const ctype = resp.headers && (typeof resp.headers.get === 'function' ? resp.headers.get('content-type') : resp.headers['content-type']);
        parts = parseBatchResponse(resp.data, ctype);
      } catch (_) { /* 再试一次，仍失败就逐个查询 */ }
    }
    if (!parts) {
      retry.push(...chunk);
      return;
    }
    chunk.forEach((id, i) => {
      const r = parts.get(i);
      if (!r) { retry.push(id); return; }
      if (r.status === 200 && r.body) { results.set(id, toCloudInfo(r.body)); return; }
      const err = batchItemError(r.status, r.body);
      if (isRetryable(err)) retry.push(id);
      else results.set(id, { modifiedTime: null, name: null, modifiedBy: null, error: describeError(err) });
    });
  }));
  if (retry.length) {
    const each = await getModifiedTimesEach(retry, oauth2Client, concurrency, retryOpts);
    for (const [id, info] of each) results.set(id, info);
  }
  return results;
}

// 当前授权的 Google 账号（写操作历史用）
async function getCurrentUser(oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const resp = await withRetry(() => drive.about.get({ fields: 'user(displayName, emailAddress)' }));
  const u = resp.data.user || {};
  return { name: u.displayName || null, email: u.emailAddress || null };
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

// 查询单个云端文件的元信息（用于粘贴链接后自动解析）；失败时抛出带 reason 的错误
async function getFileInfo(fileId, oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  try {
    const resp = await withRetry(() => drive.files.get({
      fileId,
      fields: 'id, name, mimeType, modifiedTime, webViewLink, parents',
      supportsAllDrives: true
    }));
    return { ...resp.data, isGoogleSheet: resp.data.mimeType === GOOGLE_SHEET_MIME };
  } catch (err) {
    const status = err && err.code;
    const e = new Error(status === 404 ? '找不到这个文件（链接错误，或当前 Google 账号没有访问权限）'
      : status === 403 ? '当前 Google 账号没有这个文件的访问权限'
      : `查询云端文件失败：${err.message || err}`);
    e.status = status === 404 ? 404 : status === 403 ? 403 : 502;
    throw e;
  }
}

// 用 xlsx 内容覆盖云端 Google Sheet（Drive 会自动把 xlsx 转换为原生表格并替换全部内容）
async function uploadXlsxToSheet(spreadsheetId, buffer, oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const resp = await withRetry(() => drive.files.update({
    fileId: spreadsheetId,
    media: { mimeType: XLSX_MIME, body: Readable.from(buffer) },
    fields: 'id, modifiedTime, name',
    supportsAllDrives: true
  }));
  return { modifiedTime: resp.data.modifiedTime, name: resp.data.name };
}

// ---------- 保留云端公式的上传 ----------
// Drive 的 xlsx 整表替换会把云端公式（如 IMPORTRANGE 镜像主表）换成本地的「值」，且无法撤销。
// 所以上传前先探测云端有没有公式：
//   没有 → 走原来的整表替换；
//   有   → 用 Sheets API 按单元格写：非公式区直接写；IMPORTRANGE 镜像区的差异按映射写回源表（镜像随之更新），
//          其他公式（VLOOKUP 等）算出来的格不写，源数据改了会自动跟着变。
// 写回源表会改另一张表，必须用户确认：未传 writeThrough 时只返回预览（needsWriteThrough），什么都不写。
const BATCH_VALUES_CHUNK = 200;
const PREVIEW_SAMPLES = 10;
const PROBE_FIELDS = 'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue(formulaValue)))))';
const GRID_FIELDS = 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))';

// 只拉公式（返回量很小）：上传前判断有没有公式，以及识别 IMPORTRANGE 镜像表的源表（见 mirror-sources.js）
async function probeFormulas(spreadsheetId, oauth2Client, { sheetsClient } = {}) {
  const sheets = sheetsClient || google.sheets({ version: 'v4', auth: oauth2Client });
  const resp = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId, includeGridData: true, fields: PROBE_FIELDS }, { timeout: REQUEST_TIMEOUT_MS }));
  return resp.data.sheets || [];
}

// 往一张表里写：先按需扩行列（超出网格的写入会失败），再分批写值。targets = [{ title, sheetId, grid, writes }]
async function applyCellWrites(sheets, spreadsheetId, targets) {
  const guard = require('./formula-guard');
  const grow = [];
  for (const t of targets) {
    if (!t.writes.length) continue;
    const needRows = Math.max(...t.writes.map(w => w.row)) + 1;
    const needCols = Math.max(...t.writes.map(w => w.col)) + 1;
    if (t.grid.rowCount != null && needRows > t.grid.rowCount) grow.push({ appendDimension: { sheetId: t.sheetId, dimension: 'ROWS', length: needRows - t.grid.rowCount } });
    if (t.grid.columnCount != null && needCols > t.grid.columnCount) grow.push({ appendDimension: { sheetId: t.sheetId, dimension: 'COLUMNS', length: needCols - t.grid.columnCount } });
  }
  if (grow.length) await withRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: grow } }));
  const data = targets.flatMap(t => guard.toValueRanges(t.title, t.writes));
  for (let i = 0; i < data.length; i += BATCH_VALUES_CHUNK) {
    const chunk = data.slice(i, i + BATCH_VALUES_CHUNK);
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: chunk } }));
  }
}

// 读源表、核对每个要写的格：源格是公式 / 源格当前值与镜像看到的不一致（别人刚改过、镜像还没刷新）→ 不写
async function resolveSourceWrites(sheets, oauth2Client, wt) {
  const guard = require('./formula-guard');
  const out = [];
  const blocked = [];
  for (const [sourceId, bySheet] of wt.sources) {
    const info = await getCloudInfo(sourceId, oauth2Client).catch(() => ({ name: null }));
    const targets = [];
    for (const [sheetKey, cells] of bySheet) {
      if (!cells.size) continue;
      const resp = await withRetry(() => sheets.spreadsheets.get({
        spreadsheetId: sourceId, includeGridData: true, fields: GRID_FIELDS,
        ...(sheetKey ? { ranges: [guard.quoteSheet(sheetKey)] } : {})
      }));
      const sh = (resp.data.sheets || [])[0];
      if (!sh) { for (const c of cells.values()) blocked.push({ sheet: c.from[0].split('!')[0], cell: c.from[0].split('!')[1], local: c.value, cloud: c.expect, reason: 'source_missing' }); continue; }
      const src = guard.sheetCells(sh);
      const writes = [];
      for (const c of cells.values()) {
        const cur = src.get(`${c.row},${c.col}`);
        const [mSheet, mCell] = c.from[0].split('!');
        if (cur && cur.formula) { blocked.push({ sheet: mSheet, cell: mCell, local: c.value, cloud: c.expect, reason: 'source_formula' }); continue; }
        if ((cur ? cur.effective : '') !== c.expect) { blocked.push({ sheet: mSheet, cell: mCell, local: c.value, cloud: c.expect, source: cur ? cur.effective : '', reason: 'source_changed' }); continue; }
        writes.push({ row: c.row, col: c.col, value: c.value, from: c.from });
      }
      targets.push({ title: sh.properties.title, sheetId: sh.properties.sheetId, grid: sh.properties.gridProperties || {}, writes });
    }
    out.push({ sourceId, name: info.name, targets });
  }
  return { sources: out, blocked };
}

function sourcePreview(sources) {
  const guard = require('./formula-guard');
  return sources.map(s => ({
    sourceId: s.sourceId,
    name: s.name,
    sheets: s.targets.filter(t => t.writes.length).map(t => ({
      title: t.title,
      count: t.writes.length,
      samples: t.writes.slice(0, PREVIEW_SAMPLES).map(w => ({ cell: guard.a1(w.row, w.col), value: w.value, from: w.from[0] }))
    }))
  })).filter(s => s.sheets.length);
}

async function uploadXlsxPreservingFormulas(spreadsheetId, buffer, oauth2Client, { sheetsClient, uploadReplace, writeThrough = false } = {}) {
  const { readWorkbook } = require('./xlsx-reader');
  const guard = require('./formula-guard');
  const sheets = sheetsClient || google.sheets({ version: 'v4', auth: oauth2Client });
  const replace = uploadReplace || (() => uploadXlsxToSheet(spreadsheetId, buffer, oauth2Client));

  // 1) 只拉公式，判断云端有没有公式（返回量很小）
  const probe = await probeFormulas(spreadsheetId, oauth2Client, { sheetsClient: sheets });
  const hasFormula = probe.some(s => guard.findFormulas(s).length > 0);
  if (!hasFormula) {
    const info = await replace();
    return { ...info, formulaProtected: false };
  }

  // 2) 有公式：拉完整网格，按单元格生成计划；公式区差异映射到源表并逐格核对
  const grid = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId, includeGridData: true, fields: GRID_FIELDS }));
  const plan = guard.planWorkbook(readWorkbook(buffer), grid.data.sheets || []);
  const wt = guard.planWriteThrough(plan.plans);
  const src = await resolveSourceWrites(sheets, oauth2Client, wt);
  const blocked = [...wt.blocked, ...src.blocked];
  const sourceWriteCount = src.sources.reduce((n, s) => n + s.targets.reduce((m, t) => m + t.writes.length, 0), 0);
  const summary = {
    formulaProtected: true,
    written: plan.written,
    sourceWriteCount,
    sources: sourcePreview(src.sources),
    derivedCount: wt.derived.length,
    derivedSamples: wt.derived.slice(0, PREVIEW_SAMPLES),
    blockedCount: blocked.length,
    blockedSamples: blocked.slice(0, PREVIEW_SAMPLES * 2),
    formulaSheets: plan.formulaSheets,
    localOnlySheets: plan.localOnly,
    cloudOnlySheets: plan.cloudOnly
  };

  // 3) 要改源表但用户还没确认：只返回预览，一个格都不写
  if (sourceWriteCount > 0 && !writeThrough) return { ...summary, needsWriteThrough: true };

  // 4) 先写镜像表的非公式区，再写源表
  await applyCellWrites(sheets, spreadsheetId, plan.plans.map(p => ({ title: p.title, sheetId: p.sheetId, grid: p.grid, writes: p.writes })));
  for (const s of src.sources) await applyCellWrites(sheets, s.sourceId, s.targets);

  const info = await getCloudInfo(spreadsheetId, oauth2Client);
  return { ...summary, modifiedTime: info.modifiedTime, name: info.name };
}

// 使用当前授权账号通过 Drive API 导出 Google Sheet 为 xlsx，单表导出上限 10 MB。
async function downloadViaDrive(spreadsheetId, savePath, oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  const tmpPath = `${savePath}.tmp.${process.pid}.${Date.now()}`;
  // 整个导出（含写临时文件）一起重试：流中途断开时也能从头再来
  await withRetry(async () => {
    try {
      const resp = await drive.files.export({ fileId: spreadsheetId, mimeType: XLSX_MIME }, { responseType: 'stream' });
      await pipeline(resp.data, fs.createWriteStream(tmpPath));
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
  });
  fs.renameSync(tmpPath, savePath);
  return fs.statSync(savePath).size;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const qstr = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// 在 parentId 下按名字查子项（文件夹或 Google 表格）；返回第一个匹配或 null
async function findChild(drive, parentId, name, mimeType) {
  const resp = await withRetry(() => drive.files.list({
    q: `${qstr(parentId)} in parents and name = ${qstr(name)} and mimeType = ${qstr(mimeType)} and trashed = false`,
    fields: 'files(id, name, modifiedTime, webViewLink)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  }));
  return (resp.data.files || [])[0] || null;
}

// 逐级查找 rootId 下的子目录；create=true 时缺的自动创建。
// 返回 { folderId, missing: [还不存在的目录名], created: [本次创建的目录名] }；create=false 且有缺失时 folderId 为 null
async function resolveFolderPath(rootId, segments, oauth2Client, { create = false } = {}) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  let parent = rootId;
  const created = [];
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i];
    const found = await findChild(drive, parent, name, FOLDER_MIME);
    if (found) { parent = found.id; continue; }
    if (!create) return { folderId: null, missing: segments.slice(i), created };
    const resp = await drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parent] },
      fields: 'id',
      supportsAllDrives: true
    });
    parent = resp.data.id;
    created.push(name);
  }
  return { folderId: parent, missing: [], created };
}

async function findSheetInFolder(folderId, name, oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  return findChild(drive, folderId, name, GOOGLE_SHEET_MIME);
}

// 用本地 xlsx 在云端目录里新建 Google 表格（Drive 自动把 xlsx 转成原生表格）
async function createSheetFromXlsx(folderId, name, buffer, oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const resp = await drive.files.create({
    requestBody: { name, mimeType: GOOGLE_SHEET_MIME, parents: [folderId] },
    media: { mimeType: XLSX_MIME, body: Readable.from(buffer) },
    fields: 'id, name, modifiedTime, webViewLink',
    supportsAllDrives: true
  });
  return resp.data;
}

module.exports = {
  withRetry, isRetryable, getCloudInfo, getCurrentUser, toCloudInfo, CLOUD_FIELDS,
  getModifiedTimes, getModifiedTimesEach, buildBatchBody, parseBatchResponse, probeFormulas, PROBE_FIELDS, uploadXlsxToSheet, uploadXlsxPreservingFormulas, downloadViaDrive, getFileInfo,
  resolveFolderPath, findSheetInFolder, createSheetFromXlsx,
  XLSX_MIME, GOOGLE_SHEET_MIME, FOLDER_MIME
};
