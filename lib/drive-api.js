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
      fields: 'id, name, mimeType, modifiedTime, webViewLink',
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

module.exports = { getModifiedTimes, uploadXlsxToSheet, downloadViaDrive, getFileInfo, XLSX_MIME, GOOGLE_SHEET_MIME };
