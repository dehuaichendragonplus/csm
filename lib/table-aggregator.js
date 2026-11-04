'use strict';
const fs = require('node:fs');
const { determineStatus } = require('./status');

function aggregateTables(filelist, driveMap, state) {
  return filelist.map(entry => {
    const driveInfo = entry.spreadsheetId ? driveMap.get(entry.spreadsheetId) : null;
    const stateRow = state[entry.path] || null;

    let localExists = false;
    let localSize = null;
    let localMtime = null;
    try {
      const st = fs.statSync(entry.savePath);
      localExists = true;
      localSize = st.size;
      localMtime = st.mtime.toISOString();
    } catch (_) { /* file missing */ }

    // Local file diverges from what we last downloaded (e.g. git checkout, manual revert)
    let localChanged = false;
    if (localExists && stateRow && (stateRow.lastSyncedSize != null || stateRow.lastSyncedMtime != null)) {
      if (stateRow.lastSyncedSize != null && stateRow.lastSyncedSize !== localSize) localChanged = true;
      if (stateRow.lastSyncedMtime != null && stateRow.lastSyncedMtime !== localMtime) localChanged = true;
    }

    const apiError = driveInfo ? driveInfo.error : null;
    const cloudModifiedTime = driveInfo ? driveInfo.modifiedTime : null;
    const lastSyncedModifiedTime = stateRow ? stateRow.lastSyncedModifiedTime : null;
    const status = determineStatus({
      spreadsheetId: entry.spreadsheetId,
      cloudModifiedTime,
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
      spreadsheetId: entry.spreadsheetId,
      status,
      cloudModifiedTime,
      lastSyncedModifiedTime,
      lastSyncedAt: stateRow ? stateRow.lastSyncedAt : null,
      localExists,
      error: errorMsg
    };
  });
}

module.exports = { aggregateTables };
