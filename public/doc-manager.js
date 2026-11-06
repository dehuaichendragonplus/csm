// 本地文档收藏与管理 (Document Bookmarks)
// 纯本地存储，管理钉钉、飞书、Google 等在线文档外链，支持快捷下拉直达与专属管理弹窗。
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const el = {
    // 书签栏快捷组件
    widget: $('bookmarks-widget'),
    btnDropdown: $('btn-bookmarks-dropdown'),
    dropdownMenu: $('bookmarks-dropdown-menu'),
    badge: $('bookmarks-badge'),
    quickAdd: $('btn-bm-quick-add'),
    dropdownList: $('bm-dropdown-list'),
    openManager: $('btn-bm-open-manager'),
    btnManageDocs: $('btn-manage-docs'),

    // 文档管理列表弹窗
    modal: $('doc-modal'),
    close: $('doc-close'),
    tabAll: $('doc-tab-all'),
    tabProject: $('doc-tab-project'),
    tabGlobal: $('doc-tab-global'),
    countAll: $('doc-count-all'),
    countProject: $('doc-count-project'),
    countGlobal: $('doc-count-global'),
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
    scopeProject: $('doc-scope-project'),
    scopeGlobal: $('doc-scope-global'),
    scopeProjName: $('doc-scope-proj-name'),
    inputDesc: $('doc-input-desc'),
    msg: $('doc-edit-msg'),
    btnCancel: $('doc-edit-cancel'),
    btnSave: $('doc-edit-save')
  };

  let bookmarks = [];
  let currentTab = 'all'; // 'all' | 'project' | 'global'
  let searchTerm = '';
  let editingId = null; // null 为新增，string 为编辑项 ID

  const api = (url, opts) => {
    if (window.CSM && typeof window.CSM.api === 'function') {
      return window.CSM.api(url, opts);
    }
    return fetch(url, opts).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    });
  };

  function getCurrentProjectId() {
    return window.CSM && typeof window.CSM.currentId === 'function' ? window.CSM.currentId() : null;
  }

  function getCurrentProjectName() {
    const elName = $('project-name');
    return (elName && elName.textContent && elName.textContent.trim()) || '当前项目';
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

  function detectPlatform(url) {
    if (!url) return { icon: '🌐', name: 'Web 链接', tagClass: 'tag-web' };
    const u = url.toLowerCase();
    if (u.includes('alidocs.dingtalk.com') || u.includes('dingtalk.com')) {
      return { icon: '📑', name: '钉钉文档', tagClass: 'tag-ding' };
    }
    if (u.includes('docs.google.com') || u.includes('sheets.google.com') || u.includes('drive.google.com')) {
      return { icon: '📊', name: 'Google Sheets', tagClass: 'tag-google' };
    }
    if (u.includes('feishu.cn') || u.includes('larksuite.com')) {
      return { icon: '🪶', name: '飞书文档', tagClass: 'tag-feishu' };
    }
    return { icon: '🌐', name: '在线链接', tagClass: 'tag-web' };
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
      // 降级使用 input 选中复制
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

  // ---------- 数据获取与刷新 ----------
  async function refreshBookmarks() {
    const projectId = getCurrentProjectId();
    try {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      const data = await api(`/api/bookmarks${qs}`);
      bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];

      const pCount = data.projectCount !== undefined ? data.projectCount : bookmarks.filter(b => b.scope === 'project').length;
      const gCount = data.globalCount !== undefined ? data.globalCount : bookmarks.filter(b => b.scope === 'global').length;
      const totalCount = bookmarks.length;

      // 更新角标
      if (el.badge) {
        el.badge.textContent = totalCount;
        el.badge.classList.toggle('hidden', totalCount === 0);
      }

      // 更新弹窗 Tab 计数
      if (el.countAll) el.countAll.textContent = totalCount;
      if (el.countProject) el.countProject.textContent = pCount;
      if (el.countGlobal) el.countGlobal.textContent = gCount;

      renderDropdown();
      renderTable();
    } catch (err) {
      console.error('[bookmarks] refresh failed:', err);
    }
  }

  // ---------- 渲染书签栏下拉菜单 ----------
  function renderDropdown() {
    if (!el.dropdownList) return;

    if (bookmarks.length === 0) {
      el.dropdownList.innerHTML = `
        <div class="bm-empty-tip">
          暂无文档收藏<br>
          <span style="color:var(--text-tertiary);font-size:11px;margin-top:4px;display:inline-block;">点击右上角「➕ 新增」添加钉钉、飞书或在线表格</span>
        </div>
      `;
      return;
    }

    const projectDocs = bookmarks.filter(b => b.scope === 'project');
    const globalDocs = bookmarks.filter(b => b.scope === 'global');

    let html = '';

    if (projectDocs.length > 0) {
      html += `<div class="bm-section-title">📌 当前项目文档 (${projectDocs.length})</div>`;
      for (const b of projectDocs) {
        const plat = detectPlatform(b.url);
        html += `
          <div class="bm-item" data-url="${escapeHtml(b.url)}" title="${escapeHtml(b.title + (b.description ? ' - ' + b.description : ''))}">
            <div class="bm-item-left">
              <span class="bm-item-icon">${plat.icon}</span>
              <div class="bm-item-info">
                <div class="bm-item-title">${escapeHtml(b.title)}</div>
                ${b.description ? `<div class="bm-item-desc">${escapeHtml(b.description)}</div>` : ''}
              </div>
            </div>
            <span class="bm-item-ext" title="在新窗口打开">↗</span>
          </div>
        `;
      }
    }

    if (globalDocs.length > 0) {
      html += `<div class="bm-section-title">🌐 全局通用文档 (${globalDocs.length})</div>`;
      for (const b of globalDocs) {
        const plat = detectPlatform(b.url);
        html += `
          <div class="bm-item" data-url="${escapeHtml(b.url)}" title="${escapeHtml(b.title + (b.description ? ' - ' + b.description : ''))}">
            <div class="bm-item-left">
              <span class="bm-item-icon">${plat.icon}</span>
              <div class="bm-item-info">
                <div class="bm-item-title">${escapeHtml(b.title)}</div>
                ${b.description ? `<div class="bm-item-desc">${escapeHtml(b.description)}</div>` : ''}
              </div>
            </div>
            <span class="bm-item-ext" title="在新窗口打开">↗</span>
          </div>
        `;
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
    if (currentTab === 'project') {
      list = list.filter(b => b.scope === 'project');
    } else if (currentTab === 'global') {
      list = list.filter(b => b.scope === 'global');
    }

    // 2. 关键词搜索
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(b => {
        return (
          (b.title && b.title.toLowerCase().includes(q)) ||
          (b.url && b.url.toLowerCase().includes(q)) ||
          (b.description && b.description.toLowerCase().includes(q))
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

    const projName = getCurrentProjectName();
    let rowsHtml = '';

    for (const b of list) {
      const plat = detectPlatform(b.url);
      const isProj = b.scope === 'project';
      const scopeLabel = isProj ? `${projName} 专属` : '全局通用';
      const scopeClass = isProj ? 'tag-project' : 'tag-global';

      rowsHtml += `
        <tr data-id="${escapeHtml(b.id)}">
          <td style="text-align: center;">
            <span class="doc-platform-badge" title="${escapeHtml(plat.name)}">${plat.icon}</span>
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
            <span class="doc-scope-tag ${scopeClass}">${escapeHtml(scopeLabel)}</span>
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

  function openEditModal(id = null) {
    if (!el.editModal) return;
    editingId = id;
    if (el.msg) {
      el.msg.textContent = '';
      el.msg.className = 'fl-msg';
    }

    const projName = getCurrentProjectName();
    if (el.scopeProjName) el.scopeProjName.textContent = projName;

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
      }
    } else {
      // 新增项
      if (el.editTitle) el.editTitle.textContent = '新增文档收藏';
      if (el.inputTitle) el.inputTitle.value = '';
      if (el.inputUrl) el.inputUrl.value = '';
      if (el.inputDesc) el.inputDesc.value = '';
      if (el.scopeProject) el.scopeProject.checked = true;
    }

    el.editModal.classList.remove('hidden');
    setTimeout(() => {
      if (el.inputTitle) el.inputTitle.focus();
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
    const projectId = scope === 'project' ? getCurrentProjectId() : null;
    const description = el.inputDesc ? el.inputDesc.value.trim() : '';

    if (!title) {
      showEditMsg('请输入文档名称', 'error');
      if (el.inputTitle) el.inputTitle.focus();
      return;
    }

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
        window.CSM.appendLog(`📑 已${editingId ? '修改' : '新增'}文档收藏：${title}\n`);
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
    // 快捷下拉点击与外部点击关闭
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

    if (el.btnManageDocs) {
      el.btnManageDocs.addEventListener('click', () => {
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

    // Tab 切换
    const tabs = [
      { btn: el.tabAll, tab: 'all' },
      { btn: el.tabProject, tab: 'project' },
      { btn: el.tabGlobal, tab: 'global' }
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

    // 监听项目切换
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
