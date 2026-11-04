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

module.exports = { getModifiedTimes, uploadXlsxToSheet, downloadViaDrive, XLSX_MIME };
