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
    btnSettings: document.getElementById('btn-settings'),
    settingsModal: document.getElementById('settings-modal'),
    settingsProject: document.getElementById('settings-project'),
    settingsVersion: document.getElementById('settings-version'),
    consoleDrawer: document.getElementById('console-drawer'),
    consoleBar: document.getElementById('console-bar'),
    consoleIndicator: document.getElementById('console-indicator'),
    consolePreview: document.getElementById('console-preview'),
    btnToggleLog: document.getElementById('btn-toggle-log'),
    consoleToggleText: document.getElementById('console-toggle-text'),
    allSyncedBanner: document.getElementById('all-synced-banner'),
    allSyncedMeta: document.getElementById('all-synced-meta'),
    toastContainer: document.getElementById('toast-container')
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

    const filterDefs = [
      { id: 'all', label: '全部', count: rows.length },
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
      if (def.count === 0 && !['all', 'needs_action', 'synced'].includes(def.id)) return;

      const chip = document.createElement('div');
      let cls = `filter-chip${activeFilter === def.id ? ' active' : ''}`;
      if (def.alert && def.count > 0) cls += ' has-alert';
      if (def.conflict && def.count > 0) cls += ' has-conflict';
      if (def.error && def.count > 0) cls += ' has-error';
      chip.className = cls;

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
    if (activeFilter === 'needs_action') {
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
      list.forEach(row => body.appendChild(renderRow(row)));
      group.appendChild(body);
      els.groups.appendChild(group);
    }

    if (rows.length === 0) {
      els.groups.innerHTML = '<div class="empty-tip"><img src="icons/empty-illustration.svg" class="empty-illustration" alt=""><span>没有可用的表（请检查 filelist.json）</span></div>';
    } else if (renderedCount === 0) {
      const p = document.createElement('div');
      p.className = 'empty-tip';
      p.innerHTML = `<img src="icons/empty-illustration.svg" class="empty-illustration" alt=""><span>${searching ? `没有匹配「${els.search.value.trim()}」的配置表` : '当前筛选条件下没有表格'}</span>`;
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

    const iconCell = document.createElement('span');
    iconCell.className = 'icon';
    iconCell.innerHTML = window.CSMIcons ? window.CSMIcons.status[row.status] : STATUS_LABELS[row.status].icon;

    const nameCol = document.createElement('div');
    nameCol.className = 'name-col';

    const nameRow = document.createElement('div');
    nameRow.className = 'name-row';

    const nameDiv = document.createElement('span');
    nameDiv.className = 'name';
    setHighlighted(nameDiv, row.name);
    nameDiv.title = row.path;

    const pathSpan = document.createElement('span');
    pathSpan.className = 'row-path';
    setHighlighted(pathSpan, row.path);
    nameRow.append(nameDiv, pathSpan);

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
      const textSpan = document.createElement('span');
      setHighlighted(textSpan, label);
      link.appendChild(textSpan);
      if (window.CSMIcons) {
        const extSpan = document.createElement('span');
        extSpan.innerHTML = window.CSMIcons.external;
        link.appendChild(extSpan);
      }
      link.title = '在新标签页打开云端配置表';
      link.addEventListener('click', e => e.stopPropagation());
      metaDiv.appendChild(link);
    } else {
      setHighlighted(metaDiv, label);
    }
    nameCol.append(nameRow, metaDiv);

    // 「云端」微胶囊：点击打开云端表
    const cloudCell = document.createElement('div');
    cloudCell.className = 'meta cloud-col';
    if (row.spreadsheetId) {
      const pill = document.createElement('a');
      pill.className = 'meta-pill cloud-pill';
      pill.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(row.spreadsheetId)}/edit`;
      pill.target = '_blank';
      pill.rel = 'noopener noreferrer';
      const icon = document.createElement('span');
      icon.className = 'meta-pill-icon';
      icon.innerHTML = window.CSMIcons ? window.CSMIcons.cloud : '☁';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'meta-pill-time';
      timeSpan.textContent = row.cloudModifiedTime ? formatTime(row.cloudModifiedTime) : '—';
      pill.append(icon, timeSpan);
      if (row.cloudModifiedBy) {
        const userTag = document.createElement('span');
        userTag.className = 'user-tag';
        userTag.textContent = `@${row.cloudModifiedBy}`;
        userTag.title = `最后修改人：${row.cloudModifiedBy}`;
        pill.appendChild(userTag);
      }
      pill.title = row.cloudModifiedBy ? `打开 Google 表格\n最后修改人：${row.cloudModifiedBy}\n时间：${formatTime(row.cloudModifiedTime)}` : '打开 Google 表格';
      pill.addEventListener('click', e => e.stopPropagation());
      cloudCell.appendChild(pill);
    } else {
      cloudCell.innerHTML = '<span class="meta-pill meta-pill-empty">未关联云端表</span>';
    }

    // 「本地」微胶囊：点击在访达中定位本地文件
    const localCell = document.createElement('div');
    localCell.className = 'meta local-col';
    if (row.error) {
      localCell.innerHTML = `<span class="meta-pill local-pill-error" title="${row.error}">错误: ${row.error}</span>`;
    } else {
      const pill = document.createElement('a');
      pill.className = `meta-pill local-pill ${row.localExists ? '' : 'local-missing'}`;
      pill.href = '#';
      const icon = document.createElement('span');
      icon.className = 'meta-pill-icon';
      icon.innerHTML = window.CSMIcons ? window.CSMIcons.laptop : '💻';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'meta-pill-time';
      timeSpan.textContent = row.lastSyncedModifiedTime ? formatTime(row.lastSyncedModifiedTime) : (row.localExists ? '未记录同步' : '本地缺失');
      pill.append(icon, timeSpan);
      pill.title = row.localExists ? `本地文件：${row.path}\n在访达中显示` : '本地还没有这个文件，点击打开所在目录';
      pill.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        revealLocal(row.path).then(res => {
          if (res) showToast(`已在访达中定位: ${row.name || row.path}`, 'info');
        });
      });
      localCell.appendChild(pill);
    }

    div.appendChild(iconCell);
    div.appendChild(nameCol);
    div.appendChild(cloudCell);
    div.appendChild(localCell);

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

  async function consumeSSE(response, onComplete, summary) {
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

  // ---------- 偏好（本机）：自动刷新 / 通知 / 下载后动作 ----------
  const PREF_AUTO = 'csm.autoRefreshMin';
  const PREF_NOTIFY = 'csm.notify';
  const afterKey = () => `csm.afterDownload.${currentId}`;
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} };

  function renderAfterDownloadPref() {
    const actions = appConfig.actions || [];
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
    (appConfig.actions || []).forEach(action => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${window.CSMIcons ? window.CSMIcons.terminal : ''} <span>${action.label}</span>`;
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
      icon.innerHTML = window.CSMIcons ? window.CSMIcons.folder : '📁';

      const label = document.createElement('span');
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
  function toggleConsole() {
    if (!els.consoleDrawer) return;
    const isCollapsed = els.consoleDrawer.classList.toggle('collapsed');
    if (els.consoleToggleText) els.consoleToggleText.textContent = isCollapsed ? '展开' : '收起';
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

  // ---------- 设置弹窗：本机偏好 + 当前项目的管理操作（控件本身的逻辑在上面 / filelist-manager.js） ----------
  function openSettings() {
    const p = projects.find(x => x.id === currentId);
    els.settingsProject.textContent = p ? p.name : '';
    els.settingsVersion.textContent = document.getElementById('app-title').title || '';
    els.settingsModal.classList.remove('hidden');
  }
  const closeSettings = () => els.settingsModal.classList.add('hidden');
  els.btnSettings.addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-done').addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', e => { if (e.target === els.settingsModal) closeSettings(); });
  // 这两个会打开别的弹窗 / 确认框：先关掉设置，避免叠在下面
  for (const b of [document.getElementById('btn-filelist'), els.btnClearState]) b.addEventListener('click', closeSettings, true);

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
      if (els.settingsModal && !els.settingsModal.classList.contains('hidden')) { closeSettings(); return; }
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

    // 4. ⌘, / Ctrl+,: 打开设置
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      openSettings();
      return;
    }

    // 5. ⌘/ 或 ?: 快捷键指南（打开设置弹窗并滚动至快捷键）
    if (((e.metaKey || e.ctrlKey) && e.key === '/') || (e.key === '?' && !typing && !anyModalOpen)) {
      e.preventDefault();
      openSettings();
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

  // 还没有项目时也提示授权（桌面 App 不会像命令行那样启动即打开授权页）
  fetch('/api/auth-status').then(r => r.json()).then(s => {
    if (!s.authorized) els.authBanner.classList.remove('hidden');
  }).catch(() => {});

  loadProjects();
})();
