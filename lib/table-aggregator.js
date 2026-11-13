'use strict';
const fs = require('node:fs');
const { determineStatus, suggestDirection } = require('./status');
const { hashFile, fileVersion } = require('./sync-state');

function aggregateTables(filelist, driveMap, state) {
  return filelist.map(entry => {
    const driveInfo = entry.spreadsheetId ? driveMap.get(entry.spreadsheetId) : null;
    const stateRow = state[entry.path] || null;

    let localExists = false;
    let localSize = null;
    let localVersion = null;
    let localMtime = null;
    try {
      const st = fs.statSync(entry.savePath);
      localExists = true;
      localSize = st.size;
      localVersion = fileVersion(st);
      localMtime = st.mtime.toISOString();
    } catch (_) { /* file missing */ }

    // Local file diverges from what we last downloaded (e.g. git checkout, manual revert)
    let localChanged = false;
    // 大小变了一定是改过；只有修改时间变了时，有内容指纹就比指纹（git 操作只改时间不改内容），没有指纹按改过处理
    if (localExists && stateRow && (stateRow.lastSyncedSize != null || stateRow.lastSyncedMtime != null)) {
      if (stateRow.lastSyncedSize != null && stateRow.lastSyncedSize !== localSize) localChanged = true;
      else if (stateRow.lastSyncedMtime != null && stateRow.lastSyncedMtime !== localMtime) {
        localChanged = stateRow.lastSyncedHash ? hashFile(entry.savePath) !== stateRow.lastSyncedHash : true;
      }
    }

    const apiError = driveInfo ? driveInfo.error : null;
    const cloudModifiedTime = driveInfo ? driveInfo.modifiedTime : null;
    const lastSyncedModifiedTime = stateRow ? stateRow.lastSyncedModifiedTime : null;
    const status = determineStatus({
      spreadsheetId: entry.spreadsheetId,
      cloudModifiedTime,
      cloudModifiedBy: driveInfo ? driveInfo.modifiedBy || null : null,
      lastSyncedModifiedTime,
      localExists,
      apiError,
      localChanged
    });
    let errorMsg = null;
    if (status === 'error') {
      errorMsg = entry.incompleteReason || apiError || 'unknown error';
    }
    return {
      path: entry.path,
      name: entry.name,
      description: entry.description,
      cloudName: driveInfo ? driveInfo.name : null,
      spreadsheetId: entry.spreadsheetId,
      status,
      cloudModifiedTime,
      cloudModifiedBy: driveInfo ? driveInfo.modifiedBy || null : null,
      // IMPORTRANGE 镜像表：cloudModifiedTime 是有效版本 = max(自身, 各源表)；这里另给出自身时间、源表与「无法检查源表更新」提示
      cloudOwnModifiedTime: driveInfo && driveInfo.ownModifiedTime ? driveInfo.ownModifiedTime : null,
      cloudSources: driveInfo && Array.isArray(driveInfo.sources) ? driveInfo.sources.map(s => ({ id: s.id, name: s.name || null, modifiedTime: s.modifiedTime || null, error: s.error || null })) : null,
      cloudChangedVia: driveInfo ? driveInfo.changedVia || null : null,
      sourceWarning: driveInfo ? driveInfo.sourceWarning || null : null,
      lastSyncedModifiedTime,
      lastSyncedAt: stateRow ? stateRow.lastSyncedAt : null,
      localExists,
      localMtime,
      localVersion,
      // 同步建议：download / upload / conflict / null（与配置表清单同一套规则）
      localChanged,
      direction: suggestDirection({ status, cloudModifiedTime, localMtime, localChanged }),
      error: errorMsg
    };
  });
}

module.exports = { aggregateTables };
