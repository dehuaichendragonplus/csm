(function () {
  'use strict';

  const STATUS_LABELS = {
    conflict: { label: '冲突（两边都改过）', icon: '⚠' },
    error: { label: '错误', icon: '✖' },
    missing_local: { label: '本地缺失', icon: '⊘' },
    local_changed: { label: '本地变更', icon: '⟲' },
    never_synced: { label: '未同步', icon: '✚' },
    updated: { label: '有更新', icon: '⚡' },
    synced: { label: '已同步', icon: '●' }
  };

  const GROUP_ORDER = ['conflict', 'updated', 'never_synced', 'missing_local', 'local_changed', 'error', 'synced'];
  // 由 /api/config 填充：标题、是否允许上传、同步后动作名、自定义动作按钮
  let appConfig = { allowUpload: true, actions: [] };
  const DEFAULT_COLLAPSED = new Set(['synced', 'local_changed']);
  // 两边内容可能不一致、值得看差异的状态
  const verifyingPaths = new Set(); // 正在核对内容的表
  const DIFF_STATUSES = new Set(['conflict', 'updated', 'never_synced', 'local_changed']);
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
    appLogo: document.getElementById('app-logo'),
    projectTabs: document.getElementById('project-tabs'),
    btnAddProject: document.getElementById('btn-add-project'),
    summary: document.getElementById('summary'),
    groups: document.getElementById('groups'),
    log: document.getElementById('log'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnSyncAll: document.getElementById('btn-sync-all'),
    syncAllBadge: document.getElementById('sync-all-badge'),
    syncAllLabel: document.getElementById('sync-all-label'),
    syncAllIcon: document.getElementById('sync-all-icon'),
    refreshIcon: document.getElementById('refresh-icon'),
    historyIcon: document.getElementById('history-icon'),
    settingsIcon: document.getElementById('settings-icon'),
    searchIcon: document.getElementById('search-icon'),
    projectDirIcon: document.getElementById('project-dir-icon'),
    projectDirBadge: document.getElementById('project-dir-badge'),
    customActions: document.getElementById('custom-actions'),
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
  function setBusy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    const busy = busyCount > 0;
    [els.btnRefresh, els.btnSyncAll, els.btnClearState, ...els.customActions.querySelectorAll('button')].forEach(b => { b.disabled = busy; });
    if (els.btnRefresh) els.btnRefresh.classList.toggle('spinning', busy);
    if (els.consoleIndicator) els.consoleIndicator.classList.toggle('busy', busy);
  }

  function renderFilterChips(rows, counts) {
    if (!els.statusFilters) return;
    els.statusFilters.innerHTML = '';

    const needsActionCount = (counts.conflict || 0) + (counts.updated || 0) + (counts.missing_local || 0) + (counts.never_synced || 0);
    const starredCount = rows.filter(r => isFavorite(r.path)).length;

    const filterDefs = [
      { id: 'all', label: '全部', count: rows.length },
      { id: 'starred', label: '已收藏', count: starredCount, starred: true },
      { id: 'needs_action', label: '待处理', count: needsActionCount, alert: needsActionCount > 0 },
      { id: 'updated', label: '有更新', count: counts.updated || 0, alert: (counts.updated || 0) > 0 },
      { id: 'conflict', label: '冲突', count: counts.conflict || 0, conflict: (counts.conflict || 0) > 0 },
      { id: 'local_changed', label: '本地变更', count: counts.local_changed || 0 },
      { id: 'missing_local', label: '本地缺失', count: counts.missing_local || 0 },
      { id: 'synced', label: '已同步', count: counts.synced || 0 },
      { id: 'error', label: '错误', count: counts.error || 0, error: (counts.error || 0) > 0 }
    ];

    filterDefs.forEach(def => {
      // 0 计数的次要状态不占据空间
      if (def.count === 0 && !['all', 'starred', 'needs_action', 'synced'].includes(def.id)) return;

      const chip = document.createElement('div');
      let cls = `filter-chip${activeFilter === def.id ? ' active' : ''}`;
      if (def.starred) cls += ' is-starred';
      if (def.alert && def.count > 0) cls += ' has-alert';
      if (def.conflict && def.count > 0) cls += ' has-conflict';
      if (def.error && def.count > 0) cls += ' has-error';
      chip.className = cls;

      const labelSpan = document.createElement('span');
      if (def.starred) {
        labelSpan.innerHTML = '<span class="chip-star-icon">⭐</span> 已收藏';
      } else {
        labelSpan.textContent = def.label;
      }

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
    } else if (activeFilter === 'needs_action') {
      pool = rows.filter(r => r.direction === 'download' || r.direction === 'conflict' || r.status === 'never_synced');
    } else if (activeFilter !== 'all') {
      pool = rows.filter(r => r.status === activeFilter);
    }

    const shown = searching ? pool.filter(r => TableSearch.matchRow(r, searchTerms)) : pool;
    shown.forEach(r => { (buckets[r.status] || (buckets[r.status] = [])).push(r); });

    // 渲染快捷状态过滤按钮
    renderFilterChips(rows, counts);

    // 更新一键下载按钮状态
    const syncCount = (counts.updated || 0) + (counts.missing_local || 0);
    if (els.syncAllLabel && els.syncAllBadge && els.syncAllIcon) {
      if (syncCount === 0) {
        els.btnSyncAll.classList.add('all-synced');
        els.syncAllBadge.classList.add('hidden');
        els.syncAllLabel.textContent = '已全部同步';
        els.syncAllIcon.innerHTML = window.CSMIcons ? window.CSMIcons.check : '✓';
      } else {
        els.btnSyncAll.classList.remove('all-synced');
        els.syncAllBadge.classList.remove('hidden');
        els.syncAllBadge.textContent = String(syncCount);
        els.syncAllLabel.textContent = '下载所有更新';
        els.syncAllIcon.innerHTML = window.CSMIcons ? window.CSMIcons.downloadAll : '⬇';
      }
    }

    // 全同步极简健康状态看板
    const needsAttention = (counts.updated || 0) + (counts.missing_local || 0) + (counts.conflict || 0);
    if (els.allSyncedBanner) {
      if (rows.length > 0 && needsAttention === 0 && !searching && activeFilter === 'all') {
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

      // 针对有更新和本地缺失分组，提供表头级快捷批量下载
      if ((key === 'updated' || key === 'missing_local') && list.length > 0) {
        const batchBtn = document.createElement('button');
        batchBtn.type = 'button';
        batchBtn.className = 'group-batch-btn';
        batchBtn.innerHTML = `${window.CSMIcons ? window.CSMIcons.download : '⬇'} <span>下载此组 (${list.length})</span>`;
        batchBtn.title = `一键下载「${STATUS_LABELS[key].label}」分组下的全部 ${list.length} 个表`;
        batchBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadPaths(list.map(r => r.path));
        });
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
      p.innerHTML = `<img src="icons/empty-illustration.svg" class="empty-illustration" alt=""><span>${msg}</span>`;
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
    const rowClickable = row.direction === 'download'; // 点整行 = 下载，只在云端较新时生效
    const timesTip = `云端修改：${formatTime(row.cloudModifiedTime)}\n本地文件修改：${row.localMtime ? formatTime(row.localMtime) : '本地没有文件'}`;
    div.className = `row status-${row.status}${rowClickable ? ' clickable' : ''}`;
    div.dataset.path = row.path;
    if (rowClickable) div.addEventListener('click', () => { if (!busyPaths.has(row.path)) syncOne(row.path); });

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
    nameDiv.title = `${row.name}\n${row.path}`;

    tableMain.append(starBtn, nameDiv);

    const tableSub = document.createElement('div');
    tableSub.className = 'cell-sub-line table-sub-line';

    const pathSpan = document.createElement('span');
    pathSpan.className = 'table-path';
    setHighlighted(pathSpan, row.path);
    pathSpan.title = `本地相对路径: ${row.path}\n点击可在访达中定位`;
    pathSpan.addEventListener('click', e => {
      e.stopPropagation();
      revealLocal(row.path).then(res => {
        if (res) showToast(`已在访达中定位: ${row.name || row.path}`, 'info');
      });
    });

    tableSub.appendChild(pathSpan);
    tableCol.append(tableMain, tableSub);

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
      link.title = `在新标签页打开 Google 表格：\n${cloudLabel}`;
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
      userTag.title = `最后修改人：${row.cloudModifiedBy}`;
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
      const txt = document.createElement('span');
      txt.textContent = '本地与云端一致 · ';
      const locBtn = document.createElement('a');
      locBtn.className = 'reveal-link';
      locBtn.href = '#';
      locBtn.innerHTML = '在访达定位 📁';
      locBtn.title = `本地文件：${row.path}\n在访达中显示`;
      locBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        revealLocal(row.path).then(res => {
          if (res) showToast(`已在访达中定位: ${row.name || row.path}`, 'info');
        });
      });
      statusSub.append(txt, locBtn);
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
    if (verifyingPaths.has(row.path)) {
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
      btn.innerHTML = `${window.CSMIcons ? window.CSMIcons.download : '⬇'} <span>下载</span>`;
      btn.title = `云端较新：用云端表覆盖本地 xlsx\n${timesTip}`;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        syncOne(row.path);
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
    } else if (row.direction === 'conflict') {
      const cfBtn = document.createElement('button');
      cfBtn.type = 'button';
      cfBtn.className = 'row-btn conflict-btn';
      cfBtn.innerHTML = `${window.CSMIcons ? window.CSMIcons.alert : '⚠'} <span>解决冲突</span>`;
      cfBtn.title = `上次同步后云端和本地都改过，不能自动决定方向。\n查看差异后选择保留哪一边。\n${timesTip}`;
      cfBtn.addEventListener('click', e => {
        e.stopPropagation();
        openDiff(row.path, 'conflict');
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
      if (resp.ok) {
        render(data);
        if (!knownAlerts) knownAlerts = new Set(alertRows(data).map(alertKey));
        const stale = resp.headers.get('X-CSM-Stale');
        if (stale) {
          // 启动时先显示上次的云端状态，后台刷新（批量查询，通常几秒内完成）
          els.lastRefresh.textContent = `显示的是 ${formatTime(stale) || '上次'} 的云端状态，正在后台刷新…`;
          backgroundRefresh();
        } else verifyUpdates(data);
      } else appendLog(`! /api/tables error: ${data.error}\n`);
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
      if (resp.ok) { render(data); markRefreshed(data, false); appendLog('✓ 刷新完成\n'); verifyUpdates(data); }
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
    const summary = { successCount: 0, failedCount: 0 };
    return new Promise((done) => {
      const resolve = () => done(summary);
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
        await consumeSSE(response, resolve, summary);
      }).catch(err => {
        appendLog(`! ${err.message}\n`);
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
        appendLog(obj.success ? `✓ ${obj.path}\n` : `✗ ${obj.path}${obj.error ? ': ' + obj.error : ''}\n`);
      } catch (_) {}
    } else if (event === 'done') {
      try {
        const obj = JSON.parse(data);
        if (summary) Object.assign(summary, obj);
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

  // 下载一批表（主列表、清单弹窗、差异预览共用）：结束后刷新列表，并按偏好执行「下载后动作」
  async function downloadPaths(paths) {
    setBusy(true);
    try {
      const summary = await streamSync(paths);
      releaseRows(paths);
      await loadTables();
      await runAfterDownload(summary);
      return summary;
    } finally {
      setBusy(false);
    }
  }

  function openDiff(p, mode) {
    if (window.CSMPanels) return window.CSMPanels.openDiff(p, { mode });
    return Promise.resolve(null);
  }

  async function syncOne(p) {
    await downloadPaths([p]);
  }

  async function syncAllUpdated() {
    setBusy(true);
    const resp = await fetch(api('/tables'));
    if (!resp.ok) { appendLog('! 无法获取列表\n'); setBusy(false); return; }
    const rows = await resp.json();
    // 只下载云端较新（或本地缺失）的表；本地较新的不覆盖，留给用户逐个确认上传
    const paths = rows.filter(r => r.direction === 'download').map(r => r.path);
    const localNewer = rows.filter(r => r.direction === 'upload');
    const conflicts = rows.filter(r => r.direction === 'conflict');
    if (localNewer.length) appendLog(`（${localNewer.length} 张表本地较新，不会被下载覆盖：${localNewer.map(r => r.name).join('、')}）\n`);
    if (conflicts.length) appendLog(`（⚠ ${conflicts.length} 张表两边都改过，需逐个查看差异后处理：${conflicts.map(r => r.name).join('、')}）\n`);
    if (paths.length === 0) {
      appendLog('（没有需要下载的表）\n');
      setBusy(false);
      return;
    }
    await downloadPaths(paths);
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
    clearDiagnostic();
    appendLog(`→ ${action.label}…\n`);
    const actionLogs = [];
    try {
      const response = await fetch(api(`/action/${encodeURIComponent(action.id)}`), { method: 'POST' });
      if (!response.ok) {
        appendLog(`! action ${action.id} HTTP ${response.status}\n`);
        return;
      }
      const summary = { exitCode: null, successCount: null, failedCount: null };
      await new Promise(resolve => consumeSSE(response, resolve, summary, l => actionLogs.push(l)));

      // 诊断：若退出码不为 0 则智能分析日志
      if (summary.exitCode !== 0 && summary.exitCode != null) {
        if (window.ActionErrorParser) {
          const diag = window.ActionErrorParser.parseActionError(actionLogs.join('\n'), lastRows || []);
          if (diag) showDiagnostic(action, diag);
        }
      }
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

  async function runAfterDownload(summary) {
    if (!summary || !summary.successCount) return;
    const id = lsGet(afterKey());
    const action = id && (appConfig.actions || []).find(a => a.id === id);
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

  function markRefreshed(rows, notify) {
    lastRefreshAt = Date.now();
    els.lastRefresh.textContent = `上次刷新 ${new Date(lastRefreshAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    const fresh = alertRows(rows).filter(r => !knownAlerts || !knownAlerts.has(alertKey(r)));
    const first = !knownAlerts;
    knownAlerts = new Set(alertRows(rows).map(alertKey));
    if (first || !notify || fresh.length === 0) return;
    const conflicts = fresh.filter(r => r.direction === 'conflict');
    const names = fresh.slice(0, 5).map(r => r.name).join('、') + (fresh.length > 5 ? ` 等 ${fresh.length} 张` : '');
    appendLog(`🔔 自动刷新发现 ${fresh.length} 张表云端有更新${conflicts.length ? `（其中 ${conflicts.length} 张冲突）` : ''}：${names}\n`);
    if (els.prefNotify.checked && 'Notification' in window && Notification.permission === 'granted') {
      const project = (projects.find(x => x.id === currentId) || {}).name || 'CSM';
      const n = new Notification(`CSM · ${project}：${fresh.length} 张表云端有更新`, {
        body: (conflicts.length ? `⚠ ${conflicts.length} 张冲突需人工处理\n` : '') + names,
        tag: `csm-${currentId}`
      });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }

  async function silentRefresh() {
    if (!currentId || busyCount > 0 || document.querySelector('.modal:not(.hidden)')) return;
    const id = currentId;
    try {
      const resp = await fetch(api('/refresh'), { method: 'POST' });
      if (!resp.ok || id !== currentId) return;
      const data = await resp.json();
      render(data);
      const verified = await verifyUpdates(data);
      if (id !== currentId) return;
      markRefreshed(verified || data, true);
    } catch (_) { /* 网络问题等下次 */ }
  }

  // 启动时用了上次的云端状态：后台刷新一次，再核对内容
  async function backgroundRefresh() {
    const id = currentId;
    try {
      const resp = await fetch(api('/refresh'), { method: 'POST' });
      const data = await resp.json().catch(() => null);
      if (id !== currentId) return;
      if (!resp.ok || !data) {
        els.lastRefresh.textContent = '后台刷新失败，显示的是上次的云端状态';
        if (data && data.error) appendLog(`! 后台刷新失败：${data.error}\n`);
        return;
      }
      render(data);
      knownAlerts = null; // 以刷新后的结果为基准，不把启动前就有的更新当成新提醒
      markRefreshed(data, false);
      await verifyUpdates(data);
    } catch (err) {
      if (id === currentId) els.lastRefresh.textContent = '后台刷新失败，显示的是上次的云端状态';
    }
  }

  // 「有更新 / 冲突 / 本地变更」的表：修改时间或文件字节变了不代表内容变了，导出云端与本地比较，内容一致的自动记为已同步
  const VERIFY_STATUSES = new Set(['updated', 'conflict', 'local_changed']);
  let verifyRun = null;
  async function verifyUpdates(rows) {
    const id = currentId;
    const paths = (rows || []).filter(r => VERIFY_STATUSES.has(r.status)).map(r => r.path);
    if (!paths.length) return rows;
    if (verifyRun) return verifyRun; // 同一时间只跑一轮
    verifyRun = (async () => {
      paths.forEach(p => verifyingPaths.add(p));
      render();
      try {
        const resp = await fetch(api('/verify'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
        const data = await resp.json().catch(() => ({}));
        if (id !== currentId || !resp.ok) return rows;
        const same = data.results.filter(r => r.identical);
        const failed = data.results.filter(r => r.error);
        if (same.length) {
          const byPath = new Map((rows || []).map(r => [r.path, r]));
          const nameOf = r => (byPath.get(r.path) || {}).name || r.path;
          const localOnly = same.filter(r => r.previousStatus === 'local_changed');
          const cloud = same.filter(r => r.previousStatus !== 'local_changed');
          if (cloud.length) appendLog(`✓ 内容核对：${cloud.length} 张表云端只是修改时间变了，内容与本地一致，已标为已同步：${cloud.map(nameOf).join('、')}\n`);
          if (localOnly.length) appendLog(`✓ 内容核对：${localOnly.length} 张表本地文件被重新保存过但内容与云端一致，已标为已同步：${localOnly.map(nameOf).join('、')}\n`);
        }
        failed.forEach(r => appendLog(`! 内容核对失败 ${r.path}：${r.error}\n`));
        return data.tables;
      } catch (_) {
        return rows;
      } finally {
        paths.forEach(p => verifyingPaths.delete(p));
      }
    })();
    try {
      const result = await verifyRun;
      if (id === currentId) render(result && result !== rows ? result : undefined);
      return result;
    } finally {
      verifyRun = null;
    }
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
    if (els.prefNotify.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission().catch(() => 'denied');
      if (perm !== 'granted') {
        els.prefNotify.checked = false;
        appendLog('! 系统未允许通知：请在「系统设置 → 通知」中允许 CSM（或浏览器）发送通知\n');
      }
    }
    lsSet(PREF_NOTIFY, els.prefNotify.checked ? '1' : '');
  });
  els.prefAfterDownload.addEventListener('change', () => lsSet(afterKey(), els.prefAfterDownload.value));
  window.addEventListener('focus', () => {
    if ((parseInt(els.prefAutoRefresh.value, 10) || 0) > 0 && Date.now() - lastRefreshAt > FOCUS_REFRESH_MS) silentRefresh();
  });

  async function loadConfig() {
    appConfig = { allowUpload: true, actions: [] };
    try {
      const resp = await fetch(api('/config'));
      const data = await resp.json();
      if (resp.ok) appConfig = data;
      else appendLog(`! 项目配置错误: ${data.error}\n`);
    } catch (_) { /* 用默认值 */ }
    els.customActions.innerHTML = '';
    (appConfig.actions || []).filter(a => !a.hidden && a.id !== 'gen-localization').forEach(action => {
      const b = document.createElement('button');
      b.type = 'button';
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

      const icon = document.createElement('span');
      icon.className = 'tab-icon';
      icon.innerHTML = window.CSMIcons ? window.CSMIcons.sheet : '📄';

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = p.name;

      const close = document.createElement('span');
      close.className = 'tab-close';
      close.innerHTML = window.CSMIcons ? window.CSMIcons.close : '✕';
      close.title = '从平台移除（不会删除任何文件）';
      close.addEventListener('click', e => { e.stopPropagation(); removeProject(p); });

      tab.append(icon, label, close);
      tab.addEventListener('click', () => selectProject(p.id));
      tab.addEventListener('dblclick', () => renameProject(p));
      els.projectTabs.appendChild(tab);
    });

    const btnPrev = document.getElementById('btn-nav-prev');
    const btnNext = document.getElementById('btn-nav-next');
    if (btnPrev && btnNext) {
      const idx = projects.findIndex(p => p.id === currentId);
      btnPrev.disabled = idx <= 0;
      btnNext.disabled = idx < 0 || idx >= projects.length - 1;
    }
  }

  async function selectProject(id) {
    currentId = id;
    try { localStorage.setItem(PROJECT_KEY, id); } catch (_) {}
    renderTabs();
    groupExpandedState.clear();
    lastRows = null; // 换项目后不能再拿旧项目的列表做搜索
    activeFilter = 'all';
    knownAlerts = null;
    lastRefreshAt = 0;
    els.lastRefresh.textContent = '';
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
      els.groups.innerHTML = '<div class="empty-tip"><img src="icons/empty-illustration.svg" class="empty-illustration" alt=""><span>还没有项目，点右上方「＋ 添加项目」选择配置表目录</span></div>';
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

  els.btnRefresh.addEventListener('click', () => {
    refresh();
    showToast('正在刷新云端状态…', 'info');
  });
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
        if (els.authBanner) els.authBanner.classList.remove('hidden');
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
    if (els.projectSettingsDir) els.projectSettingsDir.textContent = p ? p.dir : '未配置';
    if (els.projectSettingsModal) els.projectSettingsModal.classList.remove('hidden');
  }
  const closeProjectSettings = () => els.projectSettingsModal && els.projectSettingsModal.classList.add('hidden');

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
    if (e.key === 'Escape') {
      els.search.value = '';
      searchTerms = [];
      render();
      els.search.blur();
    } else if (e.key === 'Enter') {
      // 回车：只命中一个表时直接下载它
      const hits = (lastRows || []).filter(r => TableSearch.matchRow(r, searchTerms));
      if (searchTerms.length && hits.length === 1 && !busyPaths.has(hits[0].path)) {
        if (hits[0].direction === 'download') syncOne(hits[0].path);
        else if (hits[0].direction === 'conflict') openDiff(hits[0].path, 'conflict');
      }
    }
  });

  // ---------- 全局快捷键体系（Keyboard-First） ----------
  document.addEventListener('keydown', e => {
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
      showToast('正在刷新云端状态…', 'info');
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
    }
  });

  // 初始化账号授权状态与全局胶囊
  updateAuthStatusUI();

  loadProjects();
})();
