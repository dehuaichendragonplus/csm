(function () {
  'use strict';

  const STATUS_LABELS = {
    conflict: { label: '冲突（两边都改过）', icon: '⚠' },
    error: { label: '错误', icon: '✖' },
    missing_local: { label: '本地缺失', icon: '⊘' },
    local_changed: { label: '本地变更', icon: '⟲' },
    never_synced: { label: '需核对（无同步记录）', icon: '✚' },
    updated: { label: '有更新', icon: '⚡' },
    synced: { label: '已同步', icon: '●' }
  };

  const GROUP_ORDER = ['conflict', 'updated', 'never_synced', 'missing_local', 'local_changed', 'error', 'synced'];
  // 由 /api/config 填充：标题、是否允许上传、同步后动作名、自定义动作按钮
  let appConfig = { allowUpload: true, actions: [] };
  const DEFAULT_COLLAPSED = new Set(['synced', 'local_changed']);
  // 两边内容可能不一致、值得看差异的状态
  const verifyFailures = new Map();
  const verifyRuns = new Map(); // 各项目正在核对的路径和请求
  const DIFF_STATUSES = new Set(['conflict', 'updated', 'never_synced', 'local_changed']);
  // Tracks each group's expanded/collapsed state across re-renders (render() rebuilds the DOM from scratch).
  // Populated lazily from DEFAULT_COLLAPSED the first time a group is seen, then mutated by user clicks.
  const groupExpandedState = new Map();

  let currentId = null;
  let projects = [];
  const api = (p, projId = currentId) => `/api/p/${encodeURIComponent(projId)}${p}`;
  const PROJECT_KEY = 'syncmanager.currentProject';

  // ---------- 项目状态汇总与 Dock / Tab 角标 ----------
  const projectSummaries = new Map(); // id -> { pending, updated, conflict, missing, neverSynced, total }

  function updateDockBadge(count) {
    const num = parseInt(count, 10) || 0;
    // 1. Electron IPC 原生设置 Dock Badge
    if (window.electronBridge && typeof window.electronBridge.setBadge === 'function') {
      try { window.electronBridge.setBadge(num); } catch (_) {}
    }
    // 2. 本地服务 API 兜底
    fetch('/api/badge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: num })
    }).catch(() => {});
    // 3. 浏览器标签页标题同步更新角标
    const baseTitle = 'CSM';
    document.title = num > 0 ? `(${num > 99 ? '99+' : num}) ${baseTitle}` : baseTitle;
  }

  function updateTabBadges() {
    let totalPending = 0;
    projects.forEach(p => {
      const summary = projectSummaries.get(p.id);
      const badgeEl = document.getElementById(`tab-badge-${p.id}`);
      const pending = summary ? (summary.pending || 0) : 0;
      totalPending += pending;
      if (!badgeEl) return;

      if (pending > 0) {
        badgeEl.textContent = pending > 99 ? '99+' : String(pending);
        badgeEl.dataset.count = String(pending);
        if (summary.conflict > 0) {
          badgeEl.className = 'tab-badge tab-badge-conflict';
          badgeEl.title = `${summary.conflict} 张冲突，共 ${pending} 张待处理`;
        } else if (summary.updated > 0) {
          badgeEl.className = 'tab-badge tab-badge-updated';
          badgeEl.title = `${summary.updated} 张云端有更新，共 ${pending} 张待处理`;
        } else {
          badgeEl.className = 'tab-badge tab-badge-pending';
          badgeEl.title = `${pending} 张待处理`;
        }
      } else {
        badgeEl.textContent = '';
        badgeEl.dataset.count = '0';
        badgeEl.className = 'tab-badge';
        badgeEl.removeAttribute('title');
      }
    });

    updateDockBadge(totalPending);
  }

  async function refreshProjectBadges() {
    try {
      const resp = await fetch('/api/projects-summary');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && Array.isArray(data.projects)) {
        data.projects.forEach(p => {
          // 当前活跃项目若已有实时数据，保持实时数据不被旧缓存覆盖
          if (p.id === currentId && lastRows && lastRows.length > 0) return;
          projectSummaries.set(p.id, {
            pending: p.pending || 0,
            updated: p.updated || 0,
            conflict: p.conflict || 0,
            missing: p.missing || 0,
            neverSynced: p.neverSynced || 0,
            total: p.total || 0
          });
        });
        updateTabBadges();
      }
    } catch (_) {}
  }

  async function sendBannerNotification({ title, body }) {
    // 1. Electron IPC 原生通知
    if (window.electronBridge && typeof window.electronBridge.showNotification === 'function') {
      try {
        const ok = await window.electronBridge.showNotification({ title, body });
        if (ok) return true;
      } catch (_) {}
    }
    // 2. 本地服务 API 代理通知
    try {
      const resp = await fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.shown) return true;
      }
    } catch (_) {}
    // 3. 浏览器 HTML5 Notification 兜底
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body, tag: `csm-${Date.now()}` });
        n.onclick = () => { window.focus(); n.close(); };
        return true;
      } catch (_) {}
    }
    return false;
  }

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
    appLogo: document.getElementById('app-logo'),
    projectTabs: document.getElementById('project-tabs'),
    btnAddProject: document.getElementById('btn-add-project'),
    summary: document.getElementById('summary'),
    groups: document.getElementById('groups'),
    selection: document.getElementById('selection-bar'),
    selectVisible: document.getElementById('select-visible-downloads'),
    selectionCount: document.getElementById('selection-count'),
    viewSelection: document.getElementById('view-selection'),
    batchConfirm: document.getElementById('batch-confirm'),
    batchConfirmScope: document.getElementById('batch-confirm-scope'),
    batchConfirmExport: document.getElementById('batch-confirm-export'),
    batchConfirmItems: document.getElementById('batch-confirm-items'),
    batchConfirmSubmit: document.getElementById('batch-confirm-submit'),
    clearSelection: document.getElementById('clear-selection'),
    downloadSelected: document.getElementById('download-selected'),
    batch: document.getElementById('batch-result'),
    batchTitle: document.getElementById('batch-title'),
    batchAction: document.getElementById('batch-action'),
    batchToggle: document.getElementById('batch-toggle'),
    batchItems: document.getElementById('batch-items'),
    batchRetry: document.getElementById('batch-retry'),
    batchReview: document.getElementById('batch-review'),
    batchDiagnose: document.getElementById('batch-diagnose'),
    batchCopy: document.getElementById('batch-copy'),
    log: document.getElementById('log'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnSyncAll: document.getElementById('btn-sync-all'),
    syncAllBadge: document.getElementById('sync-all-badge'),
    syncAllLabel: document.getElementById('sync-all-label'),
    syncAllIcon: document.getElementById('sync-all-icon'),
    refreshIcon: document.getElementById('refresh-icon'),
    historyIcon: document.getElementById('history-icon'),
    lubanIcon: document.getElementById('luban-icon'),
    settingsIcon: document.getElementById('settings-icon'),
    searchIcon: document.getElementById('search-icon'),
    projectDirIcon: document.getElementById('project-dir-icon'),
    projectDirBadge: document.getElementById('project-dir-badge'),
    customActions: document.getElementById('custom-actions'),
    btnLuban: document.getElementById('btn-luban'),
    btnClearState: document.getElementById('btn-clear-state'),
    btnClearLog: document.getElementById('btn-clear-log'),
    btnCopyLog: document.getElementById('btn-copy-log'),
    authBanner: document.getElementById('auth-banner'),
    projectPanel: document.getElementById('project-panel'),
    summaryBar: document.getElementById('summary-bar'),
    statusFilters: document.getElementById('status-filters'),
    projectName: document.getElementById('project-name'),
    projectDir: document.getElementById('project-dir'),
    search: document.getElementById('table-search'),
    searchClear: document.getElementById('search-clear'),
    btnHistory: document.getElementById('btn-history'),
    prefAutoRefresh: document.getElementById('pref-auto-refresh'),
    prefNotify: document.getElementById('pref-notify'),
    prefAfterWrap: document.getElementById('pref-after-wrap'),
    prefAfterDownload: document.getElementById('pref-after-download'),
    lastRefresh: document.getElementById('last-refresh'),
    cloudStatusBar: document.getElementById('cloud-status-bar'),
    retryRefresh: document.getElementById('retry-refresh'),
    firstProject: document.getElementById('first-project'),
    firstProjectAdd: document.getElementById('first-project-add'),
    tabStripProfile: document.getElementById('tab-strip-profile'),
    btnSettings: document.getElementById('btn-settings'),
    globalSettingsModal: document.getElementById('global-settings-modal'),
    globalSettingsClose: document.getElementById('global-settings-close'),
    globalSettingsDone: document.getElementById('global-settings-done'),
    globalAuthBadge: document.getElementById('global-auth-badge'),
    globalAuthDesc: document.getElementById('global-auth-desc'),
    globalAuthScope: document.getElementById('global-auth-scope'),
    globalBtnReauth: document.getElementById('global-btn-reauth'),
    globalBtnLogout: document.getElementById('global-btn-logout'),
    globalSettingsVersion: document.getElementById('global-settings-version'),
    projectSettingsModal: document.getElementById('project-settings-modal'),
    projectSettingsClose: document.getElementById('project-settings-close'),
    projectSettingsDone: document.getElementById('project-settings-done'),
    projectSettingsName: document.getElementById('project-settings-name'),
    projectSettingsNameInput: document.getElementById('project-settings-name-input'),
    projectBtnRename: document.getElementById('project-btn-rename'),
    projectSettingsDir: document.getElementById('project-settings-dir'),
    projectBtnReveal: document.getElementById('project-btn-reveal'),
    consoleDrawer: document.getElementById('console-drawer'),
    consoleBar: document.getElementById('console-bar'),
    consoleIndicator: document.getElementById('console-indicator'),
    consolePreview: document.getElementById('console-preview'),
    btnToggleLog: document.getElementById('btn-toggle-log'),
    consoleToggleText: document.getElementById('console-toggle-text'),
    allSyncedBanner: document.getElementById('all-synced-banner'),
    allSyncedMeta: document.getElementById('all-synced-meta'),
    toastContainer: document.getElementById('toast-container'),
    diagnosticCard: document.getElementById('diagnostic-card'),
    diagnosticSummary: document.getElementById('diagnostic-summary'),
    diagnosticDetails: document.getElementById('diagnostic-details'),
    diagnosticActions: document.getElementById('diagnostic-actions'),
    diagnosticBtnReveal: document.getElementById('diagnostic-btn-reveal'),
    diagnosticBtnSheet: document.getElementById('diagnostic-btn-sheet'),
    diagnosticBtnDiff: document.getElementById('diagnostic-btn-diff'),
    diagnosticClose: document.getElementById('diagnostic-close')
  };

  // Populate static icons
  if (window.CSMIcons) {
    if (els.appLogo) els.appLogo.innerHTML = window.CSMIcons.logo;
    if (els.refreshIcon) els.refreshIcon.innerHTML = window.CSMIcons.refresh;
    if (els.historyIcon) els.historyIcon.innerHTML = window.CSMIcons.history;
    if (els.lubanIcon) els.lubanIcon.innerHTML = window.CSMIcons.terminal;
    if (els.settingsIcon) els.settingsIcon.innerHTML = window.CSMIcons.settings;
    if (els.searchIcon) els.searchIcon.innerHTML = window.CSMIcons.search;
    if (els.projectDirIcon) els.projectDirIcon.innerHTML = window.CSMIcons.folder;
    if (els.syncAllIcon) els.syncAllIcon.innerHTML = window.CSMIcons.downloadAll;
  }

  // Electron environment detection for macOS titlebar padding
  if (navigator.userAgent.includes('Electron')) {
    document.documentElement.classList.add('is-electron');
    if (/Macintosh|Mac OS X/i.test(navigator.userAgent)) {
      document.documentElement.classList.add('is-mac-electron');
    }
  }

  // Navigation buttons for switching projects (< and >)
  const btnPrev = document.getElementById('btn-nav-prev');
  const btnNext = document.getElementById('btn-nav-next');
  if (btnPrev && btnNext) {
    btnPrev.addEventListener('click', () => {
      const idx = projects.findIndex(p => p.id === currentId);
      if (idx > 0) selectProject(projects[idx - 1].id);
    });
    btnNext.addEventListener('click', () => {
      const idx = projects.findIndex(p => p.id === currentId);
      if (idx >= 0 && idx < projects.length - 1) selectProject(projects[idx + 1].id);
    });
  }

  // 快捷浮动轻提示（Toast）
  function showToast(message, type = 'info', duration = 2400) {
    if (!els.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const iconMap = {
      success: window.CSMIcons ? window.CSMIcons.check : '✓',
      error: window.CSMIcons ? window.CSMIcons.alert : '⚠',
      info: window.CSMIcons ? window.CSMIcons.terminal : 'ℹ'
    };
    toast.innerHTML = `<span class="toast-icon">${iconMap[type] || ''}</span><span class="toast-text">${message}</span>`;
    els.toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 260);
    }, duration);
  }
  window.showToast = showToast;

  // 常用配置表星标收藏系统（按当前项目持久化至 localStorage）
  const favKey = () => `csm.favorites.${currentId || 'default'}`;
  function getFavorites() {
    try {
      const raw = localStorage.getItem(favKey());
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }
  function isFavorite(path) {
    return getFavorites().includes(path);
  }
  function toggleFavorite(path) {
    const list = getFavorites();
    const idx = list.indexOf(path);
    let starred = false;
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.push(path);
      starred = true;
    }
    try {
      localStorage.setItem(favKey(), JSON.stringify(list));
    } catch (_) {}
    showToast(starred ? '已加入收藏' : '已取消收藏', 'info');
    render();
  }

  // 异常日志智能诊断
  function clearDiagnostic() {
    if (els.diagnosticCard) {
      els.diagnosticCard.classList.add('hidden');
      if (els.diagnosticSummary) els.diagnosticSummary.textContent = '';
      if (els.diagnosticDetails) els.diagnosticDetails.textContent = '';
    }
  }

  function showDiagnostic(action, diag) {
    if (!els.diagnosticCard || !diag) return;
    if (els.diagnosticSummary) els.diagnosticSummary.textContent = diag.summary || `「${action.label}」执行遇到异常`;
    if (els.diagnosticDetails) els.diagnosticDetails.textContent = diag.details || diag.rawLine || '请查看控制台日志了解详细错误';

    if (diag.filePath && els.diagnosticBtnReveal) {
      els.diagnosticBtnReveal.classList.remove('hidden');
      els.diagnosticBtnReveal.onclick = () => {
        revealLocal(diag.filePath).then(() => showToast(`已在访达中定位：${diag.filePath}`, 'info'));
      };
    } else if (els.diagnosticBtnReveal) {
      els.diagnosticBtnReveal.classList.add('hidden');
    }

    if (diag.matchedRow && diag.matchedRow.spreadsheetId && els.diagnosticBtnSheet) {
      els.diagnosticBtnSheet.classList.remove('hidden');
      els.diagnosticBtnSheet.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(diag.matchedRow.spreadsheetId)}/edit`;
    } else if (els.diagnosticBtnSheet) {
      els.diagnosticBtnSheet.classList.add('hidden');
    }

    if (diag.matchedRow && diag.matchedRow.path && els.diagnosticBtnDiff) {
      els.diagnosticBtnDiff.classList.remove('hidden');
      els.diagnosticBtnDiff.onclick = () => openDiff(diag.matchedRow.path, 'view');
    } else if (els.diagnosticBtnDiff) {
      els.diagnosticBtnDiff.classList.add('hidden');
    }

    els.diagnosticCard.classList.remove('hidden');
    if (setConsoleCollapsed) setConsoleCollapsed(false);
    showToast(`「${action.label}」未通过：${diag.summary}`, 'error', 5000);
  }

  if (els.diagnosticClose) els.diagnosticClose.addEventListener('click', clearDiagnostic);

  // 搜索：render() 记住最近一次完整列表，输入关键词时只在前端过滤重绘，不再请求服务端
  let lastRows = null;
  let searchTerms = [];
  let activeFilter = 'all';
  let visibleRows = [];
  let skippedFilter = null;
  let cloudStatus = 'loading';

  const needsReview = row => ['never_synced', 'local_changed', 'conflict'].includes(row.status);

  function formatTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return iso; }
  }

  let rawLogHistory = '';
  function appendLog(text) {
    rawLogHistory += text;
    // 语法着色：按行渲染语义化样式
    const frag = document.createDocumentFragment();
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      if (idx === lines.length - 1 && line === '') return;
      const div = document.createElement('div');
      div.className = 'log-line';
      const trimmed = line.trim();
      if (trimmed.startsWith('✓') || trimmed.includes('done: success')) {
        div.classList.add('log-success');
      } else if (trimmed.startsWith('->') || trimmed.includes('downloading') || trimmed.includes('uploading')) {
        div.classList.add('log-info');
      } else if (trimmed.startsWith('!') || /error|failed/i.test(trimmed)) {
        div.classList.add('log-error');
      } else if (trimmed.startsWith('↳') || trimmed.includes('已备份')) {
        div.classList.add('log-backup');
      } else if (trimmed.startsWith('===')) {
        div.classList.add('log-summary');
      }
      div.textContent = line;
      frag.appendChild(div);
    });
    els.log.appendChild(frag);
    els.log.scrollTop = els.log.scrollHeight;

    // 更新底部控制台摘要
    if (els.consolePreview) {
      const lines = text.trim().split('\n').filter(Boolean);
      if (lines.length) {
        const last = lines[lines.length - 1].replace(/^[\s!✓→✗⚡●=]+\s*/, '');
        if (last) els.consolePreview.textContent = last;
      }
    }
  }

  // 多个操作可并发（例如连续点了几行的下载），用计数保证全部结束后才恢复顶部按钮
  let busyCount = 0;
  const selectedDownloads = new Set();
  const expandedSummaries = new Set();
  const batches = new Map();
  let visibleDownloads = [];
  let downloadInProgress = false;
  function setBusy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    const busy = busyCount > 0;
    [els.btnRefresh, els.retryRefresh, els.btnClearState, ...els.customActions.querySelectorAll('button:not(#btn-luban)')].forEach(b => { b.disabled = busy; });
    updateLubanButton();
    els.btnSyncAll.disabled = busy || !(lastRows || []).some(row => row.direction === 'download');
    if (els.consoleIndicator) els.consoleIndicator.classList.toggle('busy', busy);
    renderSelection();
    renderBatch();
  }

  function renderFilterChips(rows, shown) {
    els.statusFilters.replaceChildren();
    const filterDefs = [
      { id: 'all', label: '全部', count: rows.length },
      { id: 'download', label: '可下载', count: rows.filter(r => r.direction === 'download').length },
      { id: 'needs_review', label: '需人工处理', count: rows.filter(needsReview).length },
      { id: 'error', label: '查询异常', count: rows.filter(r => r.status === 'error').length },
      { id: 'starred', label: '已收藏', count: rows.filter(r => isFavorite(r.path)).length },
      { id: 'synced', label: '已同步', count: rows.filter(r => r.status === 'synced').length }
    ];
    if (activeFilter === 'skipped') filterDefs.push({ id: 'skipped', label: '本批跳过', count: shown.length });

    filterDefs.forEach(def => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `filter-chip${activeFilter === def.id ? ' active' : ''}`;
      chip.setAttribute('aria-pressed', String(activeFilter === def.id));
      if (def.count && def.id === 'needs_review') chip.classList.add('has-alert');
      if (def.count && def.id === 'error') chip.classList.add('has-error');
      if (def.id === 'starred') chip.classList.add('is-starred');

      const labelSpan = document.createElement('span');
      labelSpan.textContent = def.label;
      const countSpan = document.createElement('span');
      countSpan.className = 'chip-count';
      countSpan.textContent = def.count;

      chip.append(labelSpan, countSpan);
      chip.addEventListener('click', () => {
        activeFilter = def.id;
        render();
      });
      els.statusFilters.appendChild(chip);
    });
  }

  function render(rows) {
    if (rows) lastRows = rows; else rows = lastRows;
    if (!rows) return;
    const counts = {};
    const buckets = {};
    GROUP_ORDER.forEach(k => { counts[k] = 0; buckets[k] = []; });
    rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });

    const searching = searchTerms.length > 0;
    let pool = rows;
    if (activeFilter === 'starred') {
      pool = rows.filter(r => isFavorite(r.path));
    } else if (activeFilter === 'needs_review') {
      pool = rows.filter(needsReview);
    } else if (activeFilter === 'download') {
      pool = rows.filter(r => r.direction === 'download');
    } else if (activeFilter === 'skipped') {
      pool = rows.filter(r => skippedFilter.has(r.path));
    } else if (activeFilter !== 'all') {
      pool = rows.filter(r => r.status === activeFilter);
    }

    const shown = visibleRows = searching ? pool.filter(r => TableSearch.matchRow(r, searchTerms)) : pool;
    const downloadable = new Set(rows.filter(r => r.direction === 'download').map(r => r.path));
    for (const path of selectedDownloads) if (!downloadable.has(path)) selectedDownloads.delete(path);
    visibleDownloads = shown.filter(r => r.direction === 'download').map(r => r.path);
    renderSelection();
    shown.forEach(r => { (buckets[r.status] || (buckets[r.status] = [])).push(r); });

    // 渲染快捷状态过滤按钮
    renderFilterChips(rows, shown);

    // 更新一键下载按钮状态
    const syncCount = downloadable.size;
    els.btnSyncAll.disabled = busyCount > 0 || !syncCount;
    if (els.syncAllLabel && els.syncAllBadge && els.syncAllIcon) {
      if (syncCount === 0) {
        els.btnSyncAll.classList.add('all-synced');
        els.syncAllBadge.classList.add('hidden');
        els.syncAllLabel.textContent = counts.synced === rows.length && rows.length ? '已全部同步' : '无可下载更新';
        els.syncAllIcon.innerHTML = window.CSMIcons ? window.CSMIcons.check : '✓';
      } else {
        els.btnSyncAll.classList.remove('all-synced');
        els.syncAllLabel.textContent = `下载项目内 ${syncCount} 张`;
        els.syncAllIcon.innerHTML = window.CSMIcons ? window.CSMIcons.downloadAll : '⬇';
      }
    }

    // 全同步极简健康状态看板
    if (els.allSyncedBanner) {
      if (cloudStatus === 'ready' && rows.length > 0 && counts.synced === rows.length && !searching && activeFilter === 'all') {
        els.allSyncedBanner.classList.remove('hidden');
        if (els.allSyncedMeta) {
          els.allSyncedMeta.textContent = `共 ${rows.length} 张配置表 · 全部健康最新`;
        }
      } else {
        els.allSyncedBanner.classList.add('hidden');
      }
    }

    els.summary.textContent =
      `${rows.length} 个表 | ${counts.conflict ? `⚠ 冲突 ${counts.conflict} | ` : ''}有更新 ${counts.updated} | 未同步 ${counts.never_synced} | 本地缺失 ${counts.missing_local} | 本地变更 ${counts.local_changed} | 已同步 ${counts.synced} | 错误 ${counts.error}`
      + (searching ? ` ｜ 搜索命中 ${shown.length} 个` : '');

    // 更新当前项目角标统计并同步 Dock Badge
    if (currentId) {
      const pendingCount = (counts.conflict || 0) + (counts.updated || 0) + (counts.missing_local || 0) + (counts.never_synced || 0);
      projectSummaries.set(currentId, {
        pending: pendingCount,
        updated: counts.updated || 0,
        conflict: counts.conflict || 0,
        missing: counts.missing_local || 0,
        neverSynced: counts.never_synced || 0,
        total: rows.length
      });
      updateTabBadges();
    }

    els.groups.innerHTML = '';
    let renderedCount = 0;
    for (const key of GROUP_ORDER) {
      const list = buckets[key];
      if (list.length === 0) continue;
      renderedCount += list.length;
      if (!groupExpandedState.has(key)) {
        groupExpandedState.set(key, !DEFAULT_COLLAPSED.has(key));
      }
      // 搜索或选中特定状态时一律展开
      const expanded = searching || (activeFilter !== 'all') || groupExpandedState.get(key);
      const group = document.createElement('section');
      group.className = `group ${expanded ? 'expanded' : ''}`;

      const header = document.createElement('header');
      header.className = 'group-header';

      const headerLeft = document.createElement('div');
      headerLeft.className = 'group-header-left';

      const iconSpan = document.createElement('span');
      iconSpan.className = 'status-indicator';
      iconSpan.innerHTML = window.CSMIcons ? window.CSMIcons.status[key] : STATUS_LABELS[key].icon;

      const titleSpan = document.createElement('span');
      titleSpan.textContent = STATUS_LABELS[key].label;

      const badgeSpan = document.createElement('span');
      badgeSpan.className = 'group-badge';
      badgeSpan.textContent = list.length;

      headerLeft.append(iconSpan, titleSpan, badgeSpan);

      const headerRight = document.createElement('div');
      headerRight.className = 'group-header-right';

      // 针对有更新、本地缺失、需核对分组，提供表头级快捷批量下载
      if ((key === 'updated' || key === 'missing_local' || key === 'never_synced') && list.length > 0) {
        const batchBtn = document.createElement('button');
        batchBtn.type = 'button';
        batchBtn.className = 'group-batch-btn';
        if (key === 'never_synced') {
          batchBtn.innerHTML = `${window.CSMIcons ? window.CSMIcons.download : '⬇'} <span>全部下载到本地（${list.length} 张）</span>`;
          batchBtn.title = `把「${STATUS_LABELS[key].label}」分组全部 ${list.length} 张云端表格覆盖下载到本地（下载前会自动备份本地旧文件）`;
          batchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const valid = list.filter(r => r.spreadsheetId && r.cloudModifiedTime);
            if (!valid.length) return;
            previewBatch(valid.map(r => ({ ...r, reviewed: true })), `全部需核对表（${STATUS_LABELS[key].label}）`);
          });
        } else {
          batchBtn.innerHTML = `${window.CSMIcons ? window.CSMIcons.download : '⬇'} <span>下载本组当前结果 ${list.length} 张</span>`;
          batchBtn.title = `查看「${STATUS_LABELS[key].label}」分组当前筛选内的下载范围`;
          batchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            previewBatch(list.filter(r => r.direction === 'download'), `当前结果 · ${STATUS_LABELS[key].label}`);
          });
        }
        headerRight.appendChild(batchBtn);
      }

      const chevron = document.createElement('span');
      chevron.className = 'group-chevron';
      chevron.innerHTML = window.CSMIcons ? window.CSMIcons.chevronRight : '▶';
      headerRight.appendChild(chevron);

      header.append(headerLeft, headerRight);
      header.addEventListener('click', () => {
        const nowExpanded = group.classList.toggle('expanded');
        if (!searching && activeFilter === 'all') groupExpandedState.set(key, nowExpanded);
      });
      group.appendChild(header);

      const body = document.createElement('div');
      body.className = 'group-body';

      // 表格列头
      const thead = document.createElement('div');
      thead.className = 'table-header-row';
      thead.innerHTML = `
        <span class="th-col th-table" title="配置表名称与本地相对路径">配置表与本地路径</span>
        <span class="th-col th-cloud" title="关联的 Google Sheets 云端表格及最后修改协作人">关联云端表 (Google Sheets)</span>
        <span class="th-col th-status" title="双端同步一致性状态与本地记录">同步状态与记录</span>
        <span class="th-col th-actions" title="操作">操作</span>
      `;
      body.appendChild(thead);

      list.forEach(row => body.appendChild(renderRow(row)));
      group.appendChild(body);
      els.groups.appendChild(group);
    }

    if (rows.length === 0) {
      els.groups.innerHTML = '<div class="empty-tip"><img src="icons/empty-illustration.svg" class="empty-illustration" alt=""><span>没有可用的表（请检查 filelist.json）</span></div>';
    } else if (renderedCount === 0) {
      const p = document.createElement('div');
      p.className = 'empty-tip';
      let msg = '当前筛选条件下没有表格';
      if (searching) {
        msg = `没有匹配「${els.search.value.trim()}」的配置表`;
      } else if (activeFilter === 'starred') {
        msg = '还没有收藏任何配置表。点击表名左侧的 ☆ 即可添加高频关注的表格';
      }
      const img = document.createElement('img');
      img.src = 'icons/empty-illustration.svg';
      img.className = 'empty-illustration';
      img.alt = '';
      const label = document.createElement('span');
      label.textContent = msg;
      p.append(img, label);
      if (searching || activeFilter !== 'all') {
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = '清除搜索与筛选';
        reset.addEventListener('click', () => {
          els.search.value = '';
          searchTerms = [];
          activeFilter = 'all';
          render();
          els.search.focus();
        });
        p.appendChild(reset);
      }
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
    // 按钮与配置表清单同一套规则：已同步不显示；云端较新（或本地缺失）显示「下载」，本地较新显示「上传」
    const canSelect = row.direction === 'download';
    const timesTip = `云端修改：${formatTime(row.cloudModifiedTime)}\n本地文件修改：${row.localMtime ? formatTime(row.localMtime) : '本地没有文件'}`;
    div.className = `row status-${row.status}${canSelect ? ' clickable' : ''}`;
    div.dataset.path = row.path;
    if (canSelect) div.addEventListener('click', e => {
      if (busyCount || e.target.closest('button, input, a, label')) return;
      const checkbox = div.querySelector('.row-select');
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });

    // 1. 配置表与本地路径 (Column 1)
    const tableCol = document.createElement('div');
    tableCol.className = 'table-cell col-table';

    const tableMain = document.createElement('div');
    tableMain.className = 'cell-main-line table-main-line';

    const isFav = isFavorite(row.path);
    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = `row-star-btn${isFav ? ' starred' : ''}`;
    starBtn.innerHTML = isFav ? '★' : '☆';
    starBtn.title = isFav ? '取消收藏' : '添加收藏（关注高频表）';
    starBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleFavorite(row.path);
    });

    const nameDiv = document.createElement('span');
    nameDiv.className = 'table-name';
    setHighlighted(nameDiv, row.name);

    if (canSelect) {
      const select = document.createElement('input');
      select.type = 'checkbox';
      select.className = 'row-select';
      select.checked = selectedDownloads.has(row.path);
      select.disabled = busyCount > 0;
      select.setAttribute('aria-label', `选择下载 ${row.name || row.path}`);
      select.addEventListener('click', e => e.stopPropagation());
      select.addEventListener('change', () => {
        if (select.checked) selectedDownloads.add(row.path);
        else selectedDownloads.delete(row.path);
        renderSelection();
      });
      tableMain.appendChild(select);
    }
    tableMain.append(starBtn, nameDiv);

    const tableSub = document.createElement('div');
    tableSub.className = 'cell-sub-line table-sub-line';

    const pathSpan = document.createElement('span');
    pathSpan.className = 'table-path';
    setHighlighted(pathSpan, row.path);

    tableSub.appendChild(pathSpan);
    tableCol.append(tableMain, tableSub);
    if (row.changeSummary || VERIFY_STATUSES.has(row.status)) appendChangeSummary(tableCol, row);

    // 2. 关联云端表与最后修改人 (Column 2)
    const cloudCol = document.createElement('div');
    cloudCol.className = 'table-cell col-cloud';

    const cloudMain = document.createElement('div');
    cloudMain.className = 'cell-main-line cloud-main-line';

    const cloudLabel = row.cloudName || row.description || row.name || '';
    if (row.spreadsheetId && cloudLabel) {
      const link = document.createElement('a');
      link.className = 'cloud-sheet-link';
      link.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(row.spreadsheetId)}/edit`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';

      const icon = document.createElement('span');
      icon.className = 'sheet-icon';
      icon.innerHTML = window.CSMIcons ? window.CSMIcons.sheet : '📄';

      const textSpan = document.createElement('span');
      textSpan.className = 'sheet-name-text';
      setHighlighted(textSpan, cloudLabel);

      const ext = document.createElement('span');
      ext.className = 'sheet-ext-icon';
      ext.innerHTML = window.CSMIcons ? window.CSMIcons.external : '↗';

      link.append(icon, textSpan, ext);
      link.title = '在新标签页打开 Google 表格';
      link.addEventListener('click', e => e.stopPropagation());
      cloudMain.appendChild(link);
    } else if (cloudLabel) {
      setHighlighted(cloudMain, cloudLabel);
    } else {
      cloudMain.innerHTML = '<span class="cell-empty-text">未关联云端表</span>';
    }

    const cloudSub = document.createElement('div');
    cloudSub.className = 'cell-sub-line cloud-sub-info';
    if (row.cloudModifiedBy) {
      const userTag = document.createElement('span');
      userTag.className = 'user-tag';
      userTag.textContent = `@${row.cloudModifiedBy}`;
      cloudSub.appendChild(userTag);

      const timeSpan = document.createElement('span');
      timeSpan.className = 'time-text';
      timeSpan.textContent = ` · ${formatTime(row.cloudModifiedTime)}`;
      cloudSub.appendChild(timeSpan);
    } else if (row.cloudModifiedTime) {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'time-text';
      timeSpan.textContent = `云端修改：${formatTime(row.cloudModifiedTime)}`;
      cloudSub.appendChild(timeSpan);
    } else {
      cloudSub.innerHTML = '<span class="cell-empty-text">—</span>';
    }

    cloudCol.append(cloudMain, cloudSub);

    // 3. 同步状态与本地记录 (Column 3)
    const statusCol = document.createElement('div');
    statusCol.className = 'table-cell col-status';

    const statusMain = document.createElement('div');
    statusMain.className = 'cell-main-line status-main-line';

    const statusPill = document.createElement('span');
    statusPill.className = `status-pill status-pill-${row.status}`;
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    const statusText = document.createElement('span');
    statusText.textContent = STATUS_LABELS[row.status] ? STATUS_LABELS[row.status].label : row.status;
    statusPill.append(dot, statusText);
    statusPill.title = timesTip;
    statusMain.appendChild(statusPill);

    const statusSub = document.createElement('div');
    statusSub.className = 'cell-sub-line status-sub-info';
    if (row.error) {
      statusSub.innerHTML = `<span class="status-error-text" title="${row.error}">错误: ${row.error}</span>`;
    } else if (row.status === 'synced') {
      statusSub.textContent = '本地与云端一致';
    } else if (row.status === 'updated') {
      statusSub.textContent = '云端时间较新 · 可覆盖下载';
    } else if (row.status === 'conflict') {
      statusSub.textContent = '双端均被修改 · 请核对差异';
    } else if (row.status === 'local_changed') {
      statusSub.textContent = '本地文件有修改 · 可预览后回写';
    } else if (row.status === 'missing_local') {
      statusSub.textContent = '本地文件缺失 · 需从云端下载';
    } else {
      statusSub.textContent = row.localExists ? '本地文件存在' : '本地文件缺失';
    }

    statusCol.append(statusMain, statusSub);

    div.appendChild(tableCol);
    div.appendChild(cloudCol);
    div.appendChild(statusCol);

    const actionCell = document.createElement('div');
    actionCell.className = 'action-cell';

    const stateEl = document.createElement('span');
    stateEl.className = 'row-state';
    if (verifyRuns.get(currentId)?.paths.has(row.path)) {
      div.classList.add('row-verifying');
      stateEl.textContent = '核对中…';
      stateEl.title = '云端修改时间变了：正在导出云端内容与本地逐单元格比较，内容一致会自动标为已同步';
    }

    // 核心行动：常驻展示
    const primaryActions = document.createElement('div');
    primaryActions.className = 'primary-actions';

    if (row.direction === 'download') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-btn';
      btn.innerHTML = `${window.CSMIcons ? window.CSMIcons.download : '⬇'} <span>下载到本地</span>`;
      btn.title = `云端较新：用云端表覆盖本地 xlsx\n${timesTip}`;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        syncOne(row);
      });
      primaryActions.appendChild(btn);
    } else if (row.direction === 'upload' && appConfig.allowUpload) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'row-btn upload-btn';
      upBtn.innerHTML = `${window.CSMIcons ? window.CSMIcons.upload : '⬆'} <span>上传</span>`;
      upBtn.title = `本地较新：先预览差异，确认后用本地 xlsx 覆盖云端表\n${timesTip}`;
      upBtn.addEventListener('click', e => {
        e.stopPropagation();
        openDiff(row.path, 'upload');
      });
      primaryActions.appendChild(upBtn);
    } else if (row.direction === 'conflict' || row.direction === 'review') {
      const cfBtn = document.createElement('button');
      cfBtn.type = 'button';
      cfBtn.className = 'row-btn conflict-btn';
      const review = row.direction === 'review';
      cfBtn.innerHTML = `${window.CSMIcons ? window.CSMIcons.alert : '⚠'} <span>${review ? '核对差异' : '解决冲突'}</span>`;
      cfBtn.title = review ? '没有同步记录。核对差异后选择保留哪一边' : `上次同步后云端和本地都改过，不能自动决定方向。\n查看差异后选择保留哪一边。\n${timesTip}`;
      cfBtn.addEventListener('click', e => {
        e.stopPropagation();
        openDiff(row.path, row.direction);
      });
      primaryActions.appendChild(cfBtn);
    }

    // 辅助动作组：静默收敛，悬停当前行时平滑浮现（类似 GitHub/Linear）
    const secondaryActions = document.createElement('div');
    secondaryActions.className = 'secondary-actions';

    // 差异入口：只给两边可能不一致的行（已同步 / 本地缺失 / 出错的行不显示）
    if (row.spreadsheetId && DIFF_STATUSES.has(row.status)) {
      const diffBtn = document.createElement('button');
      diffBtn.type = 'button';
      diffBtn.className = 'row-icon-btn';
      diffBtn.innerHTML = window.CSMIcons ? window.CSMIcons.diff : '⇄';
      diffBtn.title = '比较本地与云端的差异（逐单元格）';
      diffBtn.addEventListener('click', e => { e.stopPropagation(); openDiff(row.path, 'view'); });
      secondaryActions.appendChild(diffBtn);
    }

    const bkBtn = document.createElement('button');
    bkBtn.type = 'button';
    bkBtn.className = 'row-icon-btn';
    bkBtn.innerHTML = window.CSMIcons ? window.CSMIcons.history : '🕘';
    bkBtn.title = '本地备份（下载覆盖前自动保存，可恢复）';
    bkBtn.addEventListener('click', e => { e.stopPropagation(); window.CSMPanels && window.CSMPanels.openBackups(row); });
    secondaryActions.appendChild(bkBtn);

    const folderBtn = document.createElement('button');
    folderBtn.type = 'button';
    folderBtn.className = 'row-icon-btn';
    folderBtn.innerHTML = window.CSMIcons ? window.CSMIcons.folder : '📁';
    folderBtn.title = '在访达中显示本地文件';
    folderBtn.addEventListener('click', e => {
      e.stopPropagation();
      revealLocal(row.path).then(res => {
        if (res) showToast(`已在访达中定位: ${row.name || row.path}`, 'info');
      });
    });
    secondaryActions.appendChild(folderBtn);

    actionCell.append(stateEl, secondaryActions, primaryActions);
    div.appendChild(actionCell);
    if (busyPaths.has(row.path)) applyRowBusy(div, true, busyPaths.get(row.path));

    return div;
  }

  const refreshRuns = new Map();

  function setCloudStatus(status, message) {
    cloudStatus = status;
    els.lastRefresh.textContent = message;
    els.cloudStatusBar.dataset.status = status;
    els.retryRefresh.classList.toggle('hidden', status !== 'failed' && status !== 'partial');
    els.btnRefresh.classList.toggle('spinning', status === 'loading' || status === 'checking');
    if (status !== 'ready') els.allSyncedBanner.classList.add('hidden');
  }

  function showRefreshFailure(error) {
    setCloudStatus('failed', lastRows ? '检查失败 · 显示上次结果' : '检查失败 · 暂无云端状态');
    appendLog(`! 检查云端失败：${error}\n`);
  }

  function showAuthorizationRequired() {
    els.authBanner.classList.remove('hidden');
    setCloudStatus('auth', '完成 Google 授权后即可查看配置表状态');
  }

  async function loadTables() {
    const id = currentId;
    if (!id) return;
    try {
      const resp = await fetch(api('/tables'));
      const data = await resp.json();
      if (id !== currentId) return;
      if (resp.status === 401) { showAuthorizationRequired(); return; }
      if (!resp.ok) { showRefreshFailure(data.error || resp.status); return; }

      els.authBanner.classList.add('hidden');
      const stale = resp.headers.get('X-CSM-Stale');
      if (stale) {
        lastRefreshAt = Date.parse(stale) || 0;
        setCloudStatus('loading', '正在查询云端 · 显示上次结果');
        render(data);
        refresh({ force: false });
      } else {
        if (!refreshRuns.has(id)) {
          setCloudStatus('checking', '正在核对配置表内容…');
          render(data);
          verifyUpdates(data).then(verified => {
            if (id !== currentId || refreshRuns.has(id)) return;
            const rows = verified || data;
            markRefreshed(rows, false, resp.headers.get('X-CSM-Checked-At'));
            render(rows);
          });
        } else {
          render(data);
          refreshRuns.get(id)?.then(rows => {
            if (id === currentId && (cloudStatus === 'loading' || cloudStatus === 'checking')) {
              markRefreshed(rows || lastRows || data, false, resp.headers.get('X-CSM-Checked-At'));
            }
          }).catch(() => {});
        }
      }
      return data;
    } catch (err) {
      if (id === currentId) showRefreshFailure(err.message);
    }
  }

  function refresh({ force = true, notify = false } = {}) {
    const id = currentId;
    if (!id || els.batchConfirm.open) return;
    if (refreshRuns.has(id)) {
      if (force) showToast('正在查询云端，请稍候…', 'info', 1500);
      return refreshRuns.get(id);
    }
    if (force && busyCount) return;
    if (force) setBusy(true);
    setCloudStatus('loading', lastRows ? '正在查询云端 · 显示上次结果' : '正在查询云端…');
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), 45000);
    const run = (async () => {
      try {
        const resp = await fetch(api(force ? '/refresh' : '/refresh?reuse=1', id), {
          method: 'POST',
          signal: controller.signal
        });
        const data = await resp.json();
        if (id !== currentId) return data;
        if (resp.status === 401) { showAuthorizationRequired(); return data; }
        if (!resp.ok) { showRefreshFailure(data.error || resp.status); return data; }
        els.authBanner.classList.add('hidden');
        setCloudStatus('checking', '正在核对配置表内容…');
        render(data);
        const verified = await verifyUpdates(data, { force });
        if (id !== currentId) return verified || data;
        const rows = verified || data;
        markRefreshed(rows, notify, resp.headers.get('X-CSM-Checked-At'));
        render(rows);
        refreshProjectBadges();
        return rows;
      } catch (err) {
        if (id === currentId) {
          const isTimeout = err.name === 'AbortError';
          showRefreshFailure(isTimeout ? '查询云端超时，请检查网络或重试' : err.message);
        }
      } finally {
        clearTimeout(timeoutTimer);
        refreshRuns.delete(id);
        if (force) setBusy(false);
      }
    })();
    refreshRuns.set(id, run);
    return run;
  }

  function streamSync(paths, versions, onResult) {
    // 本批所有表先标「排队中」，轮到谁再切换为「下载中」
    paths.forEach(p => { if (!busyPaths.has(p)) setRowBusy(p, true, '排队中…'); });
    const summary = { successCount: 0, failedCount: 0, results: [], receivedDone: false, onResult };
    return new Promise((done) => {
      const resolve = () => done(summary);
      fetch(api('/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, versions })
      }).then(async response => {
        if (response.status === 401) {
          summary.error = '需要 Google 授权';
          els.authBanner.classList.remove('hidden');
          appendLog('! 需要授权\n');
          resolve();
          return;
        }
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          summary.error = data.error || `下载请求失败（HTTP ${response.status}）`;
          appendLog(`! ${summary.error}\n`);
          resolve();
          return;
        }
        await consumeSSE(response, resolve, summary);
      }).catch(err => {
        summary.error = `下载连接中断：${err.message}`;
        appendLog(`! ${summary.error}\n`);
        resolve();
      });
    });
  }

  async function consumeSSE(response, onComplete, summary, onLogLine) {
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
        if (event === 'log' && typeof onLogLine === 'function') onLogLine(data);
        handleSseEvent(event, data, summary);
      }
    }
    onComplete();
  }

  function handleSseEvent(event, data, summary) {
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
        if (summary?.results) summary.results.push(obj);
        summary?.onResult?.(obj);
        appendLog(obj.success ? `✓ ${obj.path}\n` : `✗ ${obj.path}${obj.error ? ': ' + obj.error : ''}\n`);
      } catch (_) {}
    } else if (event === 'done') {
      try {
        const obj = JSON.parse(data);
        if (summary) Object.assign(summary, obj, { receivedDone: true });
        appendLog(`\n=== done: success=${obj.successCount ?? 'n/a'} failed=${obj.failedCount ?? 'n/a'} exit=${obj.exitCode ?? '—'} ===\n`);
      } catch (_) {}
    } else if (event === 'error') {
      try {
        const obj = JSON.parse(data);
        appendLog(`! ${obj.message}\n`);
      } catch (_) {}
    }
  }

  // 上传请求（确认流程在差异预览里）：expect = 用户确认时看到的云端修改时间，force = 云端已变仍强制覆盖。
  // 返回 { ok, status, data }；授权类错误在这里统一提示
  async function uploadRequest(p, { expect, force } = {}) {
    const q = new URLSearchParams({ path: p });
    if (expect) q.set('expect', expect);
    if (force) q.set('force', '1');
    setBusy(true);
    setRowBusy(p, true, '上传中…');
    try {
      const resp = await fetch(api(`/upload?${q}`), { method: 'POST' });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 401) {
        els.authBanner.classList.remove('hidden');
        appendLog('! 需要授权\n');
      } else if (resp.status === 403 && data.error === 'NEED_UPLOAD_SCOPE') {
        appendLog('! 当前授权不含写权限，请重新授权后再上传\n');
        if (confirm('当前 Google 授权只有只读权限，需要重新授权才能上传。现在去授权吗？')) location.href = '/auth/start';
      } else if (resp.ok) {
        appendLog(`✓ 已用本地覆盖云端 ${p}（云端修改时间 ${formatTime(data.modifiedTime)}）\n`);
      } else if (resp.status !== 409) {
        appendLog(`✗ 上传失败: ${data.error || resp.status}\n`);
      }
      return { ok: resp.ok, status: resp.status, data };
    } catch (err) {
      appendLog(`! ${err.message}\n`);
      return { ok: false, status: 0, data: { error: err.message } };
    } finally {
      setRowBusy(p, false);
      setBusy(false);
      loadTables();
    }
  }

  function appendChangeSummary(parent, row) {
    const summary = row.changeSummary;
    const verifying = verifyRuns.get(currentId)?.paths.has(row.path);
    const line = document.createElement(summary ? 'button' : 'span');
    line.className = 'row-change-summary';
    if (!summary) {
      const failure = verifyFailures.get(row.path);
      const failed = failure && failure.cloud === row.cloudModifiedTime && failure.local === row.localVersion;
      line.textContent = verifying ? '正在核对内容…' : failed ? '内容核对失败' : '等待内容核对';
      if (failed) line.title = failure.error;
      parent.appendChild(line);
      return;
    }
    const reverse = row.direction === 'upload';
    line.type = 'button';
    line.textContent = SyncBatch.counts(summary, reverse);
    line.title = `${reverse ? '云端旧值 → 本地值' : '本地值 → 云端值'} · 核对于 ${formatTime(row.checkedAt)}`;
    line.setAttribute('aria-expanded', String(expandedSummaries.has(row.path)));
    const detail = document.createElement('div');
    detail.className = 'row-change-detail';
    const label = document.createElement('small');
    label.textContent = summary.samples.length ? `${line.title} · 部分字段变化` : line.title;
    detail.appendChild(label);
    for (const sample of summary.samples) {
      const item = document.createElement('span');
      item.textContent = SyncBatch.sampleText(sample, reverse);
      item.title = item.textContent;
      detail.appendChild(item);
    }
    detail.classList.toggle('hidden', !expandedSummaries.has(row.path));
    line.addEventListener('click', e => {
      e.stopPropagation();
      if (expandedSummaries.has(row.path)) expandedSummaries.delete(row.path);
      else expandedSummaries.add(row.path);
      line.setAttribute('aria-expanded', String(expandedSummaries.has(row.path)));
      detail.classList.toggle('hidden', !expandedSummaries.has(row.path));
    });
    detail.addEventListener('click', e => e.stopPropagation());
    parent.append(line, detail);
  }

  function renderSelection() {
    const count = selectedDownloads.size;
    const visibleCount = visibleDownloads.filter(path => selectedDownloads.has(path)).length;
    els.selection.classList.toggle('hidden', !currentId || (!count && !visibleDownloads.length));
    els.selectVisible.classList.toggle('hidden', !visibleDownloads.length);
    els.selectVisible.disabled = busyCount > 0;
    els.selectVisible.textContent = visibleCount === visibleDownloads.length ? '取消勾选当前筛选' : `勾选当前筛选的 ${visibleDownloads.length} 张`;
    els.selectionCount.textContent = count ? `已选 ${count} 张${visibleCount < count ? `（${count - visibleCount} 张在筛选范围外）` : ''}` : '';
    els.viewSelection.classList.toggle('hidden', !count);
    els.viewSelection.disabled = busyCount > 0;
    els.clearSelection.classList.toggle('hidden', !count);
    els.clearSelection.disabled = busyCount > 0;
    els.downloadSelected.classList.toggle('hidden', !count);
    els.downloadSelected.disabled = busyCount > 0;
    els.downloadSelected.textContent = `下载已选 ${count} 张`;
    els.groups.querySelectorAll('.row-select').forEach(input => {
      const path = input.closest('.row').dataset.path;
      input.checked = selectedDownloads.has(path);
      input.disabled = busyCount > 0;
    });
  }

  function renderBatch() {
    const batch = batches.get(currentId);
    els.batch.classList.toggle('hidden', !batch);
    if (!batch) return;
    const items = [...batch.items.values()];
    const count = status => items.filter(item => item.status === status).length;
    const failed = count('failed');
    const skipped = count('skipped');
    const processed = items.length - count('pending');
    els.batchTitle.textContent = batch.running
      ? `下载进度 · ${processed}/${items.length} 张已处理`
      : `下载结果 · ${count('success')}/${items.length} 张已同步${failed ? ` · ${failed} 张失败` : ''}${skipped ? ` · ${skipped} 张跳过` : ''}`;
    els.batchAction.textContent = `自动导出 · ${batch.action.label} · ${SyncBatch.actionStatus[batch.action.status]}`;
    els.batchRetry.classList.toggle('hidden', !failed);
    els.batchRetry.disabled = busyCount > 0;
    els.batchReview.classList.toggle('hidden', !skipped);
    els.batchReview.disabled = busyCount > 0;
    els.batchDiagnose.classList.toggle('hidden', batch.action.status !== 'failed');
    els.batchCopy.disabled = batch.running;
    els.batchToggle.textContent = batch.expanded ? '收起明细' : '查看明细';
    els.batchToggle.setAttribute('aria-expanded', String(!!batch.expanded));
    els.batchItems.classList.toggle('hidden', !batch.expanded);
    els.batchItems.replaceChildren();
    if (!batch.expanded) return;
    for (const item of items) {
      const li = document.createElement('li');
      li.className = `sync-batch-item ${item.status}`;
      const name = document.createElement('strong');
      name.textContent = item.name || item.path;
      name.title = item.path;
      const status = document.createElement('span');
      status.textContent = [SyncBatch.itemStatus[item.status], item.error || (item.summary ? SyncBatch.counts(item.summary) : '')].filter(Boolean).join(' · ');
      li.append(name, status);
      els.batchItems.appendChild(li);
    }
  }

  function afterDownloadAction() {
    const id = lsGet(afterKey());
    return id && (appConfig.actions || []).find(a => a.id === id);
  }

  async function runBatch(batch, paths) {
    if (downloadInProgress || !paths.length) return;
    downloadInProgress = true;
    batch.running = true;
    setBusy(true);
    try {
      const versions = Object.fromEntries(paths.map(path => [path, batch.items.get(path).version]));
      for (const path of paths) {
        const item = batch.items.get(path);
        item.status = 'pending';
        item.error = null;
      }
      renderBatch();
      const result = await streamSync(paths, versions, item => {
        if (!batch.items.has(item.path)) return;
        SyncBatch.apply(batch, [item.path], [item]);
        renderBatch();
      });
      SyncBatch.apply(batch, paths, result.results, result.error);
      releaseRows(paths);
      for (const path of paths) if (batch.items.get(path).status === 'success') selectedDownloads.delete(path);
      const skipped = SyncBatch.skippedPaths(batch).length > 0;
      if (SyncBatch.failedPaths(batch).length || skipped) batch.expanded = true;
      if (skipped && batch.action.status === 'waiting') batch.action.status = 'blocked';
      const latest = await loadTables();
      if (SyncBatch.complete(batch) && batch.exportAction && batch.action.status === 'waiting') {
        const rows = new Map((latest || []).map(row => [row.path, row]));
        if ([...batch.items.values()].some(item => {
          const row = rows.get(item.path);
          return row?.status !== 'synced' || row.spreadsheetId !== item.version.spreadsheetId
            || row.lastSyncedModifiedTime !== item.version.cloudModifiedTime;
        })) {
          batch.action.status = 'blocked';
          return;
        }
        batch.action.status = 'running';
        renderBatch();
        const code = await runAction(batch.exportAction, diagnostic => { batch.diagnostic = diagnostic; });
        batch.action.status = code === 0 ? 'success' : 'failed';
      }
    } finally {
      downloadInProgress = false;
      batch.running = false;
      setBusy(false);
    }
  }

  const downloadVersion = (row, options = {}) => ({
    spreadsheetId: row.spreadsheetId,
    cloudModifiedTime: row.cloudModifiedTime,
    localVersion: row.localVersion,
    reviewed: options.reviewed ?? (row.reviewed || (row.direction === 'review' ? true : undefined))
  });

  let batchPreview = null;
  function previewBatch(rows, scope) {
    if (busyCount || !rows.length || els.batchConfirm.open) return;
    const project = projects.find(p => p.id === currentId);
    if (!project) return;
    const action = afterDownloadAction();
    const visible = new Set(visibleDownloads);
    const details = SyncBatch.describeScope(rows, visible, action?.label);
    const batch = SyncBatch.create(project.name, rows.map(row => ({
      path: row.path,
      name: row.name,
      version: downloadVersion(row, { reviewed: row.reviewed || (row.direction === 'review') })
    })));
    batch.exportAction = action;
    batch.action = action ? { label: action.label, status: 'waiting' } : { label: '导出', status: 'disabled' };
    batchPreview = { projectId: project.id, batch };

    els.batchConfirmScope.textContent = `${project.name} · ${scope} · ${details.count} 张${details.outside ? `（${details.outside} 张在筛选范围外）` : ''}`;
    els.batchConfirmExport.textContent = details.exportText;
    els.batchConfirmSubmit.textContent = `下载 ${details.count} 张到本地`;
    els.batchConfirmItems.replaceChildren(...rows.map(row => {
      const item = document.createElement('li');
      item.textContent = [row.name || row.path, row.name && row.path, !visible.has(row.path) && '筛选范围外'].filter(Boolean).join(' · ');
      return item;
    }));
    els.batchConfirm.returnValue = 'cancel';
    els.batchConfirm.showModal();
  }

  els.batchConfirm.addEventListener('close', () => {
    const preview = batchPreview;
    batchPreview = null;
    if (!preview || els.batchConfirm.returnValue !== 'download' || preview.projectId !== currentId || busyCount) return;
    batches.set(currentId, preview.batch);
    return runBatch(preview.batch, [...preview.batch.items.keys()]);
  });

  function previewSelected() {
    previewBatch((lastRows || []).filter(row => row.direction === 'download' && selectedDownloads.has(row.path)), '已选表');
  }

  els.selectVisible.addEventListener('click', () => {
    const allSelected = visibleDownloads.every(path => selectedDownloads.has(path));
    for (const path of visibleDownloads) {
      if (allSelected) selectedDownloads.delete(path);
      else selectedDownloads.add(path);
    }
    renderSelection();
  });
  els.clearSelection.addEventListener('click', () => { selectedDownloads.clear(); renderSelection(); });
  els.downloadSelected.addEventListener('click', previewSelected);
  els.viewSelection.addEventListener('click', previewSelected);
  els.batchRetry.addEventListener('click', () => {
    const batch = batches.get(currentId);
    if (batch) runBatch(batch, SyncBatch.failedPaths(batch));
  });
  els.batchReview.addEventListener('click', async () => {
    const batch = batches.get(currentId);
    if (!batch || busyCount) return;
    const id = currentId;
    skippedFilter = new Set(SyncBatch.skippedPaths(batch));
    activeFilter = 'skipped';
    els.search.value = '';
    searchTerms = [];
    render();
    await refresh();
    if (currentId === id && activeFilter === 'skipped') {
      els.groups.querySelector('.group, .empty-tip')?.scrollIntoView({ block: 'nearest' });
    }
  });
  els.batchDiagnose.addEventListener('click', () => {
    const batch = batches.get(currentId);
    if (batch?.diagnostic) showDiagnostic(batch.exportAction, batch.diagnostic);
    else setConsoleCollapsed(false);
  });
  els.batchToggle.addEventListener('click', () => {
    const batch = batches.get(currentId);
    if (batch) { batch.expanded = !batch.expanded; renderBatch(); }
  });
  els.batchCopy.addEventListener('click', async () => {
    const batch = batches.get(currentId);
    if (!batch) return;
    try {
      await navigator.clipboard.writeText(SyncBatch.format(batch));
      showToast('已复制本批变更摘要', 'ok');
    } catch (_) {
      showToast('无法访问剪贴板，请检查浏览器权限', 'error');
    }
  });

  // 差异窗口、清单等现有入口仍使用各自的确认方式。
  async function downloadPaths(paths, { expected } = {}) {
    if (downloadInProgress || !currentId) return null;
    downloadInProgress = true;
    setBusy(true);
    try {
      const versions = expected ? { [paths[0]]: expected } : undefined;
      const summary = await streamSync(paths, versions);
      releaseRows(paths);
      await loadTables();
      await runAfterDownload(summary, new Set(paths).size);
      return summary;
    } finally {
      downloadInProgress = false;
      setBusy(false);
    }
  }

  function openDiff(p, mode) {
    if (window.CSMPanels) return window.CSMPanels.openDiff(p, { mode });
    return Promise.resolve(null);
  }

  async function syncOne(row) {
    if (busyCount || row.direction !== 'download') return;
    const result = await downloadPaths([row.path], { expected: downloadVersion(row) });
    const item = result?.results[0];
    if (item?.success) showToast('已下载到本地', 'ok');
    else if (item?.skipped) showToast('同步版本已变化，请刷新后重新核对', 'info', 5000);
    else showToast('下载失败，请查看控制台日志', 'error', 5000);
  }

  function syncAllUpdated() {
    previewBatch((lastRows || []).filter(row => row.direction === 'download'), '当前项目全部可下载表');
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

  async function runAction(action, onDiagnostic) {
    const actionProject = currentId;
    setBusy(true);
    clearDiagnostic();
    appendLog(`→ ${action.label}…\n`);
    const actionLogs = [];
    try {
      const response = await fetch(api(`/action/${encodeURIComponent(action.id)}`), { method: 'POST' });
      if (!response.ok) {
        appendLog(`! action ${action.id} HTTP ${response.status}\n`);
        return -1;
      }
      const summary = { exitCode: null, successCount: null, failedCount: null };
      await new Promise(resolve => consumeSSE(response, resolve, summary, l => actionLogs.push(l)));

      // 诊断：若退出码不为 0 则智能分析日志
      if (summary.exitCode !== 0 && summary.exitCode != null) {
        if (window.ActionErrorParser) {
          const diag = window.ActionErrorParser.parseActionError(actionLogs.join('\n'), lastRows || []);
          if (diag && currentId === actionProject) {
            onDiagnostic?.(diag);
            showDiagnostic(action, diag);
          }
        }
      }
      return summary.exitCode ?? -1;
    } catch (err) {
      appendLog(`! 执行「${action.label}」失败：${err.message}\n`);
      return -1;
    } finally {
      setBusy(false);
    }
  }

  // ---------- 偏好（本机）：自动刷新 / 通知 / 下载后动作 ----------
  const PREF_AUTO = 'csm.autoRefreshMin';
  const PREF_NOTIFY = 'csm.notify';
  const afterKey = () => `csm.afterDownload.${currentId}`;
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} };

  function renderAfterDownloadPref() {
    const actions = (appConfig.actions || []).filter(a => !a.hidden && a.id !== 'gen-localization');
    els.prefAfterWrap.classList.toggle('hidden', actions.length === 0);
    els.prefAfterDownload.innerHTML = '<option value="">不执行</option>';
    actions.forEach(a => {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.label;
      els.prefAfterDownload.appendChild(o);
    });
    const saved = lsGet(afterKey());
    els.prefAfterDownload.value = actions.some(a => a.id === saved) ? saved : '';
  }

  async function runAfterDownload(summary, expected) {
    if (!summary?.receivedDone || !expected || summary.failedCount || summary.successCount !== expected) return;
    const action = afterDownloadAction();
    if (!action) return;
    appendLog(`→ 下载完成，按设置自动执行「${action.label}」\n`);
    await runAction(action);
  }

  // 自动刷新：定时 + 窗口重新获得焦点；发现新的「有更新 / 冲突」时发系统通知
  let autoTimer = null;
  let lastRefreshAt = 0;
  let knownAlerts = null; // 当前项目已提示过的 path|云端时间
  const FOCUS_REFRESH_MS = 2 * 60 * 1000;
  const alertRows = rows => rows.filter(r => r.direction === 'download' || r.direction === 'conflict');
  const alertKey = r => `${r.path}|${r.cloudModifiedTime || ''}`;

  function markRefreshed(rows, notify, checkedAt) {
    lastRefreshAt = Date.parse(checkedAt) || Date.now();
    const time = new Date(lastRefreshAt).toLocaleTimeString('zh-CN', { hour12: false });
    const errors = rows.filter(row => row.status === 'error').length;
    const failures = rows.filter(row => verifyFailures.has(row.path)).length;
    const issues = [errors && `${errors} 张查询异常`, failures && `${failures} 张内容核对失败`].filter(Boolean);
    if (issues.length) setCloudStatus('partial', `已检查 ${time} · ${issues.join(' · ')}`);
    else setCloudStatus('ready', `上次成功检查 ${time}`);
    const fresh = alertRows(rows).filter(r => !knownAlerts || !knownAlerts.has(alertKey(r)));
    const first = !knownAlerts;
    knownAlerts = new Set(alertRows(rows).map(alertKey));
    if (first || !notify || fresh.length === 0) return;
    const conflicts = fresh.filter(r => r.direction === 'conflict');
    const names = fresh.slice(0, 5).map(r => r.name).join('、') + (fresh.length > 5 ? ` 等 ${fresh.length} 张` : '');
    appendLog(`🔔 自动刷新发现 ${fresh.length} 张表云端有更新${conflicts.length ? `（其中 ${conflicts.length} 张冲突）` : ''}：${names}\n`);
    if (els.prefNotify.checked) {
      const project = (projects.find(x => x.id === currentId) || {}).name || 'CSM';
      sendBannerNotification({
        title: `CSM · ${project}：${fresh.length} 张配置表有更新`,
        body: (conflicts.length ? `⚠ ${conflicts.length} 张冲突需人工处理\n` : '') + names
      });
    }
  }

  function silentRefresh() {
    if (busyCount || document.querySelector('.modal:not(.hidden)') || els.batchConfirm.open) return;
    return refresh({ force: false, notify: true });
  }

  // 「有更新 / 冲突 / 本地变更 / 需核对」的表：修改时间或文件字节变了不代表内容变了，导出云端与本地比较，内容一致的自动记为已同步
  const VERIFY_STATUSES = new Set(['updated', 'conflict', 'local_changed', 'never_synced']);
  const VERIFY_CONCURRENCY = 6;
  async function verifyUpdates(rows, { force = false } = {}) {
    const id = currentId;
    const paths = (rows || []).filter(r => VERIFY_STATUSES.has(r.status) && (force || !r.changeSummary)).map(r => r.path);
    if (!paths.length) return rows;
    const current = verifyRuns.get(id);
    if (current) {
      if (!force) return current.promise;
      await current.promise;
      if (id !== currentId) return rows;
      return verifyUpdates(rows, { force });
    }
    const run = { paths: new Set(paths) };
    verifyRuns.set(id, run);
    const byPath = new Map((rows || []).map(row => [row.path, row]));
    paths.forEach(path => verifyFailures.delete(path));
    render();
    // 逐表请求、并发核对：哪张核完就先刷新哪一行，不用等最慢的那张；单张超时也只影响它自己
    run.promise = (async () => {
      const queue = [...paths];
      const same = [];
      const failed = [];
      let latest = null;
      let done = 0;
      const verifyOne = async path => {
        const controller = new AbortController();
        const timeoutTimer = setTimeout(() => controller.abort(), 60000);
        try {
          const resp = await fetch(api('/verify', id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: [path], force }),
            signal: controller.signal
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
          for (const r of data.results || []) {
            if (r.identical) same.push(r);
            else if (r.error) failed.push(r);
          }
          if (data.tables) latest = data.tables;
        } catch (err) {
          failed.push({ path, error: err.name === 'AbortError' ? '核对超时（60 秒）' : err.message });
        } finally {
          clearTimeout(timeoutTimer);
          run.paths.delete(path);
          done++;
          if (id === currentId) {
            if (run.paths.size && cloudStatus === 'checking') setCloudStatus('checking', `正在核对配置表内容（${done}/${paths.length}）…`);
            render(latest || undefined);
          }
        }
      };
      const worker = async () => {
        while (queue.length) await verifyOne(queue.shift());
      };
      try {
        await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, worker));
        if (id !== currentId) return rows;
        if (same.length) {
          const nameOf = r => (byPath.get(r.path) || {}).name || r.path;
          const localOnly = same.filter(r => r.previousStatus === 'local_changed');
          const neverSynced = same.filter(r => r.previousStatus === 'never_synced');
          const cloud = same.filter(r => r.previousStatus !== 'local_changed' && r.previousStatus !== 'never_synced');
          if (neverSynced.length) appendLog(`✓ 内容核对：${neverSynced.length} 张表此前无同步记录但内容与云端一致，已自动标为已同步：${neverSynced.map(nameOf).join('、')}\n`);
          if (cloud.length) appendLog(`✓ 内容核对：${cloud.length} 张表云端只是修改时间变了，内容与本地一致，已标为已同步：${cloud.map(nameOf).join('、')}\n`);
          if (localOnly.length) appendLog(`✓ 内容核对：${localOnly.length} 张表本地文件被重新保存过但内容与云端一致，已标为已同步：${localOnly.map(nameOf).join('、')}\n`);
          refreshProjectBadges();
        }
        for (const failure of failed) {
          const row = byPath.get(failure.path);
          if (row) verifyFailures.set(row.path, { cloud: row.cloudModifiedTime, local: row.localVersion, error: failure.error });
          appendLog(`! 内容核对失败 ${failure.path}：${failure.error}\n`);
        }
        return latest || rows;
      } finally {
        verifyRuns.delete(id);
      }
    })();
    const result = await run.promise;
    if (id === currentId) render(result);
    return result;
  }

  function applyAutoRefresh() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    const min = parseInt(els.prefAutoRefresh.value, 10) || 0;
    if (min > 0) autoTimer = setInterval(silentRefresh, min * 60 * 1000);
  }

  els.prefAutoRefresh.value = lsGet(PREF_AUTO) || '0';
  els.prefNotify.checked = lsGet(PREF_NOTIFY) === '1';
  applyAutoRefresh();
  els.prefAutoRefresh.addEventListener('change', () => { lsSet(PREF_AUTO, els.prefAutoRefresh.value); applyAutoRefresh(); });
  els.prefNotify.addEventListener('change', async () => {
    if (els.prefNotify.checked) {
      if (!window.electronBridge && 'Notification' in window && Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission().catch(() => 'denied');
        if (perm !== 'granted') {
          els.prefNotify.checked = false;
          appendLog('! 系统未允许通知：请在「系统设置 → 通知」中允许 CSM（或浏览器）发送通知\n');
          showToast('系统未允许通知权限', 'error');
        }
      }
      if (els.prefNotify.checked) {
        showToast('已开启有更新时横幅通知', 'success');
      }
    } else {
      showToast('已关闭通知', 'info');
    }
    lsSet(PREF_NOTIFY, els.prefNotify.checked ? '1' : '');
  });
  els.prefAfterDownload.addEventListener('change', () => lsSet(afterKey(), els.prefAfterDownload.value));
  window.addEventListener('focus', () => {
    refreshProjectBadges();
    if ((parseInt(els.prefAutoRefresh.value, 10) || 0) > 0 && Date.now() - lastRefreshAt > FOCUS_REFRESH_MS) silentRefresh();
  });

  function lubanAction() {
    return appConfig.actions.find(action => action.id === 'gen-client');
  }

  function updateLubanButton() {
    const action = lubanAction();
    els.btnLuban.disabled = busyCount > 0 || !action;
    els.btnLuban.title = action ? `执行 ${action.label}` : '缺少 Tools 目录下的 Luban 客户端生成脚本';
  }

  els.btnLuban.addEventListener('click', () => {
    const action = lubanAction();
    if (action && !busyCount) runAction(action);
  });

  async function loadConfig() {
    const id = currentId;
    appConfig = { allowUpload: true, actions: [] };
    els.customActions.replaceChildren(els.btnLuban);
    updateLubanButton();
    try {
      const resp = await fetch(api('/config', id));
      const data = await resp.json();
      if (id !== currentId) return;
      if (resp.ok) appConfig = data;
      else appendLog(`! 项目配置错误: ${data.error}\n`);
    } catch (_) { /* 用默认值 */ }
    if (id !== currentId) return;
    updateLubanButton();
    (appConfig.actions || []).filter(a => !a.hidden && a.id !== 'gen-localization' && a.id !== 'gen-client').forEach(action => {
      const b = document.createElement('button');
      b.type = 'button';
      b.disabled = busyCount > 0;
      b.innerHTML = `${window.CSMIcons ? window.CSMIcons.terminal : ''} <span>${action.label}</span>`;
      b.title = action.description || (typeof action.command === 'string' ? `执行自定义动作：${action.label}\n脚本命令：${action.command}` : `执行自定义动作：${action.label}`);
      b.addEventListener('click', () => runAction(action));
      els.customActions.appendChild(b);
    });
    renderAfterDownloadPref();
  }

  // ---------- 多项目 ----------
  // 当前项目的信息与功能区：没有选中项目时整块隐藏
  function renderProjectPanel() {
    const p = projects.find(x => x.id === currentId);
    els.projectPanel.classList.toggle('hidden', !p);
    els.summaryBar.classList.toggle('hidden', !p);
    els.cloudStatusBar.classList.toggle('hidden', !p);
    if (!p) return;
    els.projectName.textContent = p.name;
    els.projectDir.textContent = p.dir;
    els.projectDir.title = p.dir;
  }

  let lastTabClickTime = 0;
  let lastTabClickId = null;
  let draggedTab = null;
  let dropHint = null;
  let savingTabOrder = false;

  function clearTabDropHint() {
    dropHint?.classList.remove('drop-before', 'drop-after');
    dropHint = null;
  }

  function endTabDrag() {
    draggedTab?.classList.remove('dragging');
    draggedTab = null;
    clearTabDropHint();
  }

  function tabDropPosition(event, tab) {
    const rect = tab.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  }

  els.projectTabs.addEventListener('dragover', e => {
    if (!draggedTab) return;
    const target = e.target.closest('.project-tab');
    if (!target || target === draggedTab) {
      clearTabDropHint();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropHint !== target) clearTabDropHint();
    dropHint = target;
    const before = tabDropPosition(e, target) === 'before';
    target.classList.toggle('drop-before', before);
    target.classList.toggle('drop-after', !before);
  });

  els.projectTabs.addEventListener('dragleave', e => {
    if (!els.projectTabs.contains(e.relatedTarget)) clearTabDropHint();
  });

  els.projectTabs.addEventListener('drop', async e => {
    if (!draggedTab) return;
    e.preventDefault();
    const id = draggedTab.dataset.projectId;
    const target = e.target.closest('.project-tab');
    endTabDrag();
    if (!target || target.dataset.projectId === id) return;

    savingTabOrder = true;
    try {
      const resp = await fetch('/api/projects/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, targetId: target.dataset.projectId, position: tabDropPosition(e, target) })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { order } = await resp.json();
      const rank = new Map(order.map((projectId, i) => [projectId, i]));
      const positionOf = projectId => rank.get(projectId) ?? order.length;
      projects.sort((a, b) => positionOf(a.id) - positionOf(b.id));
      const tabs = new Map(Array.from(els.projectTabs.children, tab => [tab.dataset.projectId, tab]));
      projects.forEach((project, i) => {
        const tab = tabs.get(project.id);
        const current = els.projectTabs.children[i];
        if (tab && tab !== current) els.projectTabs.insertBefore(tab, current || null);
      });
      updateProjectNavigation();
    } catch (err) {
      appendLog(`! 保存项目标签顺序失败：${err.message}\n`);
      showToast('保存项目标签顺序失败，请重试', 'error');
    } finally {
      savingTabOrder = false;
    }
  });

  function renderTabs() {
    endTabDrag();
    renderProjectPanel();
    els.projectTabs.innerHTML = '';
    projects.forEach(p => {
      const tab = document.createElement('span');
      tab.className = `project-tab${p.id === currentId ? ' active' : ''}`;
      tab.dataset.projectId = p.id;
      tab.title = `${p.dir}\n拖动排序 · 双击重命名`;
      tab.draggable = true;
      tab.addEventListener('mousedown', e => {
        tab.draggable = !e.target.closest('.tab-close, .tab-rename-input');
      });
      tab.addEventListener('dragstart', e => {
        if (projects.length < 2 || savingTabOrder || tab.classList.contains('renaming')) {
          e.preventDefault();
          return;
        }
        draggedTab = tab;
        lastTabClickId = null;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', p.id);
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', endTabDrag);

      const icon = document.createElement('span');
      icon.className = 'tab-icon';
      icon.innerHTML = window.CSMIcons ? window.CSMIcons.sheet : '📄';

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = p.name;

      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.id = `tab-badge-${p.id}`;

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.innerHTML = window.CSMIcons ? window.CSMIcons.close : '✕';
      close.title = '从平台移除（不会删除任何文件）';

      tab.append(icon, label, badge, close);

      tab.addEventListener('click', e => {
        if (tab.classList.contains('renaming')) return;
        const now = Date.now();
        if (lastTabClickId === p.id && (now - lastTabClickTime) < 450) {
          // 450ms 内双击判定
          lastTabClickTime = 0;
          lastTabClickId = null;
          e.stopPropagation();
          startTabRename(p, tab, label);
          return;
        }
        lastTabClickTime = now;
        lastTabClickId = p.id;

        if (p.id !== currentId) {
          selectProject(p.id);
        }
      });

      tab.addEventListener('dblclick', e => {
        e.stopPropagation();
        startTabRename(p, tab, label);
      });

      label.addEventListener('dblclick', e => {
        e.stopPropagation();
        startTabRename(p, tab, label);
      });

      close.addEventListener('click', e => {
        e.stopPropagation();
        removeProject(p);
      });

      close.addEventListener('dblclick', e => {
        e.stopPropagation();
      });

      tab.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        startTabRename(p, tab, label);
      });

      els.projectTabs.appendChild(tab);
    });

    updateTabBadges();
    updateProjectNavigation();
  }

  function updateProjectNavigation() {
    if (btnPrev && btnNext) {
      const idx = projects.findIndex(p => p.id === currentId);
      btnPrev.disabled = idx <= 0;
      btnNext.disabled = idx < 0 || idx >= projects.length - 1;
    }
  }

  async function selectProject(id) {
    if (downloadInProgress || els.batchConfirm.open) {
      if (id !== currentId) showToast('本批下载或导出进行中', 'info');
      return;
    }
    if (currentId === id) {
      return;
    }
    const changed = currentId !== id;
    currentId = id;
    if (changed) {
      document.dispatchEvent(new Event('csm-project-changed'));
      els.search.value = '';
      searchTerms = [];
      clearDiagnostic();
    }
    selectedDownloads.clear();
    expandedSummaries.clear();
    verifyFailures.clear();
    visibleDownloads = [];
    visibleRows = [];
    renderSelection();
    renderBatch();
    try { localStorage.setItem(PROJECT_KEY, id); } catch (_) {}
    renderTabs();
    groupExpandedState.clear();
    lastRows = null; // 换项目后不能再拿旧项目的列表做搜索
    activeFilter = 'all';
    skippedFilter = null;
    knownAlerts = null;
    lastRefreshAt = 0;
    els.btnSyncAll.disabled = true;
    els.authBanner.classList.add('hidden');
    setCloudStatus('loading', '正在检查 Google 授权与云端状态…');
    els.groups.innerHTML = '';
    els.summary.textContent = '加载中…';
    await loadConfig();
    if (id === currentId) await loadTables();
  }

  async function loadProjects(preferId) {
    projects = await (await fetch('/api/projects')).json();
    let saved = null;
    try { saved = localStorage.getItem(PROJECT_KEY); } catch (_) {}
    const pick = [preferId, currentId, saved].find(id => id && projects.some(p => p.id === id)) || (projects[0] && projects[0].id);
    els.firstProject.classList.toggle('hidden', !!pick);
    if (!pick) {
      if (currentId) {
        currentId = null;
        document.dispatchEvent(new Event('csm-project-changed'));
      }
      els.allSyncedBanner.classList.add('hidden');
      els.authBanner.classList.add('hidden');
      renderSelection();
      renderBatch();
      lastRows = null;
      renderTabs();
      appConfig = { allowUpload: true, actions: [] };
      els.customActions.replaceChildren(els.btnLuban);
      updateLubanButton();
      els.groups.replaceChildren();
      els.summary.textContent = '';
      return;
    }
    if (pick === currentId) renderTabs();
    else await selectProject(pick);
    refreshProjectBadges();
  }

  function startTabRename(p, tab, label) {
    if (!tab || tab.classList.contains('renaming')) return;
    // 如果已有其他 tab 在重命名，先提交它
    const existingInput = document.querySelector('.tab-rename-input');
    if (existingInput) existingInput.blur();

    tab.classList.add('renaming');
    const origTitle = tab.title;
    tab.title = '';
    label.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-rename-input';
    input.value = p.name;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '修改项目显示名称');
    input.style.width = Math.max(75, Math.min(160, (p.name.length + 3) * 11)) + 'px';

    ['mousedown', 'click', 'dblclick'].forEach(evt => {
      input.addEventListener(evt, e => e.stopPropagation());
    });

    label.after(input);

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const newName = input.value.trim();
      input.remove();
      label.style.display = '';
      tab.classList.remove('renaming');
      tab.title = origTitle;

      if (!save || !newName || newName === p.name) return;

      const oldName = p.name;
      // 乐观更新界面显示
      p.name = newName;
      label.textContent = newName;
      tab.title = origTitle;
      if (p.id === currentId && els.projectName) {
        els.projectName.textContent = newName;
      }

      try {
        const resp = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName })
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${resp.status}`);
        }
        appendLog(`✏️ 已将项目「${oldName}」重命名为「${newName}」\n`);
        await loadProjects(currentId);
        document.dispatchEvent(new Event('csm-project-changed'));
      } catch (err) {
        p.name = oldName;
        label.textContent = oldName;
        if (p.id === currentId && els.projectName) {
          els.projectName.textContent = oldName;
        }
        appendLog(`! 项目重命名失败: ${err.message}\n`);
        alert(`项目重命名失败: ${err.message}`);
      }
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });

    input.addEventListener('blur', () => {
      finish(true);
    });
  }

  async function renameProject(p, tabEl, labelEl) {
    if (!p) p = projects.find(x => x.id === currentId);
    if (!p) return;
    if (!tabEl || !labelEl) {
      const idx = projects.findIndex(x => x.id === p.id);
      if (idx >= 0 && els.projectTabs && els.projectTabs.children[idx]) {
        tabEl = els.projectTabs.children[idx];
        labelEl = tabEl.querySelector('.tab-label');
      }
    }
    if (tabEl && labelEl) {
      startTabRename(p, tabEl, labelEl);
    }
  }

  async function removeProject(p) {
    if (downloadInProgress) return;
    if (!confirm(`从平台移除项目「${p.name}」吗？\n\n只是不再管理它，项目目录里的文件不会被删除。`)) return;
    const resp = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (!resp.ok) { appendLog('! 移除失败\n'); return; }
    projectSummaries.delete(p.id);
    batches.delete(p.id);
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

  let dirBrowseId = 0;
  async function browse(p) {
    const browseId = ++dirBrowseId;
    dirEls.pick.disabled = true;
    dirCurrent = null;
    dirEls.msg.textContent = '正在检查目录…';
    try {
      const resp = await fetch(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      const data = await resp.json();
      if (browseId !== dirBrowseId) return;
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      dirCurrent = data.path;
      dirEls.path.textContent = data.path;
      dirEls.msg.textContent = data.hint
        ? '已找到项目配置或配置表清单，可以添加。'
        : '此目录没有找到配置表清单。请继续浏览，或用系统选择器重新选目录。';
      dirEls.pick.disabled = !data.hint;
      dirEls.list.replaceChildren();
      const addItem = (text, target, star) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `${text}${star ? ' ★' : ''}`;
        button.addEventListener('click', () => browse(target));
        li.appendChild(button);
        dirEls.list.appendChild(li);
      };
      if (data.parent) addItem('上一级', data.parent, false);
      data.dirs.forEach(d => addItem(d.name, d.path, d.hint));
    } catch (err) {
      if (browseId === dirBrowseId) dirEls.msg.textContent = `无法读取目录：${err.message}`;
    }
  }

  function openDirModal() {
    if (downloadInProgress) return;
    dirEls.modal.classList.remove('hidden');
    dirEls.name.value = '';
    dirEls.native.focus();
    browse(lsGet(DIR_KEY));
  }

  async function addCurrentDir() {
    if (!dirCurrent || dirEls.pick.disabled) return;
    const dir = dirCurrent;
    const browseId = dirBrowseId;
    dirEls.pick.disabled = true;
    dirEls.msg.textContent = '正在添加项目…';
    try {
      const resp = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, name: dirEls.name.value })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      lsSet(DIR_KEY, dir);
      dirEls.modal.classList.add('hidden');
      appendLog(`✓ 已添加项目「${data.project.name}」${data.generated ? '（已自动生成 syncmanager.config.json）' : ''}\n`);
      await loadProjects(data.project.id);
    } catch (err) {
      if (browseId === dirBrowseId) {
        dirEls.pick.disabled = false;
        dirEls.msg.textContent = `添加失败：${err.message}`;
      }
    }
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
  els.firstProjectAdd.addEventListener('click', openDirModal);
  dirEls.native.addEventListener('click', pickNative);
  dirEls.close.addEventListener('click', () => dirEls.modal.classList.add('hidden'));
  dirEls.pick.addEventListener('click', addCurrentDir);

  els.btnRefresh.addEventListener('click', () => refresh());
  els.retryRefresh.addEventListener('click', () => refresh());
  els.btnSyncAll.addEventListener('click', syncAllUpdated);
  els.btnClearState.addEventListener('click', () => {
    clearState();
    showToast('已清除同步状态缓存', 'info');
  });
  els.btnClearLog.addEventListener('click', () => {
    els.log.innerHTML = '';
    rawLogHistory = '';
    if (els.consolePreview) els.consolePreview.textContent = '就绪';
    showToast('已清空控制台日志', 'info');
  });

  if (els.btnCopyLog) {
    els.btnCopyLog.addEventListener('click', () => {
      const text = rawLogHistory || (els.log ? els.log.textContent : '');
      if (!text.trim()) {
        showToast('日志为空', 'info');
        return;
      }
      navigator.clipboard.writeText(text).then(() => {
        showToast('控制台日志已复制到剪贴板', 'success');
      }).catch(() => {
        showToast('复制日志失败', 'error');
      });
    });
  }

  // 在访达中定位项目目录
  if (els.projectDirBadge) {
    els.projectDirBadge.addEventListener('click', () => {
      revealLocal('').then(res => {
        if (res) showToast('已在访达中打开项目目录', 'info');
      });
    });
  }

  // 控制台抽屉折叠与展开
  function setConsoleCollapsed(collapsed) {
    if (!els.consoleDrawer) return;
    els.consoleDrawer.classList.toggle('collapsed', !!collapsed);
    if (els.consoleToggleText) els.consoleToggleText.textContent = collapsed ? '展开' : '收起';
  }
  function toggleConsole() {
    if (!els.consoleDrawer) return;
    setConsoleCollapsed(!els.consoleDrawer.classList.contains('collapsed'));
  }
  if (els.btnToggleLog) els.btnToggleLog.addEventListener('click', (e) => { e.stopPropagation(); toggleConsole(); });
  if (els.consoleBar) els.consoleBar.addEventListener('click', (e) => {
    // 忽略点击清空与复制按钮
    if (e.target.closest('#btn-clear-log') || e.target.closest('#btn-copy-log')) return;
    toggleConsole();
  });

  // 供 filelist-manager.js 使用
  // 在访达中定位本地文件（相对 filelist 所在目录）；文件不存在时打开最近的上级目录
  async function revealLocal(relPath) {
    try {
      const resp = await fetch(api('/reveal'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: relPath || '' }) });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { appendLog(`! 打开本地位置失败：${data.error || resp.status}\n`); return null; }
      if (!data.exact) appendLog(`（本地还没有 ${relPath}，已打开所在目录）\n`);
      return data;
    } catch (err) {
      appendLog(`! 打开本地位置失败：${err.message}\n`);
      return null;
    }
  }

  els.btnHistory.addEventListener('click', () => window.CSMPanels && window.CSMPanels.openHistory());

  // ---------- 全局设置与项目设置弹窗体系 ----------

  // 1. 全局授权状态展示更新
  async function updateAuthStatusUI() {
    try {
      const s = await (await fetch('/api/auth-status')).json();
      const profile = els.tabStripProfile;
      if (!s.authorized) {
        if (currentId) showAuthorizationRequired();
        if (profile) profile.title = '未授权 Google 账号 · 点击打开全局偏好设置 (⌘,)';
        if (els.globalAuthBadge) {
          els.globalAuthBadge.className = 'auth-status-badge badge-unauth';
          els.globalAuthBadge.textContent = '● 未授权';
        }
        if (els.globalAuthDesc) els.globalAuthDesc.textContent = '尚未绑定 Google 账号，无法同步云端表格';
        if (els.globalAuthScope) {
          els.globalAuthScope.className = 'auth-scope-badge badge-unauth';
          els.globalAuthScope.textContent = '无权限';
        }
        if (els.globalBtnLogout) els.globalBtnLogout.classList.add('hidden');
        if (els.globalBtnReauth) {
          els.globalBtnReauth.textContent = '立即登录 / 授权';
          els.globalBtnReauth.title = '授权 Google 账号以使用表格双向同步功能';
        }
      } else {
        if (els.authBanner) els.authBanner.classList.add('hidden');
        const userText = s.account ? ` (${s.account})` : '';
        if (profile) profile.title = `Google 账号已授权${userText} · 点击打开全局偏好设置 (⌘,)`;
        if (els.globalAuthBadge) {
          els.globalAuthBadge.className = 'auth-status-badge badge-auth';
          els.globalAuthBadge.textContent = '● 已连接';
        }
        if (els.globalAuthDesc) els.globalAuthDesc.textContent = s.account ? `已授权账号：${s.account}` : '已连接 Google Drive 服务，用于双向同步表格数据';
        if (els.globalAuthScope) {
          if (s.canUpload) {
            els.globalAuthScope.className = 'auth-scope-badge badge-write';
            els.globalAuthScope.textContent = '读写全量授权（支持下载与回写）';
          } else {
            els.globalAuthScope.className = 'auth-scope-badge badge-read';
            els.globalAuthScope.textContent = '只读授权（仅支持下载）';
          }
        }
        if (els.globalBtnLogout) els.globalBtnLogout.classList.remove('hidden');
        if (els.globalBtnReauth) {
          els.globalBtnReauth.textContent = '重新授权';
          els.globalBtnReauth.title = '重新授权或切换 Google 账号';
        }
      }
    } catch (_) {}
  }

  // 2. 全局偏好设置 (Global Settings)
  function openGlobalSettings() {
    updateAuthStatusUI();
    const titleEl = document.getElementById('app-title');
    if (els.globalSettingsVersion) {
      els.globalSettingsVersion.textContent = (titleEl && titleEl.title) ? titleEl.title : 'CSM v1.1.3';
    }
    if (els.globalSettingsModal) els.globalSettingsModal.classList.remove('hidden');
  }
  const closeGlobalSettings = () => els.globalSettingsModal && els.globalSettingsModal.classList.add('hidden');

  if (els.tabStripProfile) els.tabStripProfile.addEventListener('click', openGlobalSettings);
  if (els.globalSettingsClose) els.globalSettingsClose.addEventListener('click', closeGlobalSettings);
  if (els.globalSettingsDone) els.globalSettingsDone.addEventListener('click', closeGlobalSettings);
  if (els.globalSettingsModal) {
    els.globalSettingsModal.addEventListener('click', e => {
      if (e.target === els.globalSettingsModal) closeGlobalSettings();
    });
  }

  if (els.globalBtnLogout) {
    els.globalBtnLogout.addEventListener('click', async () => {
      const ok = window.confirm('确认退出当前 Google 账号？\n退出后将无法同步云端表格与查询更新。');
      if (!ok) return;
      try {
        const resp = await fetch('/api/auth-logout', { method: 'POST' });
        if (resp.ok) {
          showToast('已退出 Google 账号登录', 'info');
          await updateAuthStatusUI();
          if (typeof loadTables === 'function') loadTables();
        } else {
          const err = await resp.json().catch(() => ({}));
          showToast(`退出失败: ${err.error || resp.status}`, 'error');
        }
      } catch (err) {
        showToast(`退出失败: ${err.message}`, 'error');
      }
    });
  }

  // 3. 项目设置 (Project Settings)
  function openProjectSettings() {
    const p = projects.find(x => x.id === currentId);
    if (els.projectSettingsName) els.projectSettingsName.textContent = p ? p.name : '';
    if (els.projectSettingsNameInput) els.projectSettingsNameInput.value = p ? p.name : '';
    if (els.projectSettingsDir) els.projectSettingsDir.textContent = p ? p.dir : '未配置';
    if (els.projectSettingsModal) els.projectSettingsModal.classList.remove('hidden');
    if (els.projectSettingsNameInput) {
      setTimeout(() => els.projectSettingsNameInput.focus(), 50);
    }
  }
  const closeProjectSettings = () => els.projectSettingsModal && els.projectSettingsModal.classList.add('hidden');

  async function handleProjectSettingsRename() {
    const p = projects.find(x => x.id === currentId);
    if (!p || !els.projectSettingsNameInput) return;
    const newName = els.projectSettingsNameInput.value.trim();
    if (!newName) {
      alert('项目名称不能为空');
      return;
    }
    if (newName === p.name) return;
    const oldName = p.name;
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      p.name = newName;
      if (els.projectSettingsName) els.projectSettingsName.textContent = newName;
      appendLog(`✏️ 已将项目「${oldName}」重命名为「${newName}」\n`);
      await loadProjects(currentId);
      document.dispatchEvent(new Event('csm-project-changed'));
      showToast(`已重命名为「${newName}」`, 'info');
    } catch (err) {
      alert(`重命名失败: ${err.message}`);
    }
  }

  if (els.projectBtnRename) {
    els.projectBtnRename.addEventListener('click', handleProjectSettingsRename);
  }
  if (els.projectSettingsNameInput) {
    els.projectSettingsNameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleProjectSettingsRename();
      }
    });
  }

  if (els.btnSettings) els.btnSettings.addEventListener('click', openProjectSettings);
  if (els.projectSettingsClose) els.projectSettingsClose.addEventListener('click', closeProjectSettings);
  if (els.projectSettingsDone) els.projectSettingsDone.addEventListener('click', closeProjectSettings);
  if (els.projectSettingsModal) {
    els.projectSettingsModal.addEventListener('click', e => {
      if (e.target === els.projectSettingsModal) closeProjectSettings();
    });
  }

  if (els.projectBtnReveal) {
    els.projectBtnReveal.addEventListener('click', () => {
      revealLocal('').then(res => {
        if (res) showToast('已在访达中定位项目根目录', 'info');
      });
    });
  }

  // 这两个会打开别的弹窗 / 确认框：先关掉项目设置，避免叠在下面
  for (const b of [document.getElementById('btn-filelist'), els.btnClearState]) {
    if (b) b.addEventListener('click', closeProjectSettings, true);
  }

  window.CSM = {
    revealLocal,
    api,
    formatTime,
    downloadPaths,
    uploadRequest,
    openDiff,
    allowUpload: () => appConfig.allowUpload !== false,
    tableRow: p => (lastRows || []).find(r => r.path === p) || null,
    currentId: () => currentId,
    getProjects: () => (projects || []).slice(),
    reloadTables: () => loadTables(),
    appendLog,
    showAuthBanner: () => els.authBanner.classList.remove('hidden')
  };

  // ---------- 配置表搜索 ----------
  els.search.addEventListener('input', () => {
    searchTerms = TableSearch.parseQuery(els.search.value);
    render();
  });
  if (els.searchClear) {
    els.searchClear.addEventListener('click', () => {
      els.search.value = '';
      searchTerms = [];
      render();
      els.search.focus();
    });
  }
  els.search.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      els.search.value = '';
      searchTerms = [];
      render();
      els.search.blur();
    } else if (e.key === 'Enter' && searchTerms.length && visibleRows.length) {
      e.preventDefault();
      const row = els.groups.querySelector('.row');
      if (!row) return;
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest' });
    }
  });

  // ---------- 全局快捷键体系（Keyboard-First） ----------
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229 || els.batchConfirm.open) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
    const anyModalOpen = !!document.querySelector('.modal:not(.hidden)');

    // 1. Esc: 优先关闭打开的弹窗或清空搜索框
    if (e.key === 'Escape') {
      if (els.globalSettingsModal && !els.globalSettingsModal.classList.contains('hidden')) { closeGlobalSettings(); return; }
      if (els.projectSettingsModal && !els.projectSettingsModal.classList.contains('hidden')) { closeProjectSettings(); return; }
      const modal = document.querySelector('.modal:not(.hidden)');
      if (modal) { modal.classList.add('hidden'); return; }
      if (els.search && (els.search.value || document.activeElement === els.search)) {
        els.search.value = '';
        searchTerms = [];
        render();
        els.search.blur();
      }
      return;
    }

    // 2. ⌘R / Ctrl+R: 刷新所有云端修改状态（拦截浏览器页面刷新）
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      refresh();
      return;
    }

    // 3. ⌘L / Ctrl+L: 展开 / 收起控制台抽屉
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      toggleConsole();
      return;
    }

    // 4. ⌘, / Ctrl+,: 打开全局偏好设置
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      openGlobalSettings();
      return;
    }

    // 4b. ⌘; / Ctrl+;: 打开当前项目设置
    if ((e.metaKey || e.ctrlKey) && (e.key === ';' || e.key === '；')) {
      e.preventDefault();
      openProjectSettings();
      return;
    }

    // 5. ⌘/ 或 ?: 快捷键指南（打开全局设置并滚动至快捷键）
    if (((e.metaKey || e.ctrlKey) && e.key === '/') || (e.key === '?' && !typing && !anyModalOpen)) {
      e.preventDefault();
      openGlobalSettings();
      setTimeout(() => {
        const scGroup = document.getElementById('settings-shortcuts-group');
        if (scGroup) scGroup.scrollIntoView({ behavior: 'smooth' });
      }, 60);
      return;
    }

    // 6. ⌘F / Ctrl+F 或 / 聚焦搜索框（弹窗打开时不抢焦点）
    if (!anyModalOpen && (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing))) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }

    // 7. ⌘1 ~ ⌘9 / Ctrl+1 ~ Ctrl+9: 快速切换项目 Tab
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key) && !anyModalOpen) {
      const idx = parseInt(e.key, 10) - 1;
      if (projects[idx]) {
        e.preventDefault();
        selectProject(projects[idx].id);
        return;
      }
    }

    // 8. ⌘[ / ⌘]: 切换上一个 / 下一个项目
    if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']') && !anyModalOpen) {
      e.preventDefault();
      const idx = projects.findIndex(p => p.id === currentId);
      if (e.key === '[' && idx > 0) selectProject(projects[idx - 1].id);
      else if (e.key === ']' && idx >= 0 && idx < projects.length - 1) selectProject(projects[idx + 1].id);
      return;
    }
  });

  // 初始化账号授权状态与全局胶囊
  updateAuthStatusUI();

  loadProjects();
})();
