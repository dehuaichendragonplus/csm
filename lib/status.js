'use strict';

function determineStatus({ spreadsheetId, cloudModifiedTime, lastSyncedModifiedTime, localExists, apiError, localChanged }) {
  if (!spreadsheetId || apiError) return 'error';
  if (!localExists) return 'missing_local';
  if (!lastSyncedModifiedTime) return 'never_synced';
  if (cloudModifiedTime && cloudModifiedTime > lastSyncedModifiedTime) return 'updated';
  if (localChanged) return 'local_changed';
  return 'synced';
}

// 清单里的同步建议：'download'（云端覆盖本地）/ 'upload'（本地覆盖云端）/ null（无需操作）
// - 已同步：无需操作（刚下载的表本地修改时间必然晚于云端，不能单纯比时间）
// - 本地缺失：下载
// - 其他有差异的情况（云端有更新 / 本地有改动 / 未记录同步）：比较修改时间，云端较新下载，否则上传
function suggestDirection({ status, cloudModifiedTime, localMtime }) {
  if (status === 'error' || status === 'synced') return null;
  if (status === 'missing_local') return 'download';
  if (!cloudModifiedTime) return null;
  if (!localMtime) return 'download';
  return new Date(cloudModifiedTime) > new Date(localMtime) ? 'download' : 'upload';
}

module.exports = { determineStatus, suggestDirection };
