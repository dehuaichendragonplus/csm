// 全局在线文档收藏与管理 (Global Document Bookmarks)
// 纯本地存储，管理钉钉、飞书、Google 等在线文档外链，支持全局快捷直达与项目/通用分类管理。
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const el = {
    // 顶部 Row 1 全局快捷组件
    widget: $('bookmarks-widget'),
    btnDropdown: $('btn-bookmarks-dropdown'),
    dropdownMenu: $('bookmarks-dropdown-menu'),
    badge: $('bookmarks-badge'),
    quickAdd: $('btn-bm-quick-add'),
    dropdownList: $('bm-dropdown-list'),
    openManager: $('btn-bm-open-manager'),

    // 文档管理列表弹窗
    modal: $('doc-modal'),
    close: $('doc-close'),
    tabAll: $('doc-tab-all'),
    tabGlobal: $('doc-tab-global'),
    tabProject: $('doc-tab-project'),
    tableProjectFilter: $('doc-table-project-filter'),
    countAll: $('doc-count-all'),
    countGlobal: $('doc-count-global'),
    countProject: $('doc-count-project'),
    filter: $('doc-filter'),
    filterClear: $('doc-filter-clear'),
    btnAdd: $('doc-btn-add'),
    tbody: $('doc-tbody'),

    // 新增 / 编辑文档弹窗
    editModal: $('doc-edit-modal'),
    editClose: $('doc-edit-close'),
    editTitle: $('doc-edit-title'),
    inputTitle: $('doc-input-title'),
    inputUrl: $('doc-input-url'),
    cardGlobal: $('card-scope-global'),
    cardProject: $('card-scope-project'),
    scopeGlobal: $('doc-scope-global'),
    scopeProject: $('doc-scope-project'),
    pickerGroup: $('doc-project-picker-group'),
    selectProject: $('doc-select-project'),
    urlDetectChip: $('doc-url-detect-chip'),
    inputDesc: $('doc-input-desc'),
    msg: $('doc-edit-msg'),
    btnCancel: $('doc-edit-cancel'),
    btnSave: $('doc-edit-save')
  };

  let bookmarks = [];
  let allProjects = [];
  let currentTab = 'all'; // 'all' | 'global' | 'project'
  let selectedFilterProject = ''; // 选中特定项目 ID 进行筛选
  let searchTerm = '';
  let editingId = null; // null 为新增，string 为编辑项 ID

  const api = async (url, opts) => {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  };

  function getCurrentProjectId() {
    return window.CSM && typeof window.CSM.currentId === 'function' ? window.CSM.currentId() : null;
  }

  function getProjectNameById(projId) {
    if (!projId) return '';
    const p = allProjects.find(x => x.id === projId);
    return p ? p.name : projId;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function detectPlatform(url, title = '') {
    if (!url) return { icon: '🌐', name: 'Web 链接', tagClass: 'tag-web', chipClass: 'chip-web', tipText: '在线网页链接 · 格式有效' };
    const u = url.toLowerCase();
    const t = (title || '').toLowerCase();
    if (u.includes('jira') || t.includes('jira')) {
      return { icon: '🔷', name: 'Jira', tagClass: 'tag-jira', chipClass: 'chip-jira', tipText: '🔷 Jira 项目协同 · 已智能识别' };
    }
    if (u.includes('jenkins') || u.includes('jinkens') || t.includes('jenkins') || t.includes('jinkens')) {
      return { icon: '🤵', name: 'Jenkins', tagClass: 'tag-jenkins', chipClass: 'chip-jenkins', tipText: '🔴 Jenkins 流水线 · 已智能识别' };
    }
    if (u.includes('alidocs.dingtalk.com') || u.includes('dingtalk.com') || t.includes('钉钉')) {
      return { icon: '📑', name: '钉钉文档', tagClass: 'tag-ding', chipClass: 'chip-ding', tipText: '📑 钉钉在线文档 / 多维表格 · 已智能识别' };
    }
    if (u.includes('docs.google.com') || u.includes('sheets.google.com') || u.includes('drive.google.com') || t.includes('google')) {
      return { icon: '📊', name: 'Google Sheets', tagClass: 'tag-google', chipClass: 'chip-google', tipText: '📊 Google Sheets 表格 · 已智能识别' };
    }
    if (u.includes('feishu.cn') || u.includes('larksuite.com') || t.includes('飞书')) {
      return { icon: '🪶', name: '飞书文档', tagClass: 'tag-feishu', chipClass: 'chip-feishu', tipText: '🪶 飞书文档 · 已智能识别' };
    }
    if (u.includes('github.com')) {
      return { icon: '🐙', name: 'GitHub', tagClass: 'tag-github', chipClass: 'chip-github', tipText: '🐙 GitHub 仓库 · 已智能识别' };
    }
    if (u.includes('gitlab')) {
      return { icon: '🦊', name: 'GitLab', tagClass: 'tag-gitlab', chipClass: 'chip-gitlab', tipText: '🦊 GitLab 项目 · 已智能识别' };
    }
    return { icon: '🌐', name: '在线链接', tagClass: 'tag-web', chipClass: 'chip-web', tipText: '🌐 在线网页链接 · 格式有效' };
  }

  function openSafeUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '已复制!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1500);
      }
    } catch (_) {
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      if (btn) {
        btn.textContent = '已复制!';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      }
    }
  }

  // ---------- 项目列表加载与选项填充 ----------
  async function loadProjectsList() {
    // 1. 优先读取客户端已缓存的项目列表（零延迟）
    if (window.CSM && typeof window.CSM.getProjects === 'function') {
      const cached = window.CSM.getProjects();
      if (Array.isArray(cached) && cached.length > 0) {
        allProjects = cached;
        renderProjectOptions();
      }
    }
    // 2. 异步请求接口确保同步最新
    try {
      const list = await api('/api/projects');
      if (Array.isArray(list) && list.length > 0) {
        allProjects = list;
        renderProjectOptions();
      }
    } catch (e) {
      console.warn('[bookmarks] load projects failed:', e);
    }
  }

  function renderProjectOptions() {
    // 1. 填充新增/编辑弹窗中的项目下拉框
    if (el.selectProject) {
      const curSelectVal = el.selectProject.value;
      if (allProjects.length === 0) {
        el.selectProject.innerHTML = '<option value="">暂无已添加的项目</option>';
      } else {
        const curProjId = getCurrentProjectId();
        el.selectProject.innerHTML = allProjects.map(p =>
          `<option value="${escapeHtml(p.id)}">📁 ${escapeHtml(p.name)} (${escapeHtml(p.dir)})</option>`
        ).join('');
        if (curSelectVal && allProjects.some(p => p.id === curSelectVal)) {
          el.selectProject.value = curSelectVal;
        } else if (curProjId && allProjects.some(p => p.id === curProjId)) {
          el.selectProject.value = curProjId;
        } else if (allProjects[0]) {
          el.selectProject.value = allProjects[0].id;
        }
      }
    }

    // 2. 填充管理列表表格上方的项目筛选器
    if (el.tableProjectFilter) {
      const curFilterVal = el.tableProjectFilter.value;
      let opts = '<option value="">所有项目专属文档</option>';
      allProjects.forEach(p => {
        opts += `<option value="${escapeHtml(p.id)}">📁 ${escapeHtml(p.name)}</option>`;
      });
      el.tableProjectFilter.innerHTML = opts;
      if (curFilterVal && allProjects.some(p => p.id === curFilterVal)) {
        el.tableProjectFilter.value = curFilterVal;
      }
    }
  }

  // ---------- 数据获取与刷新 ----------
  async function refreshBookmarks() {
    try {
      await loadProjectsList();
      // 全局功能：获取所有文档
      const data = await api('/api/bookmarks');
      bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];

      const gCount = bookmarks.filter(b => b.scope === 'global').length;
      const pCount = bookmarks.filter(b => b.scope === 'project').length;
      const totalCount = bookmarks.length;

      // 更新顶部 Row 1 按钮角标
      if (el.badge) {
        el.badge.textContent = totalCount;
        el.badge.classList.toggle('hidden', totalCount === 0);
      }

      // 更新弹窗 Tab 计数
      if (el.countAll) el.countAll.textContent = totalCount;
      if (el.countGlobal) el.countGlobal.textContent = gCount;
      if (el.countProject) el.countProject.textContent = pCount;

      renderDropdown();
      renderTable();
    } catch (err) {
      console.error('[bookmarks] refresh failed:', err);
    }
  }

  // ---------- 渲染顶部 Row 1 快捷下拉菜单 ----------
  function renderDropdown() {
    if (!el.dropdownList) return;

    if (bookmarks.length === 0) {
      el.dropdownList.innerHTML = `
        <div class="bm-empty-tip">
          暂无文档收藏<br>
          <span style="color:var(--text-tertiary);font-size:11px;margin-top:4px;display:inline-block;">点击右上角「➕ 新增」开始收藏钉钉、飞书或在线表格</span>
        </div>
      `;
      return;
    }

    const currentProjId = getCurrentProjectId();
    const globalDocs = bookmarks.filter(b => b.scope === 'global');
    const projectDocs = bookmarks.filter(b => b.scope === 'project');

    let html = '';

    // 1. 全局通用文档分组
    if (globalDocs.length > 0) {
      html += `<div class="bm-section-title">🌐 全局通用文档 (${globalDocs.length})</div>`;
      for (const b of globalDocs) {
        const plat = detectPlatform(b.url);
        html += renderDropdownItemHtml(b, plat);
      }
    }

    // 2. 当前打开项目的专属文档（优先置顶展示）
    if (currentProjId) {
      const curProjDocs = projectDocs.filter(b => b.projectId === currentProjId);
      if (curProjDocs.length > 0) {
        const projName = getProjectNameById(currentProjId);
        html += `<div class="bm-section-title">📌 当前项目: ${escapeHtml(projName)} (${curProjDocs.length})</div>`;
        for (const b of curProjDocs) {
          const plat = detectPlatform(b.url);
          html += renderDropdownItemHtml(b, plat);
        }
      }
    }

    // 3. 其余项目的专属文档（按项目分组）
    const otherProjects = allProjects.filter(p => !currentProjId || p.id !== currentProjId);
    for (const proj of otherProjects) {
      const pDocs = projectDocs.filter(b => b.projectId === proj.id);
      if (pDocs.length > 0) {
        html += `<div class="bm-section-title">📁 ${escapeHtml(proj.name)} (${pDocs.length})</div>`;
        for (const b of pDocs) {
          const plat = detectPlatform(b.url);
          html += renderDropdownItemHtml(b, plat);
        }
      }
    }

    // 4. 未匹配到已知项目的项目文档（兜底）
    const knownIds = new Set(allProjects.map(p => p.id));
    const orphanDocs = projectDocs.filter(b => b.projectId && !knownIds.has(b.projectId));
    if (orphanDocs.length > 0) {
      html += `<div class="bm-section-title">📁 其他项目 (${orphanDocs.length})</div>`;
      for (const b of orphanDocs) {
        const plat = detectPlatform(b.url);
        html += renderDropdownItemHtml(b, plat);
      }
    }

    el.dropdownList.innerHTML = html;

    // 绑定条目跳转点击事件
    el.dropdownList.querySelectorAll('.bm-item').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        const url = item.getAttribute('data-url');
        openSafeUrl(url);
        closeDropdown();
      });
    });
  }

  function renderDropdownItemHtml(b, plat) {
    const favUrl = `/api/favicon?url=${encodeURIComponent(b.url)}&title=${encodeURIComponent(b.title || '')}`;
    return `
      <div class="bm-item" data-url="${escapeHtml(b.url)}" title="${escapeHtml(b.title + (b.description ? ' - ' + b.description : ''))}">
        <div class="bm-item-left">
          <span class="bm-item-icon">
            <img class="bm-favicon" src="${escapeHtml(favUrl)}" alt="" loading="lazy" />
          </span>
          <div class="bm-item-info">
            <div class="bm-item-title">${escapeHtml(b.title)}</div>
            ${b.description ? `<div class="bm-item-desc">${escapeHtml(b.description)}</div>` : ''}
          </div>
        </div>
        <span class="bm-item-ext" title="在新窗口打开">↗</span>
      </div>
    `;
  }

  function toggleDropdown() {
    if (!el.dropdownMenu) return;
    const isHidden = el.dropdownMenu.classList.contains('hidden');
    if (isHidden) {
      openDropdown();
    } else {
      closeDropdown();
    }
  }

  function openDropdown() {
    if (!el.dropdownMenu || !el.btnDropdown) return;
    el.dropdownMenu.classList.remove('hidden');
    el.btnDropdown.classList.add('active');
  }

  function closeDropdown() {
    if (!el.dropdownMenu || !el.btnDropdown) return;
    el.dropdownMenu.classList.add('hidden');
    el.btnDropdown.classList.remove('active');
  }

  // ---------- 渲染管理列表表格 ----------
  function renderTable() {
    if (!el.tbody) return;

    let list = bookmarks.slice();

    // 1. Tab 过滤
    if (currentTab === 'global') {
      list = list.filter(b => b.scope === 'global');
    } else if (currentTab === 'project') {
      list = list.filter(b => b.scope === 'project');
      if (selectedFilterProject) {
        list = list.filter(b => b.projectId === selectedFilterProject);
      }
    } else if (currentTab === 'all' && selectedFilterProject) {
      list = list.filter(b => b.scope === 'project' && b.projectId === selectedFilterProject);
    }

    // 2. 关键词搜索
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(b => {
        const projName = getProjectNameById(b.projectId).toLowerCase();
        return (
          (b.title && b.title.toLowerCase().includes(q)) ||
          (b.url && b.url.toLowerCase().includes(q)) ||
          (b.description && b.description.toLowerCase().includes(q)) ||
          projName.includes(q)
        );
      });
    }

    if (list.length === 0) {
      el.tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center;padding:48px 16px;color:var(--text-tertiary);">
            ${searchTerm ? '未找到符合条件的文档收藏' : '暂无文档收藏，点击右上角「新增文档收藏」添加'}
          </td>
        </tr>
      `;
      return;
    }

    let rowsHtml = '';

    for (const b of list) {
      const plat = detectPlatform(b.url);
      const isGlobal = b.scope === 'global';
      const projName = isGlobal ? '全局通用' : getProjectNameById(b.projectId);
      const scopeLabel = isGlobal ? '🌐 全局通用' : `📁 ${projName}`;
      const scopeClass = isGlobal ? 'tag-global' : 'tag-project';

      rowsHtml += `
        <tr data-id="${escapeHtml(b.id)}">
          <td style="text-align: center;">
            <span class="doc-platform-badge" title="${escapeHtml(plat.name)}">
              <img class="bm-table-favicon" src="/api/favicon?url=${encodeURIComponent(b.url)}&title=${encodeURIComponent(b.title || '')}" alt="" loading="lazy" />
            </span>
          </td>
          <td>
            <div class="doc-name-cell">
              <strong class="doc-title-text">${escapeHtml(b.title)}</strong>
              ${b.description ? `<span class="doc-desc-text">${escapeHtml(b.description)}</span>` : ''}
            </div>
          </td>
          <td>
            <div class="doc-link-wrap">
              <a href="#" class="doc-link-url" data-url="${escapeHtml(b.url)}" title="${escapeHtml(b.url)}">
                ${escapeHtml(b.url)}
              </a>
              <button type="button" class="btn-copy-url" data-url="${escapeHtml(b.url)}" title="复制完整链接">复制</button>
            </div>
          </td>
          <td>
            <span class="doc-scope-tag ${scopeClass}" title="${escapeHtml(scopeLabel)}">${escapeHtml(scopeLabel)}</span>
          </td>
          <td style="color:var(--text-secondary);font-size:12px;">
            ${escapeHtml(b.description || '-')}
          </td>
          <td style="text-align: right;">
            <div class="doc-actions-cell">
              <button type="button" class="btn-table-action btn-doc-jump" data-url="${escapeHtml(b.url)}" title="在新窗口打开链接">
                <span>打开 ↗</span>
              </button>
              <button type="button" class="btn-table-action btn-doc-edit" data-id="${escapeHtml(b.id)}" title="编辑此收藏">
                <span>编辑</span>
              </button>
              <button type="button" class="btn-table-action btn-doc-del btn-danger-hover" data-id="${escapeHtml(b.id)}" title="删除此收藏">
                <span>删除</span>
              </button>
            </div>
          </td>
        </tr>
      `;
    }

    el.tbody.innerHTML = rowsHtml;

    // 绑定表格内操作事件
    el.tbody.querySelectorAll('.doc-link-url, .btn-doc-jump').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const url = btn.getAttribute('data-url');
        openSafeUrl(url);
      });
    });

    el.tbody.querySelectorAll('.btn-copy-url').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const url = btn.getAttribute('data-url');
        copyText(url, btn);
      });
    });

    el.tbody.querySelectorAll('.btn-doc-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openEditModal(id);
      });
    });

    el.tbody.querySelectorAll('.btn-doc-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        handleDelete(id);
      });
    });
  }

  // ---------- 弹窗开启与关闭 ----------
  function openDocManagerModal() {
    if (!el.modal) return;
    closeDropdown();
    el.modal.classList.remove('hidden');
    refreshBookmarks();
    if (el.filter) {
      el.filter.value = '';
      searchTerm = '';
      if (el.filterClear) el.filterClear.classList.add('hidden');
    }
  }

  function closeDocManagerModal() {
    if (!el.modal) return;
    el.modal.classList.add('hidden');
  }

  function updateScopeCards() {
    const isGlobal = el.scopeGlobal && el.scopeGlobal.checked;
    if (el.cardGlobal) el.cardGlobal.classList.toggle('active', isGlobal);
    if (el.cardProject) el.cardProject.classList.toggle('active', !isGlobal);
    if (el.pickerGroup) el.pickerGroup.classList.toggle('hidden', isGlobal);
  }

  function updateUrlDetection() {
    if (!el.urlDetectChip || !el.inputUrl) return;
    const val = el.inputUrl.value.trim();
    if (!val) {
      el.urlDetectChip.classList.add('hidden');
      el.urlDetectChip.textContent = '';
      return;
    }
    if (!/^https?:\/\//i.test(val)) {
      el.urlDetectChip.className = 'doc-url-detect-chip chip-invalid';
      el.urlDetectChip.textContent = '⚠️ 链接格式需以 http:// 或 https:// 开头';
      el.urlDetectChip.classList.remove('hidden');
      return;
    }
    const titleVal = el.inputTitle ? el.inputTitle.value : '';
    const plat = detectPlatform(val, titleVal);
    const favUrl = `/api/favicon?url=${encodeURIComponent(val)}&title=${encodeURIComponent(titleVal)}`;
    el.urlDetectChip.className = `doc-url-detect-chip ${plat.chipClass}`;
    el.urlDetectChip.innerHTML = `<img src="${escapeHtml(favUrl)}" class="chip-favicon" alt="" /> <span>${escapeHtml(plat.tipText)}</span>`;
    el.urlDetectChip.classList.remove('hidden');
  }

  async function openEditModal(id = null) {
    if (!el.editModal) return;
    editingId = id;
    if (el.msg) {
      el.msg.textContent = '';
      el.msg.className = 'fl-msg';
    }

    await loadProjectsList();
    const currentProjId = getCurrentProjectId();

    if (id) {
      // 编辑已有项
      const item = bookmarks.find(b => b.id === id);
      if (!item) return;
      if (el.editTitle) el.editTitle.textContent = '编辑文档收藏';
      if (el.inputTitle) el.inputTitle.value = item.title || '';
      if (el.inputUrl) el.inputUrl.value = item.url || '';
      if (el.inputDesc) el.inputDesc.value = item.description || '';

      if (item.scope === 'global') {
        if (el.scopeGlobal) el.scopeGlobal.checked = true;
      } else {
        if (el.scopeProject) el.scopeProject.checked = true;
        if (el.selectProject && item.projectId) {
          el.selectProject.value = item.projectId;
        }
      }
    } else {
      // 新增项
      if (el.editTitle) el.editTitle.textContent = '新增文档收藏';
      if (el.inputTitle) el.inputTitle.value = '';
      if (el.inputUrl) el.inputUrl.value = '';
      if (el.inputDesc) el.inputDesc.value = '';

      if (currentProjId && allProjects.some(p => p.id === currentProjId)) {
        if (el.scopeProject) el.scopeProject.checked = true;
        if (el.selectProject) el.selectProject.value = currentProjId;
      } else if (allProjects.length > 0) {
        if (el.scopeProject) el.scopeProject.checked = true;
        if (el.selectProject) el.selectProject.value = allProjects[0].id;
      } else {
        if (el.scopeGlobal) el.scopeGlobal.checked = true;
      }
    }

    updateScopeCards();
    updateUrlDetection();

    el.editModal.classList.remove('hidden');
    setTimeout(() => {
      if (el.inputUrl && !el.inputUrl.value) {
        el.inputUrl.focus();
      } else if (el.inputTitle) {
        el.inputTitle.focus();
      }
    }, 50);
  }

  function closeEditModal() {
    if (!el.editModal) return;
    el.editModal.classList.add('hidden');
    editingId = null;
  }

  // ---------- 保存与删除操作 ----------
  async function handleSave() {
    const title = el.inputTitle ? el.inputTitle.value.trim() : '';
    const url = el.inputUrl ? el.inputUrl.value.trim() : '';
    const isGlobal = el.scopeGlobal && el.scopeGlobal.checked;
    const scope = isGlobal ? 'global' : 'project';
    const projectId = scope === 'project' ? (el.selectProject ? el.selectProject.value : null) : null;
    const description = el.inputDesc ? el.inputDesc.value.trim() : '';

    if (!url) {
      showEditMsg('请输入文档链接', 'error');
      if (el.inputUrl) el.inputUrl.focus();
      return;
    }

    if (!/^https?:\/\//i.test(url)) {
      showEditMsg('链接必须以 http:// 或 https:// 开头', 'error');
      if (el.inputUrl) el.inputUrl.focus();
      return;
    }

    if (!title) {
      showEditMsg('请输入文档名称', 'error');
      if (el.inputTitle) el.inputTitle.focus();
      return;
    }

    if (scope === 'project' && !projectId) {
      showEditMsg('请选择所属项目', 'error');
      if (el.selectProject) el.selectProject.focus();
      return;
    }

    const payload = {
      title,
      url,
      scope,
      projectId,
      description
    };

    if (el.btnSave) el.btnSave.disabled = true;
    showEditMsg('正在保存…', 'info');

    try {
      if (editingId) {
        await api(`/api/bookmarks/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        await api('/api/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      closeEditModal();
      await refreshBookmarks();
      if (window.CSM && typeof window.CSM.appendLog === 'function') {
        const dest = scope === 'global' ? '全局通用' : getProjectNameById(projectId);
        window.CSM.appendLog(`📑 已${editingId ? '修改' : '新增'}文档收藏「${title}」（${dest}）\n`);
      }
    } catch (err) {
      showEditMsg(err.message || '保存失败', 'error');
    } finally {
      if (el.btnSave) el.btnSave.disabled = false;
    }
  }

  async function handleDelete(id) {
    const item = bookmarks.find(b => b.id === id);
    const title = item ? item.title : '选中文档';
    if (!window.confirm(`确定要删除文档收藏「${title}」吗？`)) {
      return;
    }

    try {
      await api(`/api/bookmarks/${id}`, { method: 'DELETE' });
      await refreshBookmarks();
      if (window.CSM && typeof window.CSM.appendLog === 'function') {
        window.CSM.appendLog(`− 已删除文档收藏：${title}\n`);
      }
    } catch (err) {
      window.alert(`删除失败：${err.message}`);
    }
  }

  function showEditMsg(text, type = 'info') {
    if (!el.msg) return;
    el.msg.textContent = text;
    el.msg.className = `fl-msg fl-msg-${type}`;
  }

  // ---------- 事件绑定 ----------
  function initEvents() {
    // 顶部下拉切换与外部点击关闭
    if (el.btnDropdown) {
      el.btnDropdown.addEventListener('click', e => {
        e.stopPropagation();
        toggleDropdown();
      });
    }

    document.addEventListener('click', e => {
      if (el.widget && !el.widget.contains(e.target)) {
        closeDropdown();
      }
    });

    if (el.quickAdd) {
      el.quickAdd.addEventListener('click', e => {
        e.stopPropagation();
        closeDropdown();
        openEditModal(null);
      });
    }

    if (el.openManager) {
      el.openManager.addEventListener('click', e => {
        e.stopPropagation();
        openDocManagerModal();
      });
    }

    // 弹窗关闭
    if (el.close) el.close.addEventListener('click', closeDocManagerModal);
    if (el.editClose) el.editClose.addEventListener('click', closeEditModal);
    if (el.btnCancel) el.btnCancel.addEventListener('click', closeEditModal);
    if (el.btnAdd) el.btnAdd.addEventListener('click', () => openEditModal(null));
    if (el.btnSave) el.btnSave.addEventListener('click', handleSave);

    // Esc 关闭
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (el.editModal && !el.editModal.classList.contains('hidden')) {
          closeEditModal();
        } else if (el.modal && !el.modal.classList.contains('hidden')) {
          closeDocManagerModal();
        } else {
          closeDropdown();
        }
      }
    });

    // 实时链接识别
    if (el.inputUrl) {
      el.inputUrl.addEventListener('input', updateUrlDetection);
    }
    if (el.inputTitle) {
      el.inputTitle.addEventListener('input', updateUrlDetection);
    }

    // 适用范围卡片切换
    if (el.scopeProject) {
      el.scopeProject.addEventListener('change', updateScopeCards);
    }
    if (el.scopeGlobal) {
      el.scopeGlobal.addEventListener('change', updateScopeCards);
    }
    if (el.cardProject) {
      el.cardProject.addEventListener('click', () => {
        if (el.scopeProject) {
          el.scopeProject.checked = true;
          updateScopeCards();
        }
      });
    }
    if (el.cardGlobal) {
      el.cardGlobal.addEventListener('click', () => {
        if (el.scopeGlobal) {
          el.scopeGlobal.checked = true;
          updateScopeCards();
        }
      });
    }

    // 快捷键保存 (⌘Enter / Ctrl+Enter)
    if (el.editModal) {
      el.editModal.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          handleSave();
        }
      });
    }

    // Tab 切换
    const tabs = [
      { btn: el.tabAll, tab: 'all' },
      { btn: el.tabGlobal, tab: 'global' },
      { btn: el.tabProject, tab: 'project' }
    ];

    tabs.forEach(({ btn, tab }) => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        tabs.forEach(t => t.btn && t.btn.classList.remove('active'));
        btn.classList.add('active');
        currentTab = tab;
        renderTable();
      });
    });

    // 项目筛选下拉框
    if (el.tableProjectFilter) {
      el.tableProjectFilter.addEventListener('change', () => {
        selectedFilterProject = el.tableProjectFilter.value;
        if (selectedFilterProject && currentTab === 'global') {
          // 如果选了项目但当前在全局 Tab，自动切换到项目专属 Tab
          if (el.tabProject) el.tabProject.click();
        } else {
          renderTable();
        }
      });
    }

    // 搜索过滤
    if (el.filter) {
      el.filter.addEventListener('input', () => {
        searchTerm = el.filter.value.trim();
        if (el.filterClear) el.filterClear.classList.toggle('hidden', !searchTerm);
        renderTable();
      });
    }

    if (el.filterClear) {
      el.filterClear.addEventListener('click', () => {
        if (el.filter) el.filter.value = '';
        searchTerm = '';
        el.filterClear.classList.add('hidden');
        renderTable();
        if (el.filter) el.filter.focus();
      });
    }

    // 回车提交表单
    [el.inputTitle, el.inputUrl, el.inputDesc].forEach(input => {
      if (!input) return;
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSave();
        }
      });
    });

    // 监听项目切换（更新下拉列表中“当前项目”的置顶状态）
    document.addEventListener('csm-project-changed', () => {
      refreshBookmarks();
    });
  }

  // ---------- 初始化 ----------
  function init() {
    initEvents();
    refreshBookmarks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
