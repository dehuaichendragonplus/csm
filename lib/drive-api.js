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

const CLOUD_FIELDS = 'id, modifiedTime, name, lastModifyingUser(displayName, emailAddress)';

function toCloudInfo(data) {
  const u = data.lastModifyingUser || null;
  return {
    modifiedTime: data.modifiedTime,
    name: data.name,
    modifiedBy: u ? (u.displayName || u.emailAddress || null) : null,
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
  const fields = encodeURIComponent(CLOUD_FIELDS.replace(/\s+/g, ''));
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

// 通过 Drive API 把 Google Sheet 导出为 xlsx（无内部导出服务时的默认下载方式；Drive 限制单表导出 ≤10MB）
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
  withRetry, isRetryable, getCloudInfo, getCurrentUser,
  getModifiedTimes, getModifiedTimesEach, buildBatchBody, parseBatchResponse, uploadXlsxToSheet, downloadViaDrive, getFileInfo,
  resolveFolderPath, findSheetInFolder, createSheetFromXlsx,
  XLSX_MIME, GOOGLE_SHEET_MIME, FOLDER_MIME
};
