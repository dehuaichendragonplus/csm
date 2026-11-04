(function () {
  'use strict';

  const STATUS_LABELS = {
    error: { label: '错误', icon: '✖' },
    missing_local: { label: '本地缺失', icon: '⊘' },
    local_changed: { label: '本地变更', icon: '⟲' },
    never_synced: { label: '未同步', icon: '✚' },
    updated: { label: '有更新', icon: '⚡' },
    synced: { label: '已同步', icon: '●' }
  };

  const GROUP_ORDER = ['updated', 'never_synced', 'missing_local', 'local_changed', 'error', 'synced'];
  // 由 /api/config 填充：标题、是否允许上传、同步后动作名、自定义动作按钮
  let appConfig = { allowUpload: true, actions: [] };
  const DEFAULT_COLLAPSED = new Set(['synced', 'local_changed']);
  // Tracks each group's expanded/collapsed state across re-renders (render() rebuilds the DOM from scratch).
  // Populated lazily from DEFAULT_COLLAPSED the first time a group is seen, then mutated by user clicks.
  const groupExpandedState = new Map();

  let currentId = null;
  let projects = [];
  const api = p => `/api/p/${encodeURIComponent(currentId)}${p}`;
  const PROJECT_KEY = 'syncmanager.currentProject';

  // 正在下载/上传的表 path：对应行置灰且不可点击（render 重建 DOM 时据此还原）
  const busyPaths = new Map(); // path -> 状态文案（下载中 / 上传中）
  function setRowBusy(path, busy, label) {
    if (busy) busyPaths.set(path, label || '处理中'); else busyPaths.delete(path);
    document.querySelectorAll('.row[data-path]').forEach(div => {
      if (div.dataset.path === path) applyRowBusy(div, busy, label);
    });
  }
  // 只释放本次操作自己的行（兜底流异常中断），不能动并发进行中的其他行
  function releaseRows(paths) { paths.forEach(p => setRowBusy(p, false)); }
  function applyRowBusy(div, busy, label) {
    div.classList.toggle('row-busy', busy);
    div.querySelectorAll('button').forEach(b => { b.disabled = busy; });
    const state = div.querySelector('.row-state');
    if (state) state.textContent = busy ? label : '';
  }

  const els = {
    projectTabs: document.getElementById('project-tabs'),
    btnAddProject: document.getElementById('btn-add-project'),
    summary: document.getElementById('summary'),
    groups: document.getElementById('groups'),
    log: document.getElementById('log'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnSyncAll: document.getElementById('btn-sync-all'),
    customActions: document.getElementById('custom-actions'),
    btnClearState: document.getElementById('btn-clear-state'),
    btnClearLog: document.getElementById('btn-clear-log'),
    authBanner: document.getElementById('auth-banner'),
    projectPanel: document.getElementById('project-panel'),
    summaryBar: document.getElementById('summary-bar'),
    projectName: document.getElementById('project-name'),
    projectDir: document.getElementById('project-dir'),
    search: document.getElementById('table-search')
  };

  // 搜索：render() 记住最近一次完整列表，输入关键词时只在前端过滤重绘，不再请求服务端
  let lastRows = null;
  let searchTerms = [];

  function formatTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return iso; }
  }

  function appendLog(text) {
    els.log.textContent += text;
    els.log.scrollTop = els.log.scrollHeight;
  }

  // 多个操作可并发（例如连续点了几行的下载），用计数保证全部结束后才恢复顶部按钮
  let busyCount = 0;
  function setBusy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    const busy = busyCount > 0;
    [els.btnRefresh, els.btnSyncAll, els.btnClearState, ...els.customActions.querySelectorAll('button')].forEach(b => { b.disabled = busy; });
  }

  function render(rows) {
    if (rows) lastRows = rows; else rows = lastRows;
    if (!rows) return;
    const counts = { error: 0, missing_local: 0, local_changed: 0, never_synced: 0, updated: 0, synced: 0 };
    rows.forEach(r => { counts[r.status]++; });
    const searching = searchTerms.length > 0;
    const shown = searching ? rows.filter(r => TableSearch.matchRow(r, searchTerms)) : rows;
    const buckets = { error: [], missing_local: [], local_changed: [], never_synced: [], updated: [], synced: [] };
    shown.forEach(r => { buckets[r.status].push(r); });

    els.summary.textContent =
      `${rows.length} 个表 | 有更新 ${counts.updated} | 未同步 ${counts.never_synced} | 本地缺失 ${counts.missing_local} | 本地变更 ${counts.local_changed} | 已同步 ${counts.synced} | 错误 ${counts.error}`
      + (searching ? ` ｜ 搜索命中 ${shown.length} 个` : '');

    els.groups.innerHTML = '';
    for (const key of GROUP_ORDER) {
      const list = buckets[key];
      if (list.length === 0) continue;
      if (!groupExpandedState.has(key)) {
        groupExpandedState.set(key, !DEFAULT_COLLAPSED.has(key));
      }
      // 搜索时命中的分组一律展开，且不改动用户平时的折叠偏好
      const expanded = searching || groupExpandedState.get(key);
      const group = document.createElement('section');
      group.className = `group ${expanded ? 'expanded' : ''}`;
      const header = document.createElement('header');
      header.className = 'group-header';
      header.textContent = `${STATUS_LABELS[key].label}（${list.length}）`;
      header.addEventListener('click', () => {
        const nowExpanded = group.classList.toggle('expanded');
        if (!searching) groupExpandedState.set(key, nowExpanded);
      });
      group.appendChild(header);
      const body = document.createElement('div');
      body.className = 'group-body';
      list.forEach(row => body.appendChild(renderRow(row)));
      group.appendChild(body);
      els.groups.appendChild(group);
    }

    if (rows.length === 0) {
      els.groups.innerHTML = '<p style="text-align:center;color:#888;padding:32px;">没有可用的表（请检查 filelist.json）</p>';
    } else if (shown.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-tip';
      p.textContent = `没有匹配「${els.search.value.trim()}」的配置表`;
      els.groups.appendChild(p);
    }
  }

  // 把文本写进元素，命中关键词的片段用 <mark> 包起来
  function setHighlighted(el, text) {
    el.textContent = '';
    for (const part of TableSearch.splitHighlight(text, searchTerms)) {
      if (part.hit) {
        const m = document.createElement('mark');
        m.textContent = part.text;
        el.appendChild(m);
      } else {
        el.appendChild(document.createTextNode(part.text));
      }
    }
  }

  function renderRow(row) {
    const div = document.createElement('div');
    const isError = row.status === 'error';
    const rowClickable = !isError;
    const showButton = !isError;
    div.className = `row status-${row.status}${rowClickable ? ' clickable' : ''}`;
    div.dataset.path = row.path;
    if (rowClickable) div.addEventListener('click', () => { if (!busyPaths.has(row.path)) syncOne(row.path); });

    const iconCell = document.createElement('span');
    iconCell.className = 'icon';
    iconCell.textContent = STATUS_LABELS[row.status].icon;

    const nameDiv = document.createElement('div');
    nameDiv.className = 'name';
    setHighlighted(nameDiv, row.name);
    nameDiv.title = row.path;
    // 搜索命中的是路径（表名里没有）时，把路径也显示出来，免得看不出为什么命中
    if (searchTerms.length && !TableSearch.matchRow({ name: row.name, cloudName: row.cloudName || row.description }, searchTerms)) {
      const pathSpan = document.createElement('span');
      pathSpan.className = 'row-path';
      setHighlighted(pathSpan, row.path);
      nameDiv.appendChild(pathSpan);
    }
    // 备注行显示云端表名，并直接作为跳转云端表的入口
    const metaDiv = document.createElement('div');
    metaDiv.className = 'meta';
    const label = row.cloudName || row.description || '';
    if (row.spreadsheetId && label) {
      const link = document.createElement('a');
      link.className = 'sheet-link';
      link.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(row.spreadsheetId)}/edit`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      setHighlighted(link, label);
      link.title = '在新标签页打开云端配置表';
      link.addEventListener('click', e => e.stopPropagation());
      metaDiv.appendChild(link);
    } else {
      setHighlighted(metaDiv, label);
    }
    const nameCell = document.createElement('div');
    nameCell.append(nameDiv, metaDiv);

    const cloudCell = document.createElement('div');
    cloudCell.className = 'meta';
    cloudCell.textContent = row.cloudModifiedTime ? `云端: ${formatTime(row.cloudModifiedTime)}` : '—';

    const localCell = document.createElement('div');
    localCell.className = 'meta';
    if (row.error) {
      localCell.textContent = `错误: ${row.error}`;
    } else if (row.lastSyncedModifiedTime) {
      localCell.textContent = `本地: ${formatTime(row.lastSyncedModifiedTime)}`;
    } else {
      localCell.textContent = '本地: —';
    }

    div.appendChild(iconCell);
    div.appendChild(nameCell);
    div.appendChild(cloudCell);
    div.appendChild(localCell);

    const actionCell = document.createElement('div');
    actionCell.className = 'action-cell';
    const stateEl = document.createElement('span');
    stateEl.className = 'row-state';
    if (showButton) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-btn';
      btn.textContent = '下载';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        syncOne(row.path);
      });
      actionCell.appendChild(btn);

      if (appConfig.allowUpload) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'row-btn upload-btn';
      upBtn.textContent = '上传';
      upBtn.title = '用本地 xlsx 覆盖云端该表';
      upBtn.addEventListener('click', e => {
        e.stopPropagation();
        pickAndUpload(row);
      });
      actionCell.appendChild(upBtn);
      }
    }
    actionCell.appendChild(stateEl);
    div.appendChild(actionCell);
    if (busyPaths.has(row.path)) applyRowBusy(div, true, busyPaths.get(row.path));

    return div;
  }

  async function loadTables() {
    try {
      const resp = await fetch(api('/tables'));
      if (resp.status === 401) {
        els.authBanner.classList.remove('hidden');
        els.summary.textContent = '请先授权';
        return;
      }
      els.authBanner.classList.add('hidden');
      const data = await resp.json();
      if (resp.ok) render(data);
      else appendLog(`! /api/tables error: ${data.error}\n`);
    } catch (err) {
      appendLog(`! fetch error: ${err.message}\n`);
    }
  }

  async function refresh() {
    setBusy(true);
    appendLog('→ 刷新所有云端 modifiedTime…\n');
    try {
      const resp = await fetch(api('/refresh'), { method: 'POST' });
      if (resp.status === 401) {
        els.authBanner.classList.remove('hidden');
        appendLog('! 需要授权\n');
        return;
      }
      const data = await resp.json();
      if (resp.ok) { render(data); appendLog('✓ 刷新完成\n'); }
      else appendLog(`! refresh error: ${data.error}\n`);
    } catch (err) {
      appendLog(`! ${err.message}\n`);
    } finally {
      setBusy(false);
    }
  }

  function streamSync(paths) {
    // 本批所有表先标「排队中」，轮到谁再切换为「下载中」
    paths.forEach(p => { if (!busyPaths.has(p)) setRowBusy(p, true, '排队中…'); });
    return new Promise((resolve) => {
      fetch(api('/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths })
      }).then(async response => {
        if (response.status === 401) {
          els.authBanner.classList.remove('hidden');
          appendLog('! 需要授权\n');
          resolve();
          return;
        }
        if (!response.ok) {
          appendLog(`! /api/sync HTTP ${response.status}\n`);
          resolve();
          return;
        }
        await consumeSSE(response, resolve);
      }).catch(err => {
        appendLog(`! ${err.message}\n`);
        resolve();
      });
    });
  }

  async function consumeSSE(response, onComplete) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const block of parts) {
        const evMatch = /^event:\s*(.+)$/m.exec(block);
        const dataMatch = /^data:\s*([\s\S]+)$/m.exec(block);
        if (!evMatch || !dataMatch) continue;
        const event = evMatch[1].trim();
        const data = dataMatch[1].trim();
        handleSseEvent(event, data);
      }
    }
    onComplete();
  }

  function handleSseEvent(event, data) {
    if (event === 'log') {
      appendLog(data);
      if (!data.endsWith('\n')) appendLog('\n');
    } else if (event === 'progress') {
      // optional: render progress bar
    } else if (event === 'table-start') {
      try { setRowBusy(JSON.parse(data).path, true, '下载中…'); } catch (_) {}
    } else if (event === 'table-done') {
      try {
        const obj = JSON.parse(data);
        setRowBusy(obj.path, false);
        appendLog(obj.success ? `✓ ${obj.path}\n` : `✗ ${obj.path}${obj.error ? ': ' + obj.error : ''}\n`);
      } catch (_) {}
    } else if (event === 'done') {
      try {
        const obj = JSON.parse(data);
        appendLog(`\n=== done: success=${obj.successCount ?? 'n/a'} failed=${obj.failedCount ?? 'n/a'} exit=${obj.exitCode ?? '—'} ===\n`);
      } catch (_) {}
    } else if (event === 'error') {
      try {
        const obj = JSON.parse(data);
        appendLog(`! ${obj.message}\n`);
      } catch (_) {}
    }
  }

  async function pickAndUpload(row) {
    if (!confirm(`确定用本地文件覆盖云端表「${row.name}」吗？\n\n云端现有内容将被替换，此操作不可撤销（可在 Google 表格版本历史中恢复）。`)) return;
    await uploadOne(row);
  }

  async function uploadOne(row) {
    setBusy(true);
    setRowBusy(row.path, true, '上传中…');
    appendLog(`→ 上传本地 ${row.name} 覆盖云端…\n`);
    try {
      const resp = await fetch(api(`/upload?path=${encodeURIComponent(row.path)}`), {
        method: 'POST'
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) {
        els.authBanner.classList.remove('hidden');
        appendLog('! 需要授权\n');
      } else if (resp.status === 403 && data.error === 'NEED_UPLOAD_SCOPE') {
        appendLog('! 当前授权不含写权限，请重新授权后再上传\n');
        if (confirm('当前 Google 授权只有只读权限，需要重新授权才能上传。现在去授权吗？')) location.href = '/auth/start';
      } else if (resp.ok) {
        appendLog(`✓ 已覆盖云端 ${row.name}（云端修改时间 ${formatTime(data.modifiedTime)}）\n`);
        await loadTables();
      } else {
        appendLog(`✗ 上传失败: ${data.error || resp.status}\n`);
      }
    } catch (err) {
      appendLog(`! ${err.message}\n`);
    } finally {
      setRowBusy(row.path, false);
      setBusy(false);
    }
  }

  async function syncOne(p) {
    setBusy(true);
    await streamSync([p]);
    releaseRows([p]);
    await loadTables();
    setBusy(false);
  }

  async function syncAllUpdated() {
    setBusy(true);
    const resp = await fetch(api('/tables'));
    if (!resp.ok) { appendLog('! 无法获取列表\n'); setBusy(false); return; }
    const rows = await resp.json();
    const paths = rows
      .filter(r => r.status === 'updated' || r.status === 'never_synced' || r.status === 'missing_local' || r.status === 'local_changed')
      .map(r => r.path);
    if (paths.length === 0) {
      appendLog('（没有需要同步的表）\n');
      setBusy(false);
      return;
    }
    await streamSync(paths);
    releaseRows(paths);
    await loadTables();
    setBusy(false);
  }

  async function clearState() {
    if (!confirm('确定要清除本地同步缓存吗？\n\n所有表将变为「未同步」状态，但本地 xlsx 文件不会被删除。下次同步时会重新写入缓存。')) return;
    setBusy(true);
    try {
      const resp = await fetch(api('/clear-state'), { method: 'POST' });
      const data = await resp.json();
      if (resp.ok) {
        appendLog('✓ 已清除同步缓存\n');
        await loadTables();
      } else {
        appendLog(`! 清除缓存失败: ${data.error}\n`);
      }
    } catch (err) {
      appendLog(`! ${err.message}\n`);
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action) {
    setBusy(true);
    appendLog(`→ ${action.label}…\n`);
    try {
      const response = await fetch(api(`/action/${encodeURIComponent(action.id)}`), { method: 'POST' });
      if (!response.ok) {
        appendLog(`! action ${action.id} HTTP ${response.status}\n`);
        return;
      }
      await new Promise(resolve => consumeSSE(response, resolve));
    } finally {
      setBusy(false);
    }
  }

  async function loadConfig() {
    appConfig = { allowUpload: true, actions: [] };
    try {
      const resp = await fetch(api('/config'));
      const data = await resp.json();
      if (resp.ok) appConfig = data;
      else appendLog(`! 项目配置错误: ${data.error}\n`);
    } catch (_) { /* 用默认值 */ }
    els.customActions.innerHTML = '';
    (appConfig.actions || []).forEach(action => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => runAction(action));
      els.customActions.appendChild(b);
    });
  }

  // ---------- 多项目 ----------
  // 当前项目的信息与功能区：没有选中项目时整块隐藏
  function renderProjectPanel() {
    const p = projects.find(x => x.id === currentId);
    els.projectPanel.classList.toggle('hidden', !p);
    els.summaryBar.classList.toggle('hidden', !p);
    if (!p) return;
    els.projectName.textContent = p.name;
    els.projectDir.textContent = p.dir;
    els.projectDir.title = p.dir;
  }

  function renderTabs() {
    renderProjectPanel();
    els.projectTabs.innerHTML = '';
    projects.forEach(p => {
      const tab = document.createElement('span');
      tab.className = `project-tab${p.id === currentId ? ' active' : ''}`;
      tab.title = `${p.dir}\n双击重命名`;
      const label = document.createElement('span');
      label.textContent = p.name;
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.title = '从平台移除（不会删除任何文件）';
      close.addEventListener('click', e => { e.stopPropagation(); removeProject(p); });
      tab.append(label, close);
      tab.addEventListener('click', () => selectProject(p.id));
      tab.addEventListener('dblclick', () => renameProject(p));
      els.projectTabs.appendChild(tab);
    });
  }

  async function selectProject(id) {
    currentId = id;
    try { localStorage.setItem(PROJECT_KEY, id); } catch (_) {}
    renderTabs();
    groupExpandedState.clear();
    lastRows = null; // 换项目后不能再拿旧项目的列表做搜索
    els.groups.innerHTML = '';
    els.summary.textContent = '加载中…';
    await loadConfig();
    await loadTables();
  }

  async function loadProjects(preferId) {
    projects = await (await fetch('/api/projects')).json();
    let saved = null;
    try { saved = localStorage.getItem(PROJECT_KEY); } catch (_) {}
    const pick = [preferId, currentId, saved].find(id => id && projects.some(p => p.id === id)) || (projects[0] && projects[0].id);
    if (!pick) {
      currentId = null;
      lastRows = null;
      renderTabs();
      els.customActions.innerHTML = '';
      els.groups.innerHTML = '<p class="empty-tip">还没有项目，点右上方「＋ 添加项目」选择配置表目录</p>';
      els.summary.textContent = '';
      return;
    }
    await selectProject(pick);
  }

  async function renameProject(p) {
    const name = prompt('项目名称', p.name);
    if (name === null || !name.trim() || name.trim() === p.name) return;
    const resp = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!resp.ok) { appendLog(`! 重命名失败: ${(await resp.json()).error}\n`); return; }
    await loadProjects(currentId);
  }

  async function removeProject(p) {
    if (!confirm(`从平台移除项目「${p.name}」吗？\n\n只是不再管理它，项目目录里的文件不会被删除。`)) return;
    const resp = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (!resp.ok) { appendLog('! 移除失败\n'); return; }
    if (p.id === currentId) currentId = null;
    await loadProjects();
  }

  // ---------- 选择目录弹窗 ----------
  const dirEls = {
    modal: document.getElementById('dir-modal'),
    path: document.getElementById('dir-path'),
    list: document.getElementById('dir-list'),
    msg: document.getElementById('dir-msg'),
    pick: document.getElementById('dir-pick'),
    close: document.getElementById('dir-close'),
    native: document.getElementById('dir-native'),
    name: document.getElementById('dir-name')
  };
  let dirCurrent = null;
  const DIR_KEY = 'syncmanager.lastDir';

  async function browse(p) {
    dirEls.msg.textContent = '';
    const resp = await fetch(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`);
    const data = await resp.json();
    if (!resp.ok) { dirEls.msg.textContent = data.error; return; }
    dirCurrent = data.path;
    dirEls.path.textContent = data.path + (data.hint ? '  ★' : '');
    dirEls.list.innerHTML = '';
    const addItem = (text, target, star) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (star) { const s = document.createElement('span'); s.className = 'star'; s.textContent = '★'; li.appendChild(s); }
      li.addEventListener('click', () => browse(target));
      dirEls.list.appendChild(li);
    };
    if (data.parent) addItem('⬆ 上一级', data.parent, false);
    data.dirs.forEach(d => addItem(`📁 ${d.name}`, d.path, d.hint));
  }

  function openDirModal() {
    dirEls.modal.classList.remove('hidden');
    dirEls.name.value = '';
    let last = null;
    try { last = localStorage.getItem(DIR_KEY); } catch (_) {}
    browse(last);
  }

  async function addCurrentDir() {
    dirEls.msg.textContent = '';
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: dirCurrent, name: dirEls.name.value })
    });
    const data = await resp.json();
    if (!resp.ok) { dirEls.msg.textContent = data.error; return; }
    try { localStorage.setItem(DIR_KEY, dirCurrent); } catch (_) {}
    dirEls.modal.classList.add('hidden');
    appendLog(`✓ 已添加项目「${data.project.name}」${data.generated ? '（已自动生成 syncmanager.config.json，可按需补充导出服务与动作）' : ''}\n`);
    await loadProjects(data.project.id);
  }

  async function pickNative() {
    dirEls.msg.textContent = '';
    dirEls.native.disabled = true;
    try {
      const resp = await fetch('/api/fs/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: dirCurrent })
      });
      if (resp.status === 404) { dirEls.msg.textContent = '服务端还没有该接口，请重启 CSM 后再试（暂时可用下方列表浏览）'; return; }
      const data = await resp.json();
      if (!resp.ok) { dirEls.msg.textContent = `${data.error}，请用下方列表浏览`; return; }
      if (data.path) await browse(data.path); // 跳到所选目录，确认后点「添加此目录」
    } catch (err) {
      dirEls.msg.textContent = err.message;
    } finally {
      dirEls.native.disabled = false;
    }
  }

  els.btnAddProject.addEventListener('click', openDirModal);
  dirEls.native.addEventListener('click', pickNative);
  dirEls.close.addEventListener('click', () => dirEls.modal.classList.add('hidden'));
  dirEls.pick.addEventListener('click', addCurrentDir);

  els.btnRefresh.addEventListener('click', refresh);
  els.btnSyncAll.addEventListener('click', syncAllUpdated);
  els.btnClearState.addEventListener('click', clearState);
  els.btnClearLog.addEventListener('click', () => { els.log.textContent = ''; });

  // 供 filelist-manager.js 使用
  window.CSM = {
    api,
    currentId: () => currentId,
    reloadTables: () => loadTables(),
    appendLog,
    showAuthBanner: () => els.authBanner.classList.remove('hidden')
  };

  // ---------- 配置表搜索 ----------
  els.search.addEventListener('input', () => {
    searchTerms = TableSearch.parseQuery(els.search.value);
    render();
  });
  els.search.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      els.search.value = '';
      searchTerms = [];
      render();
      els.search.blur();
    } else if (e.key === 'Enter') {
      // 回车：只命中一个表时直接下载它
      const hits = (lastRows || []).filter(r => TableSearch.matchRow(r, searchTerms));
      if (searchTerms.length && hits.length === 1 && hits[0].status !== 'error' && !busyPaths.has(hits[0].path)) syncOne(hits[0].path);
    }
  });
  // ⌘F / Ctrl+F 或 / 聚焦搜索框（弹窗打开时不抢焦点）
  document.addEventListener('keydown', e => {
    if (document.querySelector('.modal:not(.hidden)')) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
    if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
    }
  });

  // 还没有项目时也提示授权（桌面 App 不会像命令行那样启动即打开授权页）
  fetch('/api/auth-status').then(r => r.json()).then(s => {
    if (!s.authorized) els.authBanner.classList.remove('hidden');
  }).catch(() => {});

  loadProjects();
})();
