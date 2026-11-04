'use strict';

function determineStatus({ spreadsheetId, cloudModifiedTime, lastSyncedModifiedTime, localExists, apiError, localChanged }) {
  if (!spreadsheetId || apiError) return 'error';
  if (!localExists) return 'missing_local';
  if (!lastSyncedModifiedTime) return 'never_synced';
  if (cloudModifiedTime && cloudModifiedTime > lastSyncedModifiedTime) return 'updated';
  if (localChanged) return 'local_changed';
  return 'synced';
}

module.exports = { determineStatus };
