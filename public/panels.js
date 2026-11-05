// 差异预览 / 本地备份 / 操作历史 / 新版本提示。依赖 app.js 暴露的 window.CSM。
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const CSM = () => window.CSM;
  const fmt = iso => (CSM() ? CSM().formatTime(iso) : iso);
  const fmtSize = n => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  function setMsg(node, text, kind) {
    node.textContent = text || '';
    node.className = `fl-msg${kind ? ` ${kind}` : ''}`;
  }

  // ======================= 差异预览 =======================
  const d = {
    modal: $('diff-modal'), title: $('diff-title'), path: $('diff-path'), meta: $('diff-meta'), body: $('diff-body'),
    msg: $('diff-msg'), close: $('diff-close'), cancel: $('diff-cancel'), dl: $('diff-download'), ul: $('diff-upload')
  };
  let diffState = null; // { path, mode, data, resolve, token }
  const MODE_TITLE = { view: '差异预览', upload: '上传前确认差异', conflict: '解决冲突：云端和本地都改过' };
  const TYPE_LABEL = { modified: '修改', local_only: '仅本地有', cloud_only: '仅云端有' };

  function finishDiff(result) {
    if (!diffState) return;
    const { resolve } = diffState;
    diffState = null;
    d.modal.classList.add('hidden');
    resolve(result);
  }

  // mode：view（查看）/ upload（上传前确认）/ conflict（冲突，两个方向都可选、都不预设）
  function openDiff(path, { mode = 'view' } = {}) {
    if (diffState) finishDiff(null);
    return new Promise(resolve => {
      diffState = { path, mode, data: null, resolve, token: Symbol('diff') };
      d.title.textContent = MODE_TITLE[mode] || MODE_TITLE.view;
      d.path.textContent = path;
      d.modal.classList.remove('hidden');
      loadDiff();
    });
  }

  async function loadDiff() {
    const st = diffState;
    const token = Symbol('diff');
    st.token = token;
    st.data = null;
    d.meta.textContent = '';
    d.body.innerHTML = '';
    d.body.appendChild(el('div', 'diff-loading', '正在从云端导出并逐单元格比较…（大表需要几秒）'));
    setMsg(d.msg, '');
    updateButtons();
    try {
      const resp = await fetch(CSM().api(`/diff?path=${encodeURIComponent(st.path)}`));
      const data = await resp.json().catch(() => ({}));
      if (diffState !== st || st.token !== token) return;
      if (!resp.ok) {
        d.body.innerHTML = '';
        d.body.appendChild(el('div', 'diff-loading', resp.status === 401 ? '需要先完成 Google 授权' : `比较失败：${data.error || resp.status}`));
        return;
      }
      st.data = data;
      renderDiff();
    } catch (err) {
      if (diffState === st) { d.body.innerHTML = ''; d.body.appendChild(el('div', 'diff-loading', `比较失败：${err.message}`)); }
    } finally {
      if (diffState === st) updateButtons();
    }
  }

  // 哪一边是「将要生效」的新值：上传 → 本地；下载 / 查看 → 云端；冲突时两边都不预设
  function incomingSide() {
    const st = diffState;
    if (st.mode === 'upload') return 'local';
    if (st.mode === 'conflict') return null;
    const row = CSM().tableRow(st.path);
    return row && row.direction === 'upload' ? 'local' : 'cloud';
  }

  function renderDiff() {
    const { data, mode } = diffState;
    const diff = data.diff;
    d.meta.innerHTML = '';
    const line = (label, text) => { const p = el('div'); p.append(el('strong', null, `${label}　`), text); d.meta.appendChild(p); };
    line('本地', data.local.exists ? `修改于 ${fmt(data.local.mtime)} · ${fmtSize(data.local.size)}` : '本地还没有这个文件');
    line('云端', `修改于 ${fmt(data.cloud.modifiedTime)}${data.cloud.modifiedBy ? ` · ${data.cloud.modifiedBy}` : ''}${data.cloud.name ? ` · ${data.cloud.name}` : ''}`);

    const changed = diff.sheets.filter(s => s.status !== 'same');
    const total = changed.reduce((n, s) => n + (s.stats ? s.stats.modified + s.stats.localOnly + s.stats.cloudOnly : 1), 0);
    const summary = el('div');
    if (diff.identical) {
      summary.appendChild(el('span', 'diff-same', '✓ 两边内容完全一致（只是修改时间不同）。'));
      summary.append(' 点「用云端覆盖本地」即可把状态记为已同步（会先备份本地文件）。');
    } else {
      summary.append(`${changed.length} 个工作表有差异，共 ${total} 处行改动。`);
      if (mode === 'conflict') summary.appendChild(el('span', 'diff-warn', '　上次同步后两边都改过：无论选哪个方向，另一边的改动都会被覆盖，请先确认需要保留的内容。'));
    }
    d.meta.appendChild(summary);

    d.body.innerHTML = '';
    const incoming = incomingSide();
    for (const sheet of diff.sheets) d.body.appendChild(renderSheet(sheet, incoming));
  }

  function colLabel(sheet, c) {
    const h = sheet.header && sheet.header[c.col];
    return h ? `${c.colName} · ${h}` : c.colName;
  }

  function valueCell(text, side, incoming) {
    const td = el('td', 'v');
    if (text === '' || text == null) { td.appendChild(el('span', 'dir-tip', '（空）')); return td; }
    const span = el('span', incoming ? (side === incoming ? 'diff-new' : 'diff-old') : null, text);
    td.appendChild(span);
    return td;
  }

  function renderSheet(sheet, incoming) {
    const box = el('details', `diff-sheet ${sheet.status}`);
    const sum = el('summary', null, sheet.name);
    let tip = '';
    if (sheet.status === 'same') tip = `无差异 · ${sheet.localRows} 行`;
    else if (sheet.status === 'local_only') tip = `只在本地有这个工作表（${sheet.localRows} 行）`;
    else if (sheet.status === 'cloud_only') tip = `只在云端有这个工作表（${sheet.cloudRows} 行）`;
    else {
      const s = sheet.stats;
      tip = [s.modified && `修改 ${s.modified} 行（${s.cells} 格）`, s.localOnly && `仅本地 ${s.localOnly} 行`, s.cloudOnly && `仅云端 ${s.cloudOnly} 行`].filter(Boolean).join(' · ')
        + ` ｜ 本地 ${sheet.localRows} 行 / 云端 ${sheet.cloudRows} 行`;
    }
    sum.appendChild(el('span', 'dir-tip', tip));
    box.appendChild(sum);
    if (sheet.status !== 'changed') return box;
    box.open = true;

    const table = el('table', 'diff-table');
    const head = el('tr');
    ['类型', '行（本地 / 云端）', '列', '本地', '云端'].forEach(t => head.appendChild(el('th', null, t)));
    table.appendChild(head);
    for (const ch of sheet.changes) {
      const rowNo = `${ch.localRow || '—'} / ${ch.cloudRow || '—'}`;
      if (ch.type === 'modified') {
        ch.cells.forEach((c, i) => {
          const tr = el('tr');
          if (i === 0) {
            const t = el('td'); t.rowSpan = ch.cells.length; t.appendChild(el('span', `diff-tag ${ch.type}`, TYPE_LABEL[ch.type])); tr.appendChild(t);
            const r = el('td', 'mono', rowNo); r.rowSpan = ch.cells.length; tr.appendChild(r);
          }
          tr.appendChild(el('td', 'mono', colLabel(sheet, c)));
          tr.appendChild(valueCell(c.local, 'local', incoming));
          tr.appendChild(valueCell(c.cloud, 'cloud', incoming));
          table.appendChild(tr);
        });
      } else {
        const tr = el('tr');
        const t = el('td'); t.appendChild(el('span', `diff-tag ${ch.type}`, TYPE_LABEL[ch.type])); tr.appendChild(t);
        tr.appendChild(el('td', 'mono', rowNo));
        tr.appendChild(el('td', 'mono', '整行'));
        const text = ch.values.filter(v => v !== '').join(' | ');
        const shown = text.length > 300 ? `${text.slice(0, 300)}…` : text;
        tr.appendChild(valueCell(ch.type === 'local_only' ? shown : '', 'local', incoming));
        tr.appendChild(valueCell(ch.type === 'cloud_only' ? shown : '', 'cloud', incoming));
        table.appendChild(tr);
      }
    }
    box.appendChild(table);
    if (sheet.truncated) box.appendChild(el('div', 'diff-more', `改动较多，只列出前 ${sheet.changes.length} 处；完整内容请直接打开两边文件比较。`));
    return box;
  }

  function updateButtons(busy) {
    const st = diffState;
    const data = st && st.data;
    d.dl.disabled = !!busy || !data;
    d.ul.disabled = !!busy || !data || !data.local.exists;
    d.ul.classList.toggle('hidden', !CSM().allowUpload());
    const incoming = data ? incomingSide() : null;
    d.dl.classList.toggle('diff-primary', !!data && st.mode !== 'conflict' && (incoming === 'cloud' || data.diff.identical));
    d.ul.classList.toggle('diff-primary', !!data && st.mode !== 'conflict' && incoming === 'local' && !data.diff.identical);
    d.cancel.disabled = !!busy;
  }

  async function doDownload() {
    const st = diffState;
    if (!st || !st.data) return;
    if (st.mode === 'conflict' && !st.data.diff.identical
      && !confirm('用云端覆盖本地？\n\n本地在上次同步后的改动会被覆盖（覆盖前会自动备份，可在「🕘 本地备份」里恢复）。')) return;
    updateButtons(true);
    setMsg(d.msg, '下载中…');
    const summary = await CSM().downloadPaths([st.path]);
    if (diffState !== st) return;
    if (summary && summary.successCount) finishDiff('downloaded');
    else { setMsg(d.msg, '下载失败，详情见日志', 'error'); updateButtons(false); }
  }

  async function doUpload() {
    const st = diffState;
    if (!st || !st.data) return;
    if (st.mode === 'conflict' && !st.data.diff.identical
      && !confirm('用本地覆盖云端？\n\n云端在上次同步后的改动会被覆盖（可在 Google 表格「版本历史」中找回）。')) return;
    updateButtons(true);
    setMsg(d.msg, '上传中…');
    // expect：以这次差异预览看到的云端版本为准；之后云端若又被改，服务端会拒绝（409）
    const r = await CSM().uploadRequest(st.path, { expect: st.data.cloud.modifiedTime });
    if (diffState !== st) return;
    if (r.ok) { finishDiff('uploaded'); return; }
    if (r.status === 409 && r.data.error === 'CLOUD_CHANGED') {
      const who = r.data.cloudModifiedBy ? `「${r.data.cloudModifiedBy}」` : '其他人';
      setMsg(d.msg, `云端在 ${fmt(r.data.cloudModifiedTime)} 被${who}修改过（晚于这次差异预览），已取消上传`, 'error');
      if (confirm(`你查看差异之后，云端又被${who}修改了（${fmt(r.data.cloudModifiedTime)}）。\n\n直接上传会覆盖这次修改，已取消上传。\n现在重新比较差异吗？`)) {
        await loadDiff();
        return;
      }
    } else {
      setMsg(d.msg, `上传失败：${r.data.error || r.status}`, 'error');
    }
    updateButtons(false);
  }

  d.close.addEventListener('click', () => finishDiff(null));
  d.cancel.addEventListener('click', () => finishDiff(null));
  d.dl.addEventListener('click', doDownload);
  d.ul.addEventListener('click', doUpload);

  // ======================= 本地备份 =======================
  const b = { modal: $('bk-modal'), path: $('bk-path'), tbody: $('bk-tbody'), msg: $('bk-msg'), close: $('bk-close') };
  let bkRow = null;

  async function openBackups(row) {
    bkRow = row;
    b.path.textContent = `${row.name} · ${row.path}`;
    setMsg(b.msg, '');
    b.modal.classList.remove('hidden');
    await loadBackups();
  }

  async function loadBackups() {
    b.tbody.innerHTML = '';
    const resp = await fetch(CSM().api(`/backups?path=${encodeURIComponent(bkRow.path)}`));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { setMsg(b.msg, data.error || `读取失败（${resp.status}）`, 'error'); return; }
    if (!data.backups.length) {
      const tr = el('tr'); const td = el('td', 'fl-empty', '还没有备份：第一次「下载覆盖本地」时会自动备份'); td.colSpan = 4; tr.appendChild(td); b.tbody.appendChild(tr);
      return;
    }
    for (const bk of data.backups) {
      const tr = el('tr');
      tr.appendChild(el('td', 'hist-time', fmt(bk.createdAt)));
      tr.appendChild(el('td', null, bk.reason || '—'));
      tr.appendChild(el('td', null, fmtSize(bk.size)));
      const ops = el('td', 'fl-col-ops');
      const restore = el('button', null, '恢复');
      restore.type = 'button';
      restore.addEventListener('click', () => restoreBackup(bk));
      const show = el('button', null, '在访达中显示');
      show.type = 'button';
      show.addEventListener('click', () => revealBackup(bk));
      ops.append(restore, show);
      tr.appendChild(ops);
      b.tbody.appendChild(tr);
    }
  }

  async function restoreBackup(bk) {
    if (!confirm(`用 ${fmt(bk.createdAt)} 的备份覆盖本地「${bkRow.name}」？\n\n${bkRow.path}\n\n当前本地文件会先自动备份一份。`)) return;
    const resp = await fetch(CSM().api('/backups/restore'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: bkRow.path, id: bk.id })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { setMsg(b.msg, `恢复失败：${data.error || resp.status}`, 'error'); return; }
    setMsg(b.msg, `已恢复 ${fmt(bk.createdAt)} 的备份`, 'ok');
    CSM().appendLog(`✓ 已用备份 ${bk.id} 恢复本地 ${bkRow.path}\n`);
    await loadBackups();
    CSM().reloadTables();
  }

  async function revealBackup(bk) {
    const resp = await fetch(CSM().api('/backups/reveal'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: bkRow.path, id: bk.id })
    });
    if (!resp.ok) setMsg(b.msg, `打开失败：${(await resp.json().catch(() => ({}))).error || resp.status}`, 'error');
  }

  b.close.addEventListener('click', () => b.modal.classList.add('hidden'));

  // ======================= 操作历史 =======================
  const h = { modal: $('hist-modal'), tbody: $('hist-tbody'), filter: $('hist-filter'), count: $('hist-count'), close: $('hist-close') };
  let histRows = [];
  const OP_LABEL = { download: '⬇ 下载', upload: '⬆ 上传', create: '＋ 新建云端表', link: '🔗 关联云端表', restore: '↺ 恢复备份', action: '▶ 执行动作' };

  function histDetail(r) {
    if (!r.ok) return r.error ? `失败：${r.error}` : '失败';
    switch (r.op) {
      case 'download': return `云端版本 ${fmt(r.cloudModifiedTime)}${r.cloudModifiedBy ? `（${r.cloudModifiedBy}）` : ''}${r.backup ? ` · 覆盖前已备份 ${r.backup}` : ''}`;
      case 'upload': return `覆盖了云端 ${fmt(r.replacedCloudModifiedTime)}${r.replacedCloudModifiedBy ? `（${r.replacedCloudModifiedBy}）` : ''} 的版本${r.forced ? ' · 强制覆盖' : ''}`;
      case 'create': case 'link': return r.cloudDir || '';
      case 'restore': return `恢复到备份 ${r.backup}${r.backupBefore ? ` · 恢复前已备份 ${r.backupBefore}` : ''}`;
      case 'action': return `退出码 ${r.exitCode}${r.durationMs != null ? ` · 耗时 ${(r.durationMs / 1000).toFixed(1)}s` : ''}`;
      default: return '';
    }
  }

  function renderHistory() {
    const q = h.filter.value.trim().toLowerCase();
    const rows = q ? histRows.filter(r => [r.name, r.path, r.account, r.osUser, r.action].some(v => v && String(v).toLowerCase().includes(q))) : histRows;
    h.count.textContent = `${rows.length} 条${q ? `（共 ${histRows.length}）` : ''}`;
    h.tbody.innerHTML = '';
    if (!rows.length) {
      const tr = el('tr'); const td = el('td', 'fl-empty', histRows.length ? '没有匹配的记录' : '还没有操作记录'); td.colSpan = 5; tr.appendChild(td); h.tbody.appendChild(tr);
      return;
    }
    for (const r of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', 'hist-time', fmt(r.time)));
      tr.appendChild(el('td', `hist-op${r.ok ? '' : ' hist-fail'}`, OP_LABEL[r.op] || r.op));
      const t = el('td');
      t.appendChild(el('div', 'fl-col-name', r.name || '—'));
      if (r.path) t.appendChild(el('div', 'fl-col-path', r.path));
      tr.appendChild(t);
      tr.appendChild(el('td', 'hist-who', [r.account, r.osUser && `（${r.osUser}）`].filter(Boolean).join(' ') || '—'));
      tr.appendChild(el('td', `hist-detail${r.ok ? '' : ' hist-fail'}`, histDetail(r)));
      h.tbody.appendChild(tr);
    }
  }

  async function openHistory() {
    h.modal.classList.remove('hidden');
    h.tbody.innerHTML = '';
    h.count.textContent = '加载中…';
    const resp = await fetch(CSM().api('/history?limit=1000'));
    histRows = resp.ok ? await resp.json() : [];
    renderHistory();
    h.filter.focus();
  }

  h.filter.addEventListener('input', renderHistory);
  h.close.addEventListener('click', () => h.modal.classList.add('hidden'));

  // Esc 关闭最上层的这几个弹窗
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!d.modal.classList.contains('hidden')) { if (!d.cancel.disabled) finishDiff(null); }
    else if (!b.modal.classList.contains('hidden')) b.modal.classList.add('hidden');
    else if (!h.modal.classList.contains('hidden')) h.modal.classList.add('hidden');
  });

  // ======================= 新版本提示 =======================
  const u = { banner: $('update-banner'), text: $('update-text'), link: $('update-link'), dismiss: $('update-dismiss') };
  const DISMISS_KEY = 'csm.updateDismissed';
  async function checkUpdate() {
    try {
      const r = await (await fetch('/api/update-check')).json();
      if (r.current) $('app-title').title = `CSM v${r.current}`;
      if (!r.hasUpdate) return;
      let dismissed = null;
      try { dismissed = localStorage.getItem(DISMISS_KEY); } catch (_) {}
      if (dismissed === r.latest) return;
      u.text.textContent = `发现新版本 v${r.latest}（当前 v${r.current}）${r.notes ? `：${r.notes}` : ''}`;
      const href = r.download || r.url;
      u.link.classList.toggle('hidden', !href);
      if (href) u.link.href = href;
      u.banner.classList.remove('hidden');
      u.dismiss.onclick = () => {
        try { localStorage.setItem(DISMISS_KEY, r.latest); } catch (_) {}
        u.banner.classList.add('hidden');
      };
    } catch (_) { /* 检查失败不打扰 */ }
  }
  checkUpdate();
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);

  window.CSMPanels = { openDiff, openBackups, openHistory };
})();
