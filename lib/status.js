'use strict';

// 状态：
// - error：缺 spreadsheetId 或查询云端失败
// - missing_local：本地没有文件
// - never_synced：没有同步记录（清缓存后 / 新加入清单），不知道两边谁改过
// - conflict：上次同步后云端和本地都改过 —— 不能自动决定方向，必须人工看差异后选择
// - updated：云端有更新、本地没改过
// - local_changed：本地改过、云端没变
// - synced：两边都没变
function determineStatus({ spreadsheetId, cloudModifiedTime, lastSyncedModifiedTime, localExists, apiError, localChanged }) {
  if (!spreadsheetId || apiError) return 'error';
  if (!localExists) return 'missing_local';
  if (!lastSyncedModifiedTime) return 'never_synced';
  const cloudChanged = !!(cloudModifiedTime && cloudModifiedTime > lastSyncedModifiedTime);
  if (cloudChanged && localChanged) return 'conflict';
  if (cloudChanged) return 'updated';
  if (localChanged) return 'local_changed';
  return 'synced';
}

// 同步建议：'download'（云端覆盖本地）/ 'upload'（本地覆盖云端）/ 'conflict'（两边都改过，需人工选择）/ null（无需操作）
// - 已同步：不操作（刚下载的文件本地修改时间必然晚于云端，不能单纯比时间）
// - 本地缺失：下载
// - 云端有更新、本地没改过：下载（git 拉取会刷新本地修改时间，但内容没变，不能因此建议上传而覆盖云端新改动）
// - 本地改过、云端没变：上传
// - 两边都改过：冲突，不自动选方向
// - 从未记录同步：需要核对内容后明确选择保留哪一边
function suggestDirection({ status, cloudModifiedTime }) {
  if (status === 'error' || status === 'synced') return null;
  if (status === 'missing_local') return 'download';
  if (status === 'conflict') return 'conflict';
  if (status === 'updated') return 'download';
  if (status === 'local_changed') return 'upload';
  if (status === 'never_synced' && cloudModifiedTime) return 'review';
  return null;
}

// 上传前的冲突检测：云端当前修改时间晚于「基准」就说明有人在用户确认之后又改了云端，不能直接覆盖。
// 基准优先用用户确认时看到的云端时间（expect，差异预览时的版本），其次是上次同步记录，再次是列表缓存。
// 一个基准都没有时无法判断，放行（用户在确认框里已看到两边时间）。
function uploadConflict({ cloudModifiedTime, expect, lastSyncedModifiedTime, cachedModifiedTime, force }) {
  if (force) return null;
  const baseline = expect || lastSyncedModifiedTime || cachedModifiedTime || null;
  if (!baseline || !cloudModifiedTime) return null;
  return cloudModifiedTime > baseline ? { baseline } : null;
}

module.exports = { determineStatus, suggestDirection, uploadConflict };
