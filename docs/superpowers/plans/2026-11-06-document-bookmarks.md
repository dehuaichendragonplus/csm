# 本地文档收藏与管理功能实施计划 (Document Bookmarks Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CSM 增加纯本地存储的在线文档收藏与管理功能（支持钉钉、飞书、Google 等任意 Web 链接），在 Chrome 书签栏常驻快捷下拉直达浮层，并提供专属的「文档管理列表」弹窗。

**Architecture:** 后端在 `lib/bookmarks.js` 实现纯本地数据存储（`DATA_DIR/bookmarks.json`）与参数校验，并在 `server.js` 暴露 REST 接口；前端在 `public/index.html` 与 `public/style.css` 挂载书签栏下拉组件与管理弹窗，由独立模块 `public/doc-manager.js` 驱动交互、外链安全跳转及跨项目切换联动。

**Tech Stack:** Node.js (内置 `node:fs`, `node:path`, `node:test`, `node:assert`, `node:crypto`), Express, Vanilla JavaScript (ES6+), HTML5, CSS3.

**Spec:** [docs/superpowers/specs/2026-11-06-document-bookmarks-design.md](file:///Users/dragonplus/Documents/dragonplus/SyncManager/docs/superpowers/specs/2026-11-06-document-bookmarks-design.md)

## Global Constraints
- **纯本地存储**：数据仅存放在 `DATA_DIR/bookmarks.json`，严禁写入项目目录、`filelist.json` 或 git/svn 协同文件。
- **Git 提交信息必须使用中文**：所有 commit 信息一律为中文描述（`feat: ...`, `test: ...` 等）。
- **链接安全性**：仅允许以 `http://` 或 `https://` 开头的 Web 协议；桌面端唤起系统外部浏览器，网页端新标签打开。
- **零新增外部运行时依赖**：使用 Node.js 原生模块与当前 Express 框架，不引入无必要的 npm 包。
- **回归安全**：现有 148 项测试必须保持 100% 通过。

## Review Focus
1. **空数据/文件不存在**：当 `bookmarks.json` 不存在时，自动初始化并返回空列表，不能抛出未捕获异常。
2. **非法 URL 输入**：输入非 http/https 链接（如 `javascript:alert(1)`、纯文本、非法字符）时后端 400 拦截，前端表单阻断提交。
3. **损坏的 JSON 文件**：若本地 `bookmarks.json` 损毁，捕获语法错误并安全重置/备份，不导致后端服务崩溃。
4. **跨项目切换实时响应**：切换不同项目 Tab 时，书签栏下拉菜单和角标必须依据新的 `projectId` 实时过滤显示。
5. **响应式与超长文本**：长 URL（如包含多参数的钉钉文档链接）与长标题不能撑破书签栏浮层与弹窗布局，采用文本省略与悬浮提示。

---

### Task 1: 本地数据存储与校验模块 (`lib/bookmarks.js`)

**Files:**
- Create: `lib/bookmarks.js`
- Create: `test/bookmarks.test.js`

**Interfaces:**
- Produces:
  - `loadBookmarks(filePath: string): Array<Bookmark>`
  - `saveBookmarks(filePath: string, bookmarks: Array<Bookmark>): void`
  - `getBookmarks(filePath: string, projectId?: string): { bookmarks: Array<Bookmark>, projectCount: number, globalCount: number }`
  - `addBookmark(filePath: string, data: { title: string, url: string, scope?: string, projectId?: string, description?: string }): Bookmark`
  - `updateBookmark(filePath: string, id: string, updates: Object): Bookmark`
  - `deleteBookmark(filePath: string, id: string): boolean`
  - `validateBookmarkInput(data: Object): { valid: boolean, error?: string }`

- [ ] **Step 1: 编写单元测试**

在 `test/bookmarks.test.js` 中编写测试用例，覆盖：
1. 文件不存在时安全初始化返回空列表
2. 添加项目文档与全局文档
3. 校验非法 URL（非 http/https）报错拦截
4. 校验空标题报错拦截
5. 根据 `projectId` 筛选（返回该项目的项目文档 + 全局文档）
6. 更新文档标题、链接、说明
7. 删除文档
8. 损坏的 JSON 文件恢复与备份机制

```javascript
// test/bookmarks.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  loadBookmarks,
  saveBookmarks,
  getBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  validateBookmarkInput
} = require('../lib/bookmarks');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-bm-'));
  return path.join(dir, 'bookmarks.json');
}

test('bookmarks: 文件不存在时返回空列表并支持正常保存', () => {
  const file = tmpFile();
  const res = getBookmarks(file, 'proj-1');
  assert.deepStrictEqual(res.bookmarks, []);
  assert.strictEqual(res.projectCount, 0);
  assert.strictEqual(res.globalCount, 0);
});

test('bookmarks: 添加项目文档与全局文档，并按 projectId 正确筛选', () => {
  const file = tmpFile();
  const bm1 = addBookmark(file, {
    title: '钉钉项目表',
    url: 'https://alidocs.dingtalk.com/spreadsheetv2/Qvmjm92wFWkJQ3DD/edit',
    scope: 'project',
    projectId: 'proj-1',
    description: '项目专用表'
  });
  assert.ok(bm1.id);
  assert.strictEqual(bm1.scope, 'project');

  const bm2 = addBookmark(file, {
    title: '全局规范文档',
    url: 'https://docs.google.com/spreadsheets/d/test',
    scope: 'global',
    description: '公共文档'
  });
  assert.strictEqual(bm2.scope, 'global');

  // 查询 proj-1：包含 1 个项目文档 + 1 个全局文档
  const resProj1 = getBookmarks(file, 'proj-1');
  assert.strictEqual(resProj1.bookmarks.length, 2);
  assert.strictEqual(resProj1.projectCount, 1);
  assert.strictEqual(resProj1.globalCount, 1);

  // 查询 proj-2：仅包含 1 个全局文档
  const resProj2 = getBookmarks(file, 'proj-2');
  assert.strictEqual(resProj2.bookmarks.length, 1);
  assert.strictEqual(resProj2.bookmarks[0].id, bm2.id);
  assert.strictEqual(resProj2.projectCount, 0);
  assert.strictEqual(resProj2.globalCount, 1);
});

test('bookmarks: URL 与标题校验拦截', () => {
  assert.strictEqual(validateBookmarkInput({ title: '', url: 'https://foo.com' }).valid, false);
  assert.strictEqual(validateBookmarkInput({ title: '表', url: 'javascript:alert(1)' }).valid, false);
  assert.strictEqual(validateBookmarkInput({ title: '表', url: 'ftp://foo.com' }).valid, false);
  assert.strictEqual(validateBookmarkInput({ title: '表', url: 'https://foo.com' }).valid, true);
  assert.strictEqual(validateBookmarkInput({ title: '表', url: 'http://foo.com' }).valid, true);
});

test('bookmarks: 修改与删除文档', () => {
  const file = tmpFile();
  const bm = addBookmark(file, { title: '初始标题', url: 'https://a.com' });
  const updated = updateBookmark(file, bm.id, { title: '新标题', description: '新备注' });
  assert.strictEqual(updated.title, '新标题');
  assert.strictEqual(updated.description, '新备注');

  const delOk = deleteBookmark(file, bm.id);
  assert.strictEqual(delOk, true);
  const after = getBookmarks(file);
  assert.strictEqual(after.bookmarks.length, 0);
});

test('bookmarks: 损毁 JSON 安全降级', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'INVALID JSON!!!');
  const res = getBookmarks(file);
  assert.deepStrictEqual(res.bookmarks, []);
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --test test/bookmarks.test.js`
预期结果：FAIL（`Cannot find module '../lib/bookmarks'`）

- [ ] **Step 3: 实现 `lib/bookmarks.js`**

创建 `lib/bookmarks.js`，包含：
- `validateBookmarkInput`：校验标题非空、URL 为合法的 http/https 协议。
- `loadBookmarks`：带 try/catch，遇到语法错误自动备份并返回 `[]`。
- `saveBookmarks`：使用格式化 JSON 写入，自动创建父级目录。
- `getBookmarks`：支持根据 `projectId` 筛选 `project` 和 `global` 文档，并统计各自总数。
- `addBookmark`：生成唯一 `id`（如 `doc_` + 8 位哈希）、补全 `createdAt` / `updatedAt`。
- `updateBookmark`：依据 ID 查找并更新，更新 `updatedAt`。
- `deleteBookmark`：过滤指定 ID 并写回。

- [ ] **Step 4: 运行测试验证通过**

运行：`node --test test/bookmarks.test.js`
预期结果：PASS

- [ ] **Step 5: Git 提交**

```bash
git add lib/bookmarks.js test/bookmarks.test.js
git commit -m "feat: 实现本地文档收藏数据层与测试"
```

---

### Task 2: 后端 REST 接口与集成测试 (`server.js`)

**Files:**
- Modify: `server.js`
- Modify: `test/bookmarks.test.js`

**Interfaces:**
- Consumes: `lib/bookmarks.js`
- Produces:
  - `GET /api/bookmarks` (query: `projectId`) -> `{ bookmarks: Array, projectCount: number, globalCount: number }`
  - `POST /api/bookmarks` (body: `{ title, url, scope, projectId, description }`) -> `{ bookmark: Object }` (Status 201)
  - `PUT /api/bookmarks/:id` (body: updates) -> `{ bookmark: Object }`
  - `DELETE /api/bookmarks/:id` -> `{ ok: true }`

- [ ] **Step 1: 在 `test/bookmarks.test.js` 中增加 API 集成测试**

使用 Node 内置 `http` 或 `fetch` 请求已实例化的 CSM Express App 测试端点：

```javascript
test('bookmarks API: GET, POST, PUT, DELETE 完整生命周期', async () => {
  const { createServer } = require('../server');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-api-bm-'));
  const srv = createServer({ dataDir: tmpDir, openBrowser: false, port: 0 });
  const serverInstance = await srv.listen();
  const port = serverInstance.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. GET 初始为空
    let res = await fetch(`${baseUrl}/api/bookmarks?projectId=test-p`);
    let data = await res.json();
    assert.strictEqual(data.bookmarks.length, 0);

    // 2. POST 添加
    res = await fetch(`${baseUrl}/api/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '钉钉文档',
        url: 'https://alidocs.dingtalk.com/spreadsheetv2/Qvmjm92wFWkJQ3DD/edit',
        scope: 'project',
        projectId: 'test-p',
        description: '钉钉测试表'
      })
    });
    assert.strictEqual(res.status, 201);
    const created = await res.json();
    assert.ok(created.bookmark && created.bookmark.id);

    // 3. GET 带 projectId 查出
    res = await fetch(`${baseUrl}/api/bookmarks?projectId=test-p`);
    data = await res.json();
    assert.strictEqual(data.bookmarks.length, 1);
    assert.strictEqual(data.projectCount, 1);

    // 4. PUT 更新
    res = await fetch(`${baseUrl}/api/bookmarks/${created.bookmark.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '钉钉文档已更新' })
    });
    assert.strictEqual(res.status, 200);
    const updated = await res.json();
    assert.strictEqual(updated.bookmark.title, '钉钉文档已更新');

    // 5. DELETE 删除
    res = await fetch(`${baseUrl}/api/bookmarks/${created.bookmark.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    res = await fetch(`${baseUrl}/api/bookmarks?projectId=test-p`);
    data = await res.json();
    assert.strictEqual(data.bookmarks.length, 0);
  } finally {
    await srv.close();
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

运行：`node --test test/bookmarks.test.js`
预期结果：FAIL（404 on `/api/bookmarks`）

- [ ] **Step 3: 在 `server.js` 中实现 `/api/bookmarks` 系列路由**

在 `server.js` 中引入 `lib/bookmarks.js`，定义 `const BOOKMARKS_PATH = path.join(DATA_DIR, 'bookmarks.json');`，并添加路由：
```javascript
const bookmarksLib = require('./lib/bookmarks');
const BOOKMARKS_PATH = path.join(DATA_DIR, 'bookmarks.json');

app.get('/api/bookmarks', (req, res) => {
  try {
    const projectId = req.query.projectId || null;
    const result = bookmarksLib.getBookmarks(BOOKMARKS_PATH, projectId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookmarks', (req, res) => {
  try {
    const valid = bookmarksLib.validateBookmarkInput(req.body);
    if (!valid.valid) {
      return res.status(400).json({ error: valid.error });
    }
    const bookmark = bookmarksLib.addBookmark(BOOKMARKS_PATH, req.body);
    res.status(201).json({ bookmark });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/bookmarks/:id', (req, res) => {
  try {
    const updated = bookmarksLib.updateBookmark(BOOKMARKS_PATH, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: '未找到指定文档收藏' });
    res.json({ bookmark: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bookmarks/:id', (req, res) => {
  try {
    const ok = bookmarksLib.deleteBookmark(BOOKMARKS_PATH, req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: 运行测试验证通过**

运行：`node --test test/bookmarks.test.js`
预期结果：PASS

- [ ] **Step 5: Git 提交**

```bash
git add server.js test/bookmarks.test.js
git commit -m "feat: 在服务端支持文档收藏增删改查 REST API"
```

---

### Task 3: 前端结构与样式 (`public/index.html` & `public/style.css`)

**Files:**
- Modify: `public/index.html`
- Modify: `public/style.css`

- [ ] **Step 1: 在 `public/index.html` 的书签栏中添加快捷下拉组件**

在 `public/index.html` 第 84 行 `#summary-bar .bookmarks-left` 内紧接 `#status-filters` 之后加入：
```html
<div class="bookmarks-widget" id="bookmarks-widget">
  <button id="btn-bookmarks-dropdown" type="button" class="chip chip-bookmarks" title="查看并跳转收藏的在线文档">
    <span class="chip-icon">📑</span>
    <span class="chip-label">收藏文档</span>
    <span id="bookmarks-badge" class="chip-count">0</span>
    <span class="chip-arrow">▾</span>
  </button>
  <div id="bookmarks-dropdown-menu" class="bookmarks-dropdown hidden" role="menu">
    <div class="bm-dropdown-header">
      <span class="bm-dropdown-title">在线文档</span>
      <button id="btn-bm-quick-add" type="button" class="btn-bm-text-action">➕ 新增</button>
    </div>
    <div id="bm-dropdown-list" class="bm-dropdown-list">
      <!-- 动态渲染项目与全局文档 -->
    </div>
    <div class="bm-dropdown-footer">
      <button id="btn-bm-open-manager" type="button" class="bm-dropdown-manage-btn">⚙️ 管理所有文档…</button>
    </div>
  </div>
</div>
```

并在顶部工具栏 `.toolbar-actions` 或主设置旁提供备选管理入口（支持直接从工具栏呼出管理弹窗）。

- [ ] **Step 2: 在 `public/index.html` 中添加【文档管理列表弹窗】与【新增/编辑弹窗】**

在 `fl-modal` 之后添加：
```html
<!-- 文档管理列表弹窗 -->
<div id="doc-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="doc-modal-title">
  <div class="modal-box fl-box doc-box">
    <header class="modal-head fl-modal-head">
      <div class="fl-modal-title-group">
        <div class="fl-modal-icon-badge">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3a1.5 1.5 0 0 1 1.5-1.5h6l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 17V3z"/><path d="M11.5 1.5v4.5h4.5M7 9.5h6M7 13h6"/></svg>
        </div>
        <div>
          <div class="fl-modal-title-row">
            <strong class="fl-modal-title" id="doc-modal-title">在线文档与收藏管理</strong>
            <span class="doc-badge-local">纯本地存储</span>
          </div>
          <div class="fl-modal-subtitle">收藏当前项目与全局在线文档、表格及知识库，点击可直接在浏览器中打开</div>
        </div>
      </div>
      <div class="modal-head-actions">
        <span class="modal-esc-hint"><kbd>Esc</kbd></span>
        <button id="doc-close" type="button" class="modal-close-btn" title="关闭 (Esc)">✕</button>
      </div>
    </header>

    <!-- 工具栏：Tab 筛选、搜索与新增 -->
    <div class="fl-toolbar">
      <div class="fl-toolbar-left">
        <div class="fl-tabs">
          <button type="button" class="fl-tab active" data-tab="all" id="doc-tab-all">
            <span>全部</span> <span id="doc-count-all" class="fl-tab-count">0</span>
          </button>
          <button type="button" class="fl-tab" data-tab="project" id="doc-tab-project">
            <span>当前项目</span> <span id="doc-count-project" class="fl-tab-count">0</span>
          </button>
          <button type="button" class="fl-tab" data-tab="global" id="doc-tab-global">
            <span>全局通用</span> <span id="doc-count-global" class="fl-tab-count">0</span>
          </button>
        </div>
      </div>
      <div class="fl-toolbar-right">
        <div class="fl-search-box">
          <svg class="fl-search-icon" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/></svg>
          <input id="doc-filter" type="search" placeholder="搜索文档标题、网址或备注..." autocomplete="off" spellcheck="false">
          <button id="doc-filter-clear" type="button" class="fl-search-clear hidden" title="清空">✕</button>
        </div>
        <button id="doc-btn-add" type="button" class="btn btn-primary fl-add-btn">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4.5v11M4.5 10h11"/></svg>
          <span>新增文档收藏</span>
        </button>
      </div>
    </div>

    <!-- 表格展示区 -->
    <div class="fl-table-wrap">
      <table class="fl-table">
        <thead>
          <tr>
            <th style="width: 50px; text-align: center;">类型</th>
            <th style="width: 220px; min-width: 180px;">文档名称</th>
            <th style="min-width: 260px;">文档链接 (URL)</th>
            <th style="width: 130px;">归属</th>
            <th style="width: 180px;">备注说明</th>
            <th style="width: 160px; text-align: right;">操作</th>
          </tr>
        </thead>
        <tbody id="doc-tbody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- 新增 / 编辑文档弹窗 -->
<div id="doc-edit-modal" class="modal modal-top hidden" role="dialog" aria-modal="true" aria-labelledby="doc-edit-title">
  <div class="modal-box fl-form-box">
    <header class="modal-head">
      <strong id="doc-edit-title">新增文档收藏</strong>
      <button id="doc-edit-close" type="button" class="modal-close-btn" title="关闭 (Esc)">✕</button>
    </header>
    <div class="modal-body fl-form-body">
      <label class="fl-field">
        <span class="fl-field-label">文档名称 <em class="req">*</em></span>
        <input id="doc-input-title" type="text" placeholder="例如：数值策划在线总表、团队协作规范" autocomplete="off" spellcheck="false">
      </label>
      <label class="fl-field">
        <span class="fl-field-label">文档链接 (URL) <em class="req">*</em></span>
        <input id="doc-input-url" type="url" placeholder="https://alidocs.dingtalk.com/... 或 https://docs.google.com/..." autocomplete="off" spellcheck="false">
      </label>
      <div class="fl-field">
        <span class="fl-field-label">适用范围</span>
        <div class="doc-scope-radios">
          <label class="radio-label">
            <input type="radio" name="doc-scope" value="project" id="doc-scope-project" checked>
            <span>当前项目专属 (<span id="doc-scope-proj-name">当前项目</span>)</span>
          </label>
          <label class="radio-label">
            <input type="radio" name="doc-scope" value="global" id="doc-scope-global">
            <span>全局通用 (所有项目均可访问)</span>
          </label>
        </div>
      </div>
      <label class="fl-field">
        <span class="fl-field-label">备注说明（选填）</span>
        <input id="doc-input-desc" type="text" placeholder="表格说明、负责人、用途备注等" autocomplete="off">
      </label>
      <p id="doc-edit-msg" class="fl-msg" role="status"></p>
    </div>
    <footer class="modal-foot">
      <button id="doc-edit-cancel" type="button">取消</button>
      <button id="doc-edit-save" type="button" class="primary">保存收藏</button>
    </footer>
  </div>
</div>
```

- [ ] **Step 3: 在 `public/style.css` 中添加配套样式**

编写样式：
- `.bookmarks-widget` 相对定位与 `.chip-bookmarks` 胶囊美化
- `.bookmarks-dropdown` 下拉浮层卡片样式、阴影、层级 `z-index: 120`、最大高度与滚动条
- `.bm-dropdown-item` 图标、标题、备注单行省略、Hover 动效与直达按钮
- `.doc-badge-local` 纯本地提示标识
- `.doc-scope-tag` 项目蓝标与全局灰标
- 链接列的优雅截断与一键复制反馈效果

- [ ] **Step 4: 检查 HTML/CSS 结构合法性**

运行：`node -e "require('fs').readFileSync('public/index.html'); require('fs').readFileSync('public/style.css'); console.log('OK');"`
预期结果：OK

- [ ] **Step 5: Git 提交**

```bash
git add public/index.html public/style.css
git commit -m "feat: 增加书签栏文档下拉组件与文档管理弹窗页面结构及样式"
```

---

### Task 4: 前端交互逻辑模块 (`public/doc-manager.js`)

**Files:**
- Create: `public/doc-manager.js`
- Modify: `public/index.html`

- [ ] **Step 1: 编写 `public/doc-manager.js`**

包含完整闭环逻辑：
1. **平台与图标推断函数** `detectPlatform(url)`：
   - 钉钉/阿里文档 (`alidocs.dingtalk.com`, `dingtalk.com`) -> `{ icon: '📑', name: '钉钉文档', class: 'tag-ding' }`
   - Google 文档/表格 (`docs.google.com`) -> `{ icon: '📊', name: 'Google Sheets', class: 'tag-google' }`
   - 飞书/Lark (`feishu.cn`, `larksuite.com`) -> `{ icon: '🪶', name: '飞书文档', class: 'tag-feishu' }`
   - 其他 -> `{ icon: '🌐', name: 'Web 链接', class: 'tag-web' }`
2. **安全外链跳转** `openSafeUrl(url)`：
   - 必须匹配 `^https?://`。
   - `window.open(url, '_blank', 'noopener,noreferrer')`。
3. **数据读取与渲染**：
   - 请求 `/api/bookmarks?projectId=${currentId}`。
   - 渲染下拉菜单 `#bm-dropdown-list`：
     - 分组：【📌 当前项目】与【🌐 全局通用】。
     - 若为空：展示「暂无文档收藏，点击添加」。
     - 更新胶囊角标数字 `#bookmarks-badge`。
   - 渲染管理弹窗列表 `#doc-tbody`：
     - 支持 Tab 筛选（全部、当前项目、全局）。
     - 支持搜索关键字实时过滤（标题、链接、备注）。
     - 每一行展示图标、标题、截断链接（带复制按钮）、归属 Badge、备注、操作按钮（跳转、编辑、删除）。
4. **弹窗开启与关闭**：
   - `#btn-bookmarks-dropdown` 点击切换展开/折叠，点击页面外部自动关闭下拉。
   - `#btn-bm-open-manager` 打开管理弹窗。
   - `#doc-btn-add` 和 `#btn-bm-quick-add` 打开新增弹窗。
   - Esc 键与背景点击关闭。
5. **表单增删改**：
   - 新增与编辑复用 `#doc-edit-modal`。
   - 表单前端校验：标题必填，URL 格式校验。
   - 成功后显示成功提示，刷新下拉与弹窗列表。
   - 删除弹窗二次确认。
6. **项目切换联动**：
   - 监听 `document.addEventListener('csm-project-changed', ...)`。
   - 项目变更时自动重新获取当前项目的文档数据并更新视图与角标。

- [ ] **Step 2: 在 `public/index.html` 底部引入 `doc-manager.js`**

在 `<script src="filelist-manager.js"></script>` 后添加：
```html
<script src="doc-manager.js"></script>
```

- [ ] **Step 3: 语法与前端环境自检**

运行：`node -c public/doc-manager.js`
预期结果：无语法报错

- [ ] **Step 4: Git 提交**

```bash
git add public/doc-manager.js public/index.html
git commit -m "feat: 实现前端文档管理交互、快捷下拉浮层与项目切换联动"
```

---

### Task 5: 真实场景测试与全量回归验证

**Files:**
- Modify: `test/bookmarks.test.js`

- [ ] **Step 1: 在 `test/bookmarks.test.js` 增加钉钉长链接与边界测试**

验证用户给出的真实钉钉长链接：
`https://alidocs.dingtalk.com/spreadsheetv2/Qvmjm92wFWkJQ3DD/edit?cid=433668443:636958280&type=s&docKey=pLdn55XPExK27no8&dentryKey=Qvmjm92wFWkJQ3DD&utm_source=im&utm_medium=im_card&dontjump=true&chInfo=im`
确保保存、查询、多参数解析、修改均无损存储且不会截断参数。

- [ ] **Step 2: 运行全量测试套件**

运行：`npm test`
预期结果：所有测试（包含新增的 bookmarks 测试与既有 148 项测试）全部 PASS。

- [ ] **Step 3: 最终 Git 提交**

```bash
git add test/bookmarks.test.js
git commit -m "test: 补充真实钉钉在线表格长链接与复杂参数测试用例"
```
