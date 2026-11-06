'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function generateId() {
  return `doc_${crypto.randomBytes(4).toString('hex')}`;
}

function validateBookmarkInput(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: '请求数据无效' };
  }
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (!title) {
    return { valid: false, error: '文档标题不能为空' };
  }
  const url = typeof data.url === 'string' ? data.url.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) {
    return { valid: false, error: '文档链接必须以 http:// 或 https:// 开头' };
  }
  const scope = data.scope === 'global' ? 'global' : 'project';
  if (scope === 'project' && data.projectId !== undefined && data.projectId !== null && !String(data.projectId).trim()) {
    return { valid: false, error: '项目专属文档必须指定所属项目 ID' };
  }
  return { valid: true };
}

function loadBookmarks(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    try {
      const backupPath = `${filePath}.bak`;
      fs.copyFileSync(filePath, backupPath);
    } catch (_) {}
    return [];
  }
}

function saveBookmarks(filePath, bookmarks) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(bookmarks, null, 2) + '\n', 'utf8');
}

function getBookmarks(filePath, projectId) {
  const all = loadBookmarks(filePath);
  let globalCount = 0;
  let projectCount = 0;

  for (const b of all) {
    if (b.scope === 'global') {
      globalCount++;
    } else if (projectId && b.projectId === projectId) {
      projectCount++;
    }
  }

  const filtered = all.filter(b => {
    if (b.scope === 'global') return true;
    if (projectId && b.projectId === projectId) return true;
    if (!projectId && b.scope === 'project') return true; // 未传 projectId 时列出所有项目文档
    return false;
  });

  return {
    bookmarks: filtered,
    projectCount,
    globalCount
  };
}

function addBookmark(filePath, data) {
  const valid = validateBookmarkInput(data);
  if (!valid.valid) {
    throw new Error(valid.error);
  }

  const all = loadBookmarks(filePath);
  const now = new Date().toISOString();
  const scope = data.scope === 'global' ? 'global' : 'project';
  const bookmark = {
    id: generateId(),
    title: data.title.trim(),
    url: data.url.trim(),
    scope,
    projectId: scope === 'project' ? (data.projectId ? String(data.projectId).trim() : null) : null,
    description: data.description ? String(data.description).trim() : '',
    createdAt: now,
    updatedAt: now
  };

  all.unshift(bookmark); // 最新的排在前面
  saveBookmarks(filePath, all);
  return bookmark;
}

function updateBookmark(filePath, id, updates) {
  if (!id) throw new Error('缺少文档 ID');
  const all = loadBookmarks(filePath);
  const idx = all.findIndex(b => b.id === id);
  if (idx === -1) return null;

  const current = all[idx];
  const next = { ...current };

  if (updates.title !== undefined) {
    const t = String(updates.title).trim();
    if (!t) throw new Error('文档标题不能为空');
    next.title = t;
  }
  if (updates.url !== undefined) {
    const u = String(updates.url).trim();
    if (!u || !/^https?:\/\//i.test(u)) throw new Error('文档链接必须以 http:// 或 https:// 开头');
    next.url = u;
  }
  if (updates.scope !== undefined) {
    next.scope = updates.scope === 'global' ? 'global' : 'project';
    if (next.scope === 'global') {
      next.projectId = null;
    }
  }
  if (updates.projectId !== undefined && next.scope === 'project') {
    next.projectId = updates.projectId ? String(updates.projectId).trim() : null;
  }
  if (updates.description !== undefined) {
    next.description = String(updates.description).trim();
  }

  next.updatedAt = new Date().toISOString();
  all[idx] = next;
  saveBookmarks(filePath, all);
  return next;
}

function deleteBookmark(filePath, id) {
  if (!id) return false;
  const all = loadBookmarks(filePath);
  const next = all.filter(b => b.id !== id);
  if (next.length === all.length) return false;
  saveBookmarks(filePath, next);
  return true;
}

module.exports = {
  validateBookmarkInput,
  loadBookmarks,
  saveBookmarks,
  getBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark
};
