// 批量下载结果与可复制的变更摘要，供页面及测试共用。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncBatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create(project, rows) {
    return {
      project,
      items: new Map(rows.map(row => [row.path, { ...row, status: 'pending' }])),
      action: { label: '导出', status: 'waiting' },
      running: false
    };
  }

  function apply(batch, paths, results, error) {
    const byPath = new Map(results.map(result => [result.path, result]));
    for (const path of paths) {
      const item = batch.items.get(path);
      const result = byPath.get(path);
      if (result && result.success) {
        item.status = 'success';
        item.error = null;
        // 下载时服务端可提供准确的本地 → 落盘差异。
        if (Object.hasOwn(result, 'summary')) item.summary = result.summary;
      } else {
        item.status = result && result.skipped ? 'skipped' : 'failed';
        item.error = (result && result.error) || error || '未收到该表的下载结果';
      }
    }
  }

  const failedPaths = batch => [...batch.items.values()].filter(item => item.status === 'failed').map(item => item.path);
  const skippedPaths = batch => [...batch.items.values()].filter(item => item.status === 'skipped').map(item => item.path);

  function describeScope(rows, visible, exportLabel) {
    return {
      count: rows.length,
      outside: rows.filter(row => !visible.has(row.path)).length,
      exportText: exportLabel ? `全部同步后自动执行「${exportLabel}」` : '本批仅下载'
    };
  }

  const complete = batch => batch.items.size > 0 && [...batch.items.values()].every(item => item.status === 'success');

  function counts(summary, reverse = false) {
    const [added, removed] = reverse ? [summary.removed, summary.added] : [summary.added, summary.removed];
    const parts = [];
    if (added) parts.push(`新增 ${added} 行`);
    if (summary.changed) parts.push(`修改 ${summary.changed} 行`);
    if (removed) parts.push(`删除 ${removed} 行`);
    if (summary.reordered) parts.push(`${summary.reordered} 个工作表行序变化`);
    const [newSheets, oldSheets] = reverse ? [summary.sheetsRemoved, summary.sheetsAdded] : [summary.sheetsAdded, summary.sheetsRemoved];
    if (newSheets) parts.push(`新增 ${newSheets} 个工作表`);
    if (oldSheets) parts.push(`删除 ${oldSheets} 个工作表`);
    return parts.join(' · ') || '单元格内容一致';
  }

  const inline = value => String(value ?? '').replace(/\r\n|\r|\n/g, ' ↵ ');
  function sampleText(sample, reverse = false) {
    const old = reverse ? sample.cloud : sample.local;
    const next = reverse ? sample.local : sample.cloud;
    return `${inline(sample.sheet)} / ${inline(sample.record)} · ${inline(sample.field)}：${inline(old) || '（空）'} → ${inline(next) || '（空）'}`;
  }

  const itemStatus = { pending: '等待中', success: '已同步', failed: '下载失败', skipped: '已跳过' };
  const actionStatus = { waiting: '等待全部同步', blocked: '同步状态有变化，未执行', running: '运行中', success: '成功', failed: '失败', disabled: '未配置自动执行' };

  function format(batch) {
    const lines = [`${inline(batch.project)} · 配置表下载摘要`];
    for (const item of batch.items.values()) {
      const details = item.status === 'success' && item.summary ? counts(item.summary) : item.error;
      lines.push(`- ${inline(item.name || item.path)}${item.name && item.name !== item.path ? `（${inline(item.path)}）` : ''} · ${itemStatus[item.status]}${details ? ` · ${inline(details)}` : ''}`);
      if (item.status === 'success' && !item.summary) lines.push('  - 变更明细不可用');
      if (item.status === 'success' && item.summary) {
        for (const sample of item.summary.samples) lines.push(`  - ${sampleText(sample)}`);
      }
    }
    lines.push(`${inline(batch.action.label)} · ${actionStatus[batch.action.status]}`);
    return lines.join('\n');
  }

  return { create, apply, failedPaths, skippedPaths, describeScope, complete, counts, sampleText, format, itemStatus, actionStatus };
});
