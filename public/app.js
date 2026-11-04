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
  let appConfig = { allowUpload: true, syncButtonLabel: '同步', actions: [] };
  const DEFAULT_COLLAPSED = new Set(['synced', 'local_changed']);
  // Tracks each group's expanded/collapsed state across re-renders (render() rebuilds the DOM from scratch).
  // Populated lazily from DEFAULT_COLLAPSED the first time a group is seen, then mutated by user clicks.
  const groupExpandedState = new Map();

  let currentId = null;
  let projects = [];
  const api = p => `/api/p/${encodeURIComponent(currentId)}${p}`;
  const PROJECT_KEY = 'syncmanager.currentProject';

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
    authBanner: document.getElementById('auth-banner')
  };

  function formatTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return iso; }
  }

  function appendLog(text) {
    els.log.textContent += text;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function setBusy(busy) {
    [els.btnRefresh, els.btnSyncAll, els.btnClearState, ...els.customActions.querySelectorAll('button')].forEach(b => { b.disabled = busy; });
  }

  function render(rows) {
    const counts = { error: 0, missing_local: 0, local_changed: 0, never_synced: 0, updated: 0, synced: 0 };
    const buckets = { error: [], missing_local: [], local_changed: [], never_synced: [], updated: [], synced: [] };
    rows.forEach(r => { counts[r.status]++; buckets[r.status].push(r); });

    els.summary.textContent =
      `${rows.length} 个表 | 有更新 ${counts.updated} | 未同步 ${counts.never_synced} | 本地缺失 ${counts.missing_local} | 本地变更 ${counts.local_changed} | 已同步 ${counts.synced} | 错误 ${counts.error}`;

    els.groups.innerHTML = '';
    for (const key of GROUP_ORDER) {
      const list = buckets[key];
      if (list.length === 0) continue;
      if (!groupExpandedState.has(key)) {
        groupExpandedState.set(key, !DEFAULT_COLLAPSED.has(key));
      }
      const expanded = groupExpandedState.get(key);
      const group = document.createElement('section');
      group.className = `group ${expanded ? 'expanded' : ''}`;
      const header = document.createElement('header');
      header.className = 'group-header';
      header.textContent = `${STATUS_LABELS[key].label}（${list.length}）`;
      header.addEventListener('click', () => {
        const nowExpanded = group.classList.toggle('expanded');
        groupExpandedState.set(key, nowExpanded);
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
    }
  }

  function renderRow(row) {
    const div = document.createElement('div');
    const isError = row.status === 'error';
    const rowClickable = !isError;
    const showButton = !isError;
    div.className = `row status-${row.status}${rowClickable ? ' clickable' : ''}`;
    if (rowClickable) div.addEventListener('click', () => syncOne(row.path));

    const iconCell = document.createElement('span');
    iconCell.className = 'icon';
    iconCell.textContent = STATUS_LABELS[row.status].icon;

    const nameCell = document.createElement('div');
    nameCell.innerHTML = `<div class="name">${row.name}</div><div class="meta">${row.description || ''}</div>`;

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
    if (showButton) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-btn';
      btn.textContent = appConfig.syncButtonLabel;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        syncAndGenOne(row.path);
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
    div.appendChild(actionCell);

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

  function streamSync(paths, runAfterSync) {
    return new Promise((resolve) => {
      fetch(api('/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, runAfterSync })
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
    } else if (event === 'table-done') {
      try {
        const obj = JSON.parse(data);
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
      setBusy(false);
    }
  }

  async function syncOne(p) {
    setBusy(true);
    await streamSync([p], false);
    await loadTables();
    setBusy(false);
  }

  async function syncAndGenOne(p) {
    setBusy(true);
    await streamSync([p], true);
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
    await streamSync(paths, true);
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
    appConfig = { allowUpload: true, syncButtonLabel: '同步', actions: [] };
    try {
      const resp = await fetch(api('/config'));
      const data = await resp.json();
      if (resp.ok) appConfig = data;
      else appendLog(`! 项目配置错误: ${data.error}\n`);
    } catch (_) { /* 用默认值 */ }
    els.customActions.innerHTML = '';
    appConfig.actions.forEach(action => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => runAction(action));
      els.customActions.appendChild(b);
    });
  }

  // ---------- 多项目 ----------
  function renderTabs() {
    els.projectTabs.innerHTML = '';
    projects.forEach(p => {
      const tab = document.createElement('span');
      tab.className = `project-tab${p.id === currentId ? ' active' : ''}`;
      tab.title = p.dir;
      const label = document.createElement('span');
      label.textContent = p.name;
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.title = '从平台移除（不会删除任何文件）';
      close.addEventListener('click', e => { e.stopPropagation(); removeProject(p); });
      tab.append(label, close);
      tab.addEventListener('click', () => selectProject(p.id));
      els.projectTabs.appendChild(tab);
    });
  }

  async function selectProject(id) {
    currentId = id;
    try { localStorage.setItem(PROJECT_KEY, id); } catch (_) {}
    renderTabs();
    groupExpandedState.clear();
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
      renderTabs();
      els.customActions.innerHTML = '';
      els.groups.innerHTML = '<p class="empty-tip">还没有项目，点右上方「＋ 添加项目」选择配置表目录</p>';
      els.summary.textContent = '';
      return;
    }
    await selectProject(pick);
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
    close: document.getElementById('dir-close')
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
    let last = null;
    try { last = localStorage.getItem(DIR_KEY); } catch (_) {}
    browse(last);
  }

  async function addCurrentDir() {
    dirEls.msg.textContent = '';
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: dirCurrent })
    });
    const data = await resp.json();
    if (!resp.ok) { dirEls.msg.textContent = data.error; return; }
    try { localStorage.setItem(DIR_KEY, dirCurrent); } catch (_) {}
    dirEls.modal.classList.add('hidden');
    appendLog(`✓ 已添加项目「${data.project.name}」${data.generated ? '（已自动生成 syncmanager.config.json，可按需补充导出服务与动作）' : ''}\n`);
    await loadProjects(data.project.id);
  }

  els.btnAddProject.addEventListener('click', openDirModal);
  dirEls.close.addEventListener('click', () => dirEls.modal.classList.add('hidden'));
  dirEls.pick.addEventListener('click', addCurrentDir);

  els.btnRefresh.addEventListener('click', refresh);
  els.btnSyncAll.addEventListener('click', syncAllUpdated);
  els.btnClearState.addEventListener('click', clearState);
  els.btnClearLog.addEventListener('click', () => { els.log.textContent = ''; });

  loadProjects();
})();
