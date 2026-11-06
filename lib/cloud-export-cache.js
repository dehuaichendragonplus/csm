'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_MEMORY_WORKBOOKS = 20;
const DEFAULT_MAX_CACHE_FILES = 60;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 天

// 内存工作簿缓存（LRU Map，存储已解析的 [{ name, rows }]）
const memoryWorkbookCache = new Map();
const inFlightExports = new Map(); // key -> Promise<string>

function getMemoryWorkbook(key) {
  if (!key || !memoryWorkbookCache.has(key)) return null;
  const val = memoryWorkbookCache.get(key);
  // 刷新 LRU 顺序
  memoryWorkbookCache.delete(key);
  memoryWorkbookCache.set(key, val);
  return val;
}

function setMemoryWorkbook(key, wb, maxEntries = DEFAULT_MAX_MEMORY_WORKBOOKS) {
  if (!key || !wb) return;
  if (memoryWorkbookCache.has(key)) memoryWorkbookCache.delete(key);
  memoryWorkbookCache.set(key, wb);
  while (memoryWorkbookCache.size > maxEntries) {
    const oldestKey = memoryWorkbookCache.keys().next().value;
    memoryWorkbookCache.delete(oldestKey);
  }
}

function clearMemoryWorkbooks() {
  memoryWorkbookCache.clear();
}

function localMemoryKey(savePath, stat) {
  if (!stat) return null;
  return `local:${savePath}:${stat.mtimeMs}:${stat.size}`;
}

function cloudMemoryKey(spreadsheetId, cloudModifiedTime, exportOptions = {}) {
  const mode = exportOptions.exportUrl ? `url:${exportOptions.exportUrl}` : 'drive';
  const merge = exportOptions.mergeCells ? '1' : '0';
  return `cloud:${spreadsheetId}:${cloudModifiedTime}:${mode}:${merge}`;
}

function cloudExportFilename(spreadsheetId, cloudModifiedTime, exportOptions = {}) {
  const mode = exportOptions.exportUrl ? `url:${exportOptions.exportUrl}` : 'drive';
  const merge = exportOptions.mergeCells ? '1' : '0';
  const sig = crypto.createHash('sha1').update(`${cloudModifiedTime}|${mode}|${merge}`).digest('hex').slice(0, 16);
  const safeId = String(spreadsheetId || 'sheet').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  return `${safeId}_${sig}.xlsx`;
}

function ensureCacheDir(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

function getCachedExportPath(cacheDir, spreadsheetId, cloudModifiedTime, exportOptions = {}) {
  if (!cacheDir || !spreadsheetId || !cloudModifiedTime) return null;
  const filename = cloudExportFilename(spreadsheetId, cloudModifiedTime, exportOptions);
  const targetPath = path.join(cacheDir, filename);
  try {
    const st = fs.statSync(targetPath);
    if (st.size > 0) return targetPath;
  } catch (_) {}
  return null;
}

function saveExportToCache(cacheDir, spreadsheetId, cloudModifiedTime, exportOptions = {}, srcFilePath) {
  if (!cacheDir || !spreadsheetId || !cloudModifiedTime || !srcFilePath) return null;
  ensureCacheDir(cacheDir);
  const filename = cloudExportFilename(spreadsheetId, cloudModifiedTime, exportOptions);
  const targetPath = path.join(cacheDir, filename);
  const tmpPath = path.join(cacheDir, `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.copyFileSync(srcFilePath, tmpPath);
    fs.renameSync(tmpPath, targetPath);
    return targetPath;
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    return null;
  }
}

/**
 * 单飞去重：当同一份云端表格导出正在进行时，后续请求复用同一个 Promise，避免并发重复下载
 */
function singleFlightExport(key, fetchFn) {
  if (inFlightExports.has(key)) {
    return inFlightExports.get(key);
  }
  const promise = (async () => {
    try {
      return await fetchFn();
    } finally {
      inFlightExports.delete(key);
    }
  })();
  inFlightExports.set(key, promise);
  return promise;
}

function pruneOldExports(cacheDir, { maxFiles = DEFAULT_MAX_CACHE_FILES, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return;
  try {
    const entries = fs.readdirSync(cacheDir)
      .filter(name => name.endsWith('.xlsx'))
      .map(name => {
        const full = path.join(cacheDir, name);
        try {
          const st = fs.statSync(full);
          return { name, full, mtimeMs: st.mtimeMs, size: st.size };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    const now = Date.now();
    const kept = [];
    for (const e of entries) {
      if (now - e.mtimeMs > maxAgeMs) {
        fs.rmSync(e.full, { force: true });
      } else {
        kept.push(e);
      }
    }

    if (kept.length > maxFiles) {
      kept.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const toDelete = kept.slice(maxFiles);
      for (const e of toDelete) {
        fs.rmSync(e.full, { force: true });
      }
    }
  } catch (_) {}
}

module.exports = {
  getMemoryWorkbook,
  setMemoryWorkbook,
  clearMemoryWorkbooks,
  localMemoryKey,
  cloudMemoryKey,
  cloudExportFilename,
  getCachedExportPath,
  saveExportToCache,
  singleFlightExport,
  pruneOldExports
};
