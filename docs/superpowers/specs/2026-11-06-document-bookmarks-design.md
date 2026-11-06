# 本地文档收藏与管理功能设计方案 (Document Bookmarks)

## 1. 背景与目标
在 CSM（Config Sync Manager）的实际使用场景中，除了基于 Google Sheets 的标准配置表同步外，策划与开发人员常需要频繁查阅项目或公共的在线文档（例如钉钉多维表格/在线文档、飞书文档、语雀、Google Docs 等外链）。

本功能旨在提供一个**纯本地存储、绝不进入团队协作仓库**的文档收藏与管理系统：
1. **纯本地隔离**：所有收藏信息仅保存在用户本机的运行数据目录 `DATA_DIR/bookmarks.json` 中，绝不写入项目的 `filelist.json`、`syncmanager.config.json` 或 git/svn 版本控制。
2. **多层级适用范围**：支持将文档标记为「当前项目专属」或「全局通用」，切换不同项目时智能展示对应项目和全局公共文档。
3. **高效快捷访问**：在 Chrome 风格的书签栏（Row 3）常驻「📑 收藏文档」下拉快捷浮层，实现高频 1 键直达；同时提供完整的「文档管理列表」弹窗，方便增删改查。
4. **外链安全直达**：点击任意文档链接，在桌面端（Electron）直接唤起系统默认浏览器安全打开，在网页端安全以新标签页打开。

---

## 2. 数据结构与本地持久化

### 2.1 存储文件与位置
* 存储路径：`DATA_DIR/bookmarks.json`
  * 桌面 App 路径：`~/Library/Application Support/CSM/bookmarks.json`（或 `CSM_DATA` 指定目录）
  * Web 服务模式路径：`SyncManager/data/bookmarks.json`
* 读写机制：封装于 `lib/bookmarks.js`，采用原子写入方式，确保并发安全；文件不存在或损坏时自动容错降级为空数组。

### 2.2 数据模型
```json
[
  {
    "id": "doc_9f8a2b3c",
    "title": "数值策划在线表 - 钉钉",
    "url": "https://alidocs.dingtalk.com/spreadsheetv2/Qvmjm92wFWkJQ3DD/edit?...",
    "scope": "project",
    "projectId": "configs-3dd5ea",
    "description": "关卡数值与产出表格",
    "createdAt": "2026-11-06T07:25:00.000Z",
    "updatedAt": "2026-11-06T07:25:00.000Z"
  }
]
```

字段说明：
* `id` (string, 必填)：唯一标识，如 `doc_` + 8位哈希或时间戳。
* `title` (string, 必填)：文档标题/名称，去除首尾空白，最长 100 字符。
* `url` (string, 必填)：合法的 Web 链接，必须以 `http://` 或 `https://` 开头。
* `scope` (string, 必填)：`"project"`（项目专属）或 `"global"`（全局通用）。
* `projectId` (string, 可选)：当 `scope === "project"` 时记录绑定的项目 ID，否则为 `null`。
* `description` (string, 可选)：业务备注说明。
* `createdAt` / `updatedAt` (string, ISO 日期时间)。

### 2.3 平台类型与图标推断
前端根据 URL 自动推断对应的图标与平台徽标：
* 钉钉 / 阿里文档 (`alidocs.dingtalk.com`, `dingtalk.com`) → 📑 钉钉文档
* Google Sheets / Docs (`docs.google.com`) → 📊 Google 文档
* 飞书 / Lark (`feishu.cn`, `larksuite.com`) → 🪶 飞书文档
* 其它域名 (`http://`, `https://`) → 🌐 在线链接

---

## 3. 后端 REST API 设计

在 `server.js` 中挂载以下路由：

### 3.1 获取文档列表
* **`GET /api/bookmarks`**
  * Query 参数：
    * `projectId` (string, 可选)：若提供，返回全局通用文档与该项目专属文档；若不提供或传 `all=true`，返回本机所有收藏文档。
  * 响应体：
    ```json
    {
      "bookmarks": [...],
      "projectCount": 2,
      "globalCount": 1
    }
    ```

### 3.2 新增文档
* **`POST /api/bookmarks`**
  * 请求体：
    ```json
    {
      "title": "数值策划在线表",
      "url": "https://alidocs.dingtalk.com/...",
      "scope": "project",
      "projectId": "configs-3dd5ea",
      "description": "数值与掉落"
    }
    ```
  * 校验逻辑：
    * 标题不可为空。
    * URL 必须以 `http://` 或 `https://` 开头。
    * `scope` 必须为 `"project"` 或 `"global"`。若为 `"project"`，`projectId` 不能为空。
  * 响应体：`{ "bookmark": { ... } }`，状态码 201。

### 3.3 修改文档
* **`PUT /api/bookmarks/:id`**
  * 请求体：需更新的字段 (`title`, `url`, `scope`, `projectId`, `description`)。
  * 响应体：`{ "bookmark": { ... } }`。若 ID 不存在返回 404。

### 3.4 删除文档
* **`DELETE /api/bookmarks/:id`**
  * 响应体：`{ "ok": true }`。

---

## 4. 前端界面与交互设计

### 4.1 书签栏常驻快捷下拉组件 (`#bookmarks-bar-widget`)
* **挂载位置**：位于第三行 `#summary-bar`（`.chrome-bookmarks-bar`）内，在 `.bookmarks-left` 中紧跟在状态筛选器（`.status-filters`）旁。
* **外观形态**：
  ```html
  <div class="bookmarks-widget" id="bookmarks-widget">
    <button id="btn-bookmarks-dropdown" type="button" class="chip chip-bookmarks" title="查看并跳转收藏的在线文档">
      <span class="chip-icon">📑</span>
      <span class="chip-label">收藏文档</span>
      <span id="bookmarks-badge" class="chip-count">0</span>
      <span class="chip-arrow">▾</span>
    </button>
    <div id="bookmarks-dropdown-menu" class="bookmarks-dropdown hidden">
      <!-- 动态渲染：当前项目文档列表、全局文档列表、操作底栏 -->
    </div>
  </div>
  ```
* **下拉菜单交互**：
  * 点击胶囊按钮切换展开/收起，点击页面其它区域自动收起。
  * 分组展示：
    * **当前项目文档**（仅列出当前 active 项目的条目，显示图标、标题、备注；点击直接唤起跳转外链）。
    * **全局通用文档**（列出全局文档；点击直接唤起跳转外链）。
    * 若当前无任何文档，显示友好引导：「暂无文档收藏，点击添加」。
  * **底栏快捷操作**：
    * `[➕ 新增文档]`：快速呼出录入弹窗。
    * `[⚙️ 管理全部文档]`：呼出完整的「文档管理列表」弹窗。

### 4.2 文档管理列表专属弹窗 (`#doc-manager-modal`)
* **弹窗结构**：
  * **头部**：图标徽标、标题「在线文档与收藏管理」、副标题「本地存储的项目与全局在线文档，点击可直接在浏览器中打开」、关闭按钮与 `Esc` 快捷键。
  * **工具栏**：
    * Tab 筛选切换：`全部` | `当前项目专属` | `全局通用`，各 Tab 显示数字计数。
    * 实时搜索框：支持根据标题、URL、备注实时模糊检索。
    * `[➕ 新增文档]` 主按钮。
  * **列表展示（表格结构）**：
    * **类型/图标**：根据平台自动展示（📑 钉钉 / 📊 Google / 🪶 飞书 / 🌐 网页）。
    * **文档名称**：粗体标题，附带备注副文本。
    * **链接地址**：脱敏长链接，悬浮显示完整 URL，右侧附「复制链接」微按钮。
    * **适用范围**：高亮 Tag 胶囊（如 `[MergeX11 专属]` 蓝色 / `[全局通用]` 灰色）。
    * **操作列**：
      * `[跳转 ↗]`：新标签页或系统浏览器打开。
      * `[编辑 ✏️]`：调起编辑表单。
      * `[删除 🗑️]`：二次确认后删除。
* **新增/编辑子表单 (`#doc-edit-modal`)**：
  * 字段表单：
    * 文档标题（必填）
    * 文档链接（必填，URL 校验，带粘贴自动清理首尾空格）
    * 归属范围（单选：`当前项目专属` / `全局通用`）
    * 业务说明（选填，支持多行或单行备注）
  * 底部按钮：`[取消]`、`[保存收藏]`。

### 4.3 链接跳转安全机制
* 前端统一调用跳转方法：
  ```javascript
  function openExternalUrl(url) {
    if (!/^https?:\/\//i.test(url)) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  ```
* 在 Electron 环境下，主进程已配置 `setWindowOpenHandler`，会自动拦截 `window.open` 并通过 `shell.openExternal(url)` 唤起用户系统默认浏览器打开，保证安全性。

---

## 5. 错误处理与容错机制
1. **数据损坏恢复**：若 `bookmarks.json` 损毁，捕获 `JSON.parse` 错误，记录日志，并安全备份为 `bookmarks.json.bak` 后重置为空列表，绝不阻塞应用启动。
2. **项目切换联动**：前端监听项目切换事件（`projectChange`），切换时立即重新查询或筛选当前 `projectId` 的文档，保持下拉角标与内容实时更新。
3. **删除防误触**：删除操作弹窗二次确认提示。

---

## 6. 测试与验证策略
1. **单元测试 (`test/bookmarks.test.js`)**：
   * 基础增删改查：测试 `loadBookmarks`、`addBookmark`、`updateBookmark`、`deleteBookmark`。
   * 项目与全局过滤：针对不同 `projectId` 验证过滤逻辑。
   * 异常防御：测试非法 URL、空标题、空 ID 等非法入参拦截。
   * 文件容错：测试数据文件不存在时的初始化创建。
2. **API 端到端测试**：
   * 测试 `GET /api/bookmarks`、`POST /api/bookmarks`、`PUT /api/bookmarks/:id`、`DELETE /api/bookmarks/:id`。
3. **既有套件回归**：
   * 运行 `npm test` 确认全量测试通过。
