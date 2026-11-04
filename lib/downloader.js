'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const DEFAULT_TIMEOUT_MS = 120000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function downloadOnce({ url, savePath, onProgress, timeoutMs }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    const tmpPath = `${savePath}.tmp.${process.pid}.${Date.now()}`;
    const fileStream = fs.createWriteStream(tmpPath);
    const protocol = url.protocol === 'https:' ? https : http;

    const request = protocol.get(url.toString(), response => {
      if (response.statusCode !== 200) {
        fileStream.destroy();
        fs.unlink(tmpPath, () => {});
        const err = new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
        err.statusCode = response.statusCode;
        reject(err);
        return;
      }
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(() => {
          try {
            fs.renameSync(tmpPath, savePath);
            resolve(received);
          } catch (err) {
            reject(err);
          }
        });
      });
      fileStream.on('error', err => {
        fs.unlink(tmpPath, () => {});
        reject(err);
      });
    });
    request.on('error', err => {
      fileStream.destroy();
      fs.unlink(tmpPath, () => {});
      reject(err);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      fileStream.destroy();
      fs.unlink(tmpPath, () => {});
      reject(new Error(`download timeout after ${timeoutMs}ms`));
    });
  });
}

async function downloadOne({ baseUrl, spreadsheetId, password, savePath, mergeCells, onProgress, onRetry, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = new URL(baseUrl);
  url.searchParams.set('spreadsheetId', spreadsheetId);
  url.searchParams.set('password', password);
  url.searchParams.set('includeFormulas', String(!!mergeCells));

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const waitMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      if (onRetry) onRetry({ attempt, waitMs, error: lastErr });
      await sleep(waitMs);
    }
    try {
      return await downloadOnce({ url, savePath, onProgress, timeoutMs });
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && RETRYABLE_STATUS.has(err.statusCode)) {
        continue; // retry
      }
      throw err;
    }
  }
  throw lastErr;
}

module.exports = { downloadOne };
