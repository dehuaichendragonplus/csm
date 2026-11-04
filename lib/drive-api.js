'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { google } = require('googleapis');

const DEFAULT_CONCURRENCY = 5;

async function getModifiedTimes(spreadsheetIds, oauth2Client, concurrency = DEFAULT_CONCURRENCY) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const results = new Map();
  const queue = [...spreadsheetIds];
  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (!id) return;
      try {
        const resp = await drive.files.get({ fileId: id, fields: 'id, modifiedTime, name' });
        results.set(id, { modifiedTime: resp.data.modifiedTime, name: resp.data.name, error: null });
      } catch (err) {
        const status = err && err.code;
        const reason = status === 403 ? 'forbidden' : status === 404 ? 'not_found' : (err.message || 'unknown');
        results.set(id, { modifiedTime: null, name: null, error: reason });
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, spreadsheetIds.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

// 查询单个云端文件的元信息（用于粘贴链接后自动解析）；失败时抛出带 reason 的错误
async function getFileInfo(fileId, oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  try {
    const resp = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, modifiedTime, webViewLink, parents',
      supportsAllDrives: true
    });
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
  const resp = await drive.files.update({
    fileId: spreadsheetId,
    media: { mimeType: XLSX_MIME, body: Readable.from(buffer) },
    fields: 'id, modifiedTime, name'
  });
  return { modifiedTime: resp.data.modifiedTime, name: resp.data.name };
}

// 通过 Drive API 把 Google Sheet 导出为 xlsx（无内部导出服务时的默认下载方式；Drive 限制单表导出 ≤10MB）
async function downloadViaDrive(spreadsheetId, savePath, oauth2Client) {
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const resp = await drive.files.export({ fileId: spreadsheetId, mimeType: XLSX_MIME }, { responseType: 'stream' });
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  const tmpPath = `${savePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await pipeline(resp.data, fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, savePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  return fs.statSync(savePath).size;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const qstr = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// 在 parentId 下按名字查子项（文件夹或 Google 表格）；返回第一个匹配或 null
async function findChild(drive, parentId, name, mimeType) {
  const resp = await drive.files.list({
    q: `${qstr(parentId)} in parents and name = ${qstr(name)} and mimeType = ${qstr(mimeType)} and trashed = false`,
    fields: 'files(id, name, modifiedTime, webViewLink)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
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
  getModifiedTimes, uploadXlsxToSheet, downloadViaDrive, getFileInfo,
  resolveFolderPath, findSheetInFolder, createSheetFromXlsx,
  XLSX_MIME, GOOGLE_SHEET_MIME, FOLDER_MIME
};
