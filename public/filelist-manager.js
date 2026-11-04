// 配置表清单（filelist.json）预览与编辑：列表 / 新增 / 修改 / 删除，粘贴 Google 表格链接自动解析
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = {
    open: $('btn-filelist'),
    modal: $('fl-modal'),
    close: $('fl-close'),
    file: $('fl-file'),
    formTitle: $('fl-form-title'),
    link: $('fl-link'),
    resolve: $('fl-resolve'),
    cloud: $('fl-cloud'),
    name: $('fl-name'),
    path: $('fl-path'),
    desc: $('fl-desc'),
    id: $('fl-id'),
    dirs: $('fl-dirs'),
    msg: $('fl-msg'),
    cancel: $('fl-cancel'),
    save: $('fl-save'),
    filter: $('fl-filter'),
    count: $('fl-count'),
    tbody: $('fl-tbody')
  };

  let entries = [];
  let editingPath = null; // null = 新增模式；否则为正在编辑条目的原路径
  let resolveSeq = 0;     // 只采用最后一次解析的结果，避免连续粘贴时旧结果覆盖新结果
  let lastResolvedId = '';

  const api = p => window.CSM.api(p);

  function setMsg(text, kind) {
    el.msg.textContent = text || '';
    el.msg.className = `fl-msg${kind ? ` ${kind}` : ''}`;
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return iso; }
  }

  function sheetUrl(id) {
    return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
  }

  async function readJson(resp) {
    try { return await resp.json(); } catch (_) { return {}; }
  }

  // ---------- 列表 ----------
  async function loadList() {
    el.tbody.innerHTML = '<tr><td colspan="6" class="fl-empty">加载中…</td></tr>';
    const resp = await fetch(api('/filelist'));
    const data = await readJson(resp);
    if (!resp.ok) {
      el.tbody.innerHTML = '';
      el.count.textContent = '';
      setMsg(`读取清单失败：${data.error || resp.status}`, 'error');
      return;
    }
    entries = data.entries || [];
    el.file.textContent = data.filelist || '';
    el.dirs.innerHTML = '';
    (data.dirs || []).forEach(d => {
      const o = document.createElement('option');
      o.value = `${d}/`;
      el.dirs.appendChild(o);
    });
    el.modal.dataset.defaultDir = data.defaultDir || '';
    renderList();
  }

  function renderList() {
    const terms = window.TableSearch.parseQuery(el.filter.value);
    const shown = terms.length ? entries.filter(e => window.TableSearch.matchRow(e, terms)) : entries;
    el.count.textContent = terms.length ? `匹配 ${shown.length} / 共 ${entries.length} 项` : `共 ${entries.length} 项`;
    el.tbody.innerHTML = '';
    if (!shown.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'fl-empty';
      td.textContent = entries.length ? '没有匹配的条目' : '清单是空的，在上方粘贴 Google 表格链接添加第一张表';
      tr.appendChild(td);
      el.tbody.appendChild(tr);
      return;
    }
    for (const e of shown) el.tbody.appendChild(renderRow(e));
  }

  function td(text, cls) {
    const c = document.createElement('td');
    if (cls) c.className = cls;
    c.textContent = text == null ? '' : String(text);
    return c;
  }

  function renderRow(e) {
    const tr = document.createElement('tr');
    if (editingPath && e.path === editingPath) tr.className = 'fl-editing';
    tr.appendChild(td(e.name, 'fl-col-name'));
    tr.appendChild(td(e.path, 'fl-col-path'));
    tr.appendChild(td(e.description, 'fl-col-desc'));

    const cloud = document.createElement('td');
    cloud.className = 'fl-col-cloud';
    if (e.spreadsheetId) {
      const a = document.createElement('a');
      a.href = sheetUrl(e.spreadsheetId);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `${String(e.spreadsheetId).slice(0, 8)}…`;
      a.title = `${e.spreadsheetId}\n打开云端表`;
      cloud.appendChild(a);
    } else {
      cloud.textContent = '缺少 ID';
      cloud.classList.add('fl-bad');
    }
    tr.appendChild(cloud);

    const local = td(e.local ? `✓ ${fmtSize(e.local.size)}` : '未下载', e.local ? 'fl-ok' : 'fl-muted');
    if (e.local) local.title = `本地修改时间：${fmtTime(e.local.mtime)}`;
    tr.appendChild(local);

    const ops = document.createElement('td');
    ops.className = 'fl-col-ops';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => startEdit(e));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fl-del';
    del.textContent = '删除';
    del.addEventListener('click', () => removeEntry(e));
    ops.append(edit, del);
    tr.appendChild(ops);
    return tr;
  }

  // ---------- 表单 ----------
  function resetForm() {
    editingPath = null;
    lastResolvedId = '';
    el.formTitle.textContent = '新增配置表';
    el.save.textContent = '添加到清单';
    el.cancel.classList.add('hidden');
    [el.link, el.name, el.path, el.desc, el.id].forEach(i => { i.value = ''; });
    el.cloud.textContent = '';
    el.cloud.className = 'fl-cloud';
    setMsg('');
    renderList();
  }

  function startEdit(e) {
    editingPath = e.path;
    lastResolvedId = e.spreadsheetId || '';
    el.formTitle.textContent = `编辑：${e.name || e.path}`;
    el.save.textContent = '保存修改';
    el.cancel.classList.remove('hidden');
    el.link.value = '';
    el.name.value = e.name || '';
    el.path.value = e.path || '';
    el.desc.value = e.description || '';
    el.id.value = e.spreadsheetId || '';
    el.cloud.textContent = '如需换绑云端表，在上方粘贴新链接';
    el.cloud.className = 'fl-cloud';
    setMsg('');
    renderList();
    el.name.focus();
  }

  function showCloud(data) {
    el.cloud.innerHTML = '';
    el.cloud.className = 'fl-cloud ok';
    const c = data.cloud;
    const a = document.createElement('a');
    a.href = c.webViewLink || sheetUrl(data.spreadsheetId);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = c.name;
    el.cloud.append('✓ 云端表：', a, `　最后修改 ${fmtTime(c.modifiedTime)}`);
    if (!c.isGoogleSheet) {
      const w = document.createElement('div');
      w.className = 'fl-warn';
      w.textContent = `⚠ 这不是 Google 表格（类型 ${c.mimeType}），同步可能失败`;
      el.cloud.appendChild(w);
    }
    const dup = (data.existing || []).filter(x => x.path !== editingPath);
    if (dup.length) {
      const w = document.createElement('div');
      w.className = 'fl-warn';
      w.textContent = `⚠ 清单里已有这个云端表：${dup.map(x => `${x.name}（${x.path}）`).join('、')}`;
      el.cloud.appendChild(w);
    }
  }

  async function resolveLink() {
    const input = el.link.value.trim();
    if (!input) return;
    const seq = ++resolveSeq;
    el.cloud.className = 'fl-cloud';
    el.cloud.textContent = '解析中…';
    el.resolve.disabled = true;
    try {
      const resp = await fetch(api('/filelist/resolve'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input })
      });
      const data = await readJson(resp);
      if (seq !== resolveSeq) return;
      if (!resp.ok) {
        el.cloud.className = 'fl-cloud error';
        if (resp.status === 401) {
          el.cloud.textContent = '需要先完成 Google 授权（关闭此窗口后点页面上的「前往授权」）';
          window.CSM.showAuthBanner();
        } else {
          el.cloud.textContent = `✗ ${data.error || `解析失败（${resp.status}）`}`;
        }
        return;
      }
      lastResolvedId = data.spreadsheetId;
      el.id.value = data.spreadsheetId;
      showCloud(data);
      const s = data.suggestion || {};
      if (editingPath) {
        // 编辑时换绑：只补空字段，不覆盖用户已有的表名 / 路径
        if (!el.name.value.trim()) el.name.value = s.name || '';
        if (!el.path.value.trim()) el.path.value = s.path || '';
        if (!el.desc.value.trim()) el.desc.value = s.description || '';
      } else {
        el.name.value = s.name || '';
        el.path.value = s.path || '';
        el.desc.value = s.description || '';
        el.path.focus();
        // 光标停在文件名前，方便直接改目录或文件名
        const slash = el.path.value.lastIndexOf('/');
        el.path.setSelectionRange(slash + 1, el.path.value.length - '.xlsx'.length);
      }
      setMsg('');
    } catch (err) {
      if (seq === resolveSeq) {
        el.cloud.className = 'fl-cloud error';
        el.cloud.textContent = `✗ ${err.message}`;
      }
    } finally {
      if (seq === resolveSeq) el.resolve.disabled = false;
    }
  }

  async function save(allowDuplicateId) {
    const entry = {
      name: el.name.value.trim(),
      path: el.path.value.trim(),
      description: el.desc.value.trim(),
      spreadsheetId: el.id.value.trim()
    };
    // 用户粘贴了链接但没点解析：直接从链接取 ID
    if (!entry.spreadsheetId && el.link.value.trim()) {
      setMsg('请先解析上方的链接', 'error');
      return;
    }
    const editing = editingPath;
    el.save.disabled = true;
    setMsg('保存中…');
    try {
      const resp = await fetch(api('/filelist'), {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing ? { originalPath: editing, entry, allowDuplicateId } : { entry, allowDuplicateId })
      });
      const data = await readJson(resp);
      if (resp.status === 409 && data.code === 'DUPLICATE_ID' && !allowDuplicateId) {
        setMsg('');
        if (confirm(`${data.error}\n\n同一个云端表对应多个本地文件通常是误操作。仍要保存吗？`)) return save(true);
        return;
      }
      if (!resp.ok) {
        setMsg(data.error || `保存失败（${resp.status}）`, 'error');
        return;
      }
      window.CSM.appendLog(editing
        ? `✎ 已修改清单条目：${data.entry.name}（${data.entry.path}）\n`
        : `＋ 已添加到清单：${data.entry.name}（${data.entry.path}）\n`);
      const savedPath = data.entry.path;
      resetForm();
      await loadList();
      setMsg(editing ? `已保存：${savedPath}` : `已添加：${savedPath}（本地还没有这个文件，可在主列表里点「下载」）`, 'ok');
      window.CSM.reloadTables();
    } catch (err) {
      setMsg(err.message, 'error');
    } finally {
      el.save.disabled = false;
    }
  }

  async function removeEntry(e) {
    const ok = confirm(`从清单移除「${e.name}」？\n\n${e.path}\n\n只修改 filelist.json，不会删除本地 xlsx 文件，也不会动云端表。`);
    if (!ok) return;
    const resp = await fetch(api(`/filelist?path=${encodeURIComponent(e.path)}`), { method: 'DELETE' });
    const data = await readJson(resp);
    if (!resp.ok) {
      setMsg(data.error || `删除失败（${resp.status}）`, 'error');
      return;
    }
    window.CSM.appendLog(`− 已从清单移除：${e.name}（${e.path}）\n`);
    if (editingPath === e.path) resetForm();
    await loadList();
    setMsg(`已移除：${e.path}`, 'ok');
    window.CSM.reloadTables();
  }

  // ---------- 打开 / 关闭 ----------
  async function open() {
    if (!window.CSM.currentId()) {
      alert('请先添加并选择一个项目');
      return;
    }
    el.filter.value = '';
    resetForm();
    el.modal.classList.remove('hidden');
    await loadList();
    el.link.focus();
  }

  function close() {
    el.modal.classList.add('hidden');
  }

  el.open.addEventListener('click', open);
  el.close.addEventListener('click', close);
  el.modal.addEventListener('click', e => { if (e.target === el.modal) close(); });
  el.modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (editingPath) resetForm(); else close();
    }
  });
  el.resolve.addEventListener('click', resolveLink);
  el.link.addEventListener('keydown', e => { if (e.key === 'Enter') resolveLink(); });
  // 粘贴后自动解析
  el.link.addEventListener('paste', () => setTimeout(resolveLink, 0));
  el.id.addEventListener('change', () => {
    if (el.id.value.trim() !== lastResolvedId) {
      el.cloud.className = 'fl-cloud';
      el.cloud.textContent = 'spreadsheetId 已手动修改，保存前可粘贴链接重新解析以确认云端表';
    }
  });
  [el.name, el.path, el.desc, el.id].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(false); }));
  el.save.addEventListener('click', () => save(false));
  el.cancel.addEventListener('click', resetForm);
  el.filter.addEventListener('input', renderList);
})();
