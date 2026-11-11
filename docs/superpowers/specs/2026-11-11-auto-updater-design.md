# CSM Windows & macOS 自动更新功能设计文档

**日期**：2026-11-11  
**目标仓库**：`dehuaichendragonplus/csm`（SyncManager / CSM）  
**参考项目**：`/Users/dragonplus/Documents/dragonplus/DeepseekHarnessApp`  

---

## 1. 背景与目标

当前 CSM（`package.json` v1.1.3）仅配置了 macOS `arm64` DMG 打包，更新检测依赖未配置的 `CSM_UPDATE_URL` / `csm.updateUrl`（`latest.json`），且只有一条可关闭的顶部提示条，既没有设置页面内的「检查更新」入口，也没有应用内下载与安装能力。

本次改造目标：
1. **打包与发布元数据**：支持打包 **macOS（`arm64` + `x64`）DMG** 与 **Windows（`x64`）NSIS 安装包**，并生成 `latest.yml` 等元数据供上传至 `dehuaichendragonplus/csm` GitHub Releases。
2. **设置页检查更新**：在「全局偏好设置 → 关于 CSM」中增加「检查更新」按钮及版本状态、更新日志、下载进度与安装操作区。
3. **首页顶栏更新入口与红点提示**：当检测到新版本时，在首页顶栏「文档收藏」按钮左侧紧邻位置显示更新按钮，并在更新按钮与全局偏好设置入口按钮上展示红点提示。
4. **双端差异化下载与安装**：
   - **Windows**：通过 `electron-updater` 在应用内自动单流下载更新包并展示进度，下载完成后支持一键「重启并覆盖安装」。
   - **macOS**：因未签名/未公证（`identity: null`）无法静默自替换，应用内直接从 GitHub Release 下载对应架构（`arm64` 或 `x64`）的 `.dmg` 安装包到本机「下载」目录并展示进度，完成后支持直接打开 `.dmg` 或在访达中定位（失败时提供「在 GitHub 下载 ↗」降级入口）。

---

## 2. 打包与发布配置（`package.json`）

### 2.1 依赖变更
- `dependencies` 新增 `"electron-updater": "^6.8.9"`（参考 `DeepseekHarnessApp`，主进程打包后运行时需加载该模块）。

### 2.2 `build` 配置调整
```json
{
  "publish": {
    "provider": "github",
    "owner": "dehuaichendragonplus",
    "repo": "csm"
  },
  "mac": {
    "category": "public.app-category.developer-tools",
    "target": [
      {
        "target": "dmg",
        "arch": ["arm64", "x64"]
      }
    ],
    "identity": null,
    "artifactName": "CSM-${version}-mac-${arch}.${ext}"
  },
  "win": {
    "verifyUpdateCodeSignature": false,
    "icon": "build/icon.png",
    "target": [
      {
        "target": "nsis",
        "arch": ["x64"]
      }
    ]
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "artifactName": "CSM-Setup-${version}-${arch}.${ext}"
  }
}
```
关键约束：
- `artifactName` **严禁包含空格**，避免手动/CLI 上传 GitHub Release 时空格被转换为点号 `.`，导致与 `latest.yml` 中记录的文件名不匹配。
- `win.verifyUpdateCodeSignature: false` 用于未签名安装包跳过 Authenticode 签名校验。
- `scripts` 新增：
  - `"dist:win": "electron-builder --win"`
  - `"dist": "electron-builder -m -w"`
  - 保留 `"dist:mac": "electron-builder --mac"`（将同时产出 `arm64` 与 `x64` 两个 `.dmg`）。

---

## 3. 架构与模块划分

### 3.1 模块边界图

```
┌──────────────────────────────┐
│  Renderer (public/index.html │
│  + public/updater-ui.js)     │
└───────▲──────────────┬───────┘
        │ onStateChange │ invoke (check/download/install/open/reveal)
┌───────┴──────────────▼───────┐      ┌───────────────────────────┐
│ electron/preload.js          │      │ server.js (/api/update-   │
│ (window.electronBridge.      │      │ check) — 浏览器模式降级    │
│  updater)                    │      └─────────────┬─────────────┘
└───────▲──────────────┬───────┘                    │
        │ IPC          │                            │
┌───────┴──────────────▼───────┐                    │
│ electron/main.js             │                    │
│   └─ electron/updater.js     ├────────────────────┤
│       ├─ Win: electron-updater                    ▼
│       └─ Mac: net.fetch 下载 .dmg ──► lib/github-update.js
└──────────────────────────────┘        (GitHub API + Atom 降级
                                         + 架构资产解析 + semver)
```

### 3.2 `lib/github-update.js`（GitHub Release 检测与资产解析）
可独立于 Electron 运行（便于 `node --test` 单元测试及 Express `/api/update-check` 复用）。

- **常量**：`DEFAULT_REPO = 'dehuaichendragonplus/csm'`
- **版本号比对**：复用 `lib/update-check.js` 中的 `parseVersion` / `compareVersions`（或统一导出）。
- **请求头构造 `getGitHubHeaders()`**：
  - `Accept: application/vnd.github+json`、`User-Agent: CSM-Desktop`
  - 优先读取 `process.env.GITHUB_TOKEN || process.env.GH_TOKEN`；若无则尝试缓存 60 秒的 `gh auth token`（超时 1500ms，失败静默忽略，仅用于本地开发避免 GitHub API 60次/小时未认证限流）。
- **主检测流程 `checkGitHubUpdate({ current, repo = DEFAULT_REPO, platform = process.platform, arch = process.arch, fetchImpl, log })`**：
  1. 请求 `https://api.github.com/repos/${repo}/releases/latest`（15s 超时）。
  2. 若成功，解析 `tag_name`（去除前导 `v`/`V`）、`html_url`、`body`、`published_at`、`assets`。
  3. 若 API 返回非 2xx（如 403 限流、404 无 Release）或网络异常，自动降级拉取 `https://github.com/${repo}/releases.atom`：
     - 解析首个 `<entry>` 的 `<title>`、`<link>`、`<updated>`、`<content>`。
     - 当无 `assets` 列表（Atom 降级场景）且 `platform === 'darwin'` 时，按打包命名约定构造预期直链：`https://github.com/${repo}/releases/download/${tag}/CSM-${latest}-mac-${arch}.dmg`（并标记 `assetInferred: true`），同时保留 `htmlUrl` 兜底。
  4. **macOS 资产匹配 `selectMacDmgAsset(assets, arch)`**：
     - 仅匹配 `.dmg` 后缀（忽略 `.blockmap` 等）。
     - 优先匹配文件名包含 `-${arch}.dmg` 或 `_${arch}.dmg` 或 `${arch}`（不区分大小写，且排除另一架构，例如 `arm64` 不匹配含 `x64` 的文件）的资产。
     - 若存在通用命名 `.dmg`（不含 `arm64`/`x64`），可作为次优兜底；若只有另一个架构的 `.dmg`，则不误选，返回 `null`（UI 将引导用户打开 Release 页面）。
  5. 返回统一结构：
     ```js
     {
       configured: true,
       source: 'github',
       current,
       latest,          // e.g. '1.2.0'
       tag,             // e.g. 'v1.2.0'
       hasUpdate,       // boolean
       notes,           // string (Release body)
       publishedAt,     // string | null
       htmlUrl,         // Release 网页链接
       downloadUrl,     // 当前平台匹配到的直链（mac 为对应 arch .dmg；win 可为空或匹配 .exe）
       fileName,        // mac 目标文件名，如 CSM-1.2.0-mac-arm64.dmg
       assetSize        // number | null
     }
     ```
- 若 API 与 Atom 均失败，抛出结构化错误或返回 `{ configured: true, current, hasUpdate: false, error }`（供界面展示「无法连接 GitHub，点击重试」）。

### 3.3 `electron/updater.js`（Electron 主进程更新器与状态机）
统一管理检测、下载、安装、取消（如需要）与事件广播，支持依赖注入以便单元测试。

- **状态结构 `UpdateState`**：
  ```js
  {
    status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error',
    platform: process.platform,           // 'win32' | 'darwin' | ...
    arch: process.arch,                   // 'arm64' | 'x64' | ...
    isPackaged: app.isPackaged,
    autoInstallSupported: boolean,        // win32 && app.isPackaged
    currentVersion: string,
    latestVersion: string | null,
    hasUpdate: boolean,
    notes: string,
    publishedAt: string | null,
    htmlUrl: string | null,
    downloadUrl: string | null,
    fileName: string | null,
    percent: number,                      // 0 ~ 100
    receivedBytes: number,
    totalBytes: number,
    downloadedFilePath: string | null,    // macOS 下载完成后的本地 .dmg 路径
    error: string | null,
    errorKind: 'missing-artifact' | 'network-reset' | 'unsupported' | 'unknown' | null,
    checkedAt: string | null              // ISO 时间戳
  }
  ```
- **Windows 分支（`win32 && app.isPackaged`）**：
  - 封装 `electron-updater` 的 `autoUpdater`（参考 `DeepseekHarnessApp/src/main/shell-auto-updater.js`）：
    - `autoDownload = false`
    - `autoInstallOnAppQuit = false`
    - `disableDifferentialDownload = true`
    - `disableWebInstaller = true`
    - 读取环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（大小写兼容），若存在则调用 `autoUpdater.netSession.setProxy({ proxyRules })`。
  - `checkForUpdates()`：先走 `checkGitHubUpdate` 获取版本与 Release 详情（保持与 macOS 一致的快速检测、Release notes 与错误提示），确认有更新或用户直接触发下载时，通过 `autoUpdater.checkForUpdates()` + `downloadUpdate()` 执行下载并实时更新 `percent`/`receivedBytes`/`totalBytes`。
  - 错误分类：匹配 `/Cannot find latest\.ya?ml|HttpError:\s*404/i` → `missing-artifact`；匹配 `/ERR_CONNECTION_RESET|ECONNRESET|ETIMEDOUT|timeout|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|socket hang up/i` → `network-reset`。
  - `installUpdate()`：调用 `autoUpdater.quitAndInstall(true, true)`；安装前及 `before-quit` 时关闭 `serverInfo.server` 与主窗口，确保进程干净退出不阻塞 NSIS 覆盖安装。
- **macOS 分支（`darwin`）**：
  - `checkForUpdates()`：调用 `checkGitHubUpdate` 获取 `latest`、`notes`、`htmlUrl`、`downloadUrl`、`fileName`。
  - `downloadUpdate()`：
    - 若当前未检测或无 `downloadUrl`，先执行一次 `checkForUpdates()`；若仍无匹配的 `.dmg` 下载链接（例如该 Release 尚未上传对应架构 `.dmg`），置为 `error`（`errorKind: 'missing-artifact'`）并保留 `htmlUrl` 供用户打开 GitHub 页面确认。
    - 使用 Electron `net.fetch(downloadUrl, { redirect: 'follow' })`（自动继承系统代理与网络栈；若在非 Electron 测试环境则注入 `fetchImpl`），流式写入 `${downloadsDir}/${uniqueFileName}.download`。
    - `uniqueFileName` 处理：若 `~/Downloads/CSM-1.2.0-mac-arm64.dmg` 已存在且大小一致（或直接生成不冲突文件名如 `CSM-1.2.0-mac-arm64 (1).dmg` / 若存在同名 `.dmg` 则自动加序号），保证不会静默损坏已有文件；临时 `.download` 文件写完且字节数 `> 0` 后（若响应含 `Content-Length`，须校验 `receivedBytes === totalBytes`）再 `fs.renameSync` 为最终 `.dmg`。
    - 写入过程中节流推送 `downloading` 状态与 `percent`（至少每 ~150ms 或百分比变化 1% 推送一次）。
    - 下载成功后置 `status = 'downloaded'`、`downloadedFilePath = finalPath`。
  - `openDownloaded()`：调用 `shell.openPath(downloadedFilePath)` 直接挂载并打开 `.dmg`。
  - `revealDownloaded()`：调用 `shell.showItemInFolder(downloadedFilePath)` 在访达中选中 `.dmg`。
- **开发态与不支持自动安装环境**：
  - macOS 未打包（`electron .` 开发模式）依然支持检测与下载 `.dmg`（方便直接在本机调试完整下载流程）。
  - Windows 未打包（`electron .`）时 `autoInstallSupported = false`，检测仍可用，点击下载时提示当前为开发模式、仅打包后支持自动安装并可打开 Release 页面。
- **防并发保护**：`checking` 或 `downloading` 状态下重复触发 `checkForUpdates` / `downloadUpdate` 直接返回当前进行中的 Promise 或当前状态，避免重复下载。

### 3.4 `electron/main.js` & `electron/preload.js` & `server.js`
- **`electron/main.js`**：
  - 初始化 `appUpdater = createAppUpdater({ app, net, shell, log: console.log })`。
  - 注册 IPC：
    - `ipcMain.handle('updater:get-state', ...)`
    - `ipcMain.handle('updater:check', ...)`
    - `ipcMain.handle('updater:download', ...)`
    - `ipcMain.handle('updater:install', ...)`
    - `ipcMain.handle('updater:open-downloaded', ...)`
    - `ipcMain.handle('updater:reveal-downloaded', ...)`
    - `ipcMain.handle('updater:open-release', ...)`
  - 当 `appUpdater` 状态变化时，向 `mainWindow.webContents.send('updater:state', state)` 广播。
  - 启动后延迟（如 3 秒）自动执行一次静默 `checkForUpdates()`，并每 6 小时定时检查一次。
- **`electron/preload.js`**：
  - 在 `window.electronBridge` 中新增 `updater` 对象，暴露上述 invoke 方法与 `onStateChange(callback)`（返回取消订阅函数）。
- **`server.js`**：
  - `/api/update-check`：
    - 若环境变量 `CSM_UPDATE_URL` 或 `PKG.csm.updateUrl` 显式设置了非空自定义源，保留原 `lib/update-check.js` 逻辑（保持向后兼容与既有单测不破坏）。
    - 否则默认调用 `lib/github-update.js` 的 `checkGitHubUpdate({ current: PKG.version })`，支持 `?force=1` 跳过 1 小时缓存，供纯浏览器模式使用。

---

## 4. 前端 UI 与交互设计

### 4.1 首页顶栏更新按钮与红点提示（`public/index.html` + `public/style.css` + `public/updater-ui.js`）
- **位置**：位于 `.chrome-tab-strip` 中 `#bookmarks-widget`（文档收藏按钮）紧邻左侧：
  ```html
  <button id="btn-app-update" type="button" class="tab-strip-update-btn hidden" title="发现新版本">
    <span class="update-red-dot" aria-hidden="true"></span>
    <span class="tab-strip-update-icon">⬇</span>
    <span id="btn-app-update-label">更新</span>
  </button>
  ```
- **红点提示**：
  - 当 `hasUpdate === true` 时：
    1. `#btn-app-update` 显示，按钮上带醒目红点 `.update-red-dot`（6px–7px 红色圆点，可带轻微呼吸光晕，已下载待安装态可切换为绿色就绪点或保持提示态）。
    2. 顶栏「全局偏好设置」入口按钮 `#tab-strip-profile` 右上角同步展示红点角标（`.profile-update-dot`），当已是最新版本时隐藏。
- **顶栏更新按钮状态与点击行为**：
  - `available`（发现新版本）：按钮文案 `更新 v1.2.0`（含红点）。点击后：
    - **Electron 桌面端**：**直接触发 `updater.downloadUpdate()`**（Windows 自动下载更新，macOS 直接从 GitHub 下载 `.dmg` 安装包），无需再二次跳转。
    - **纯浏览器模式**：直接打开新标签页跳转到 `downloadUrl || htmlUrl`。
  - `downloading`：按钮文案 `下载中 45%`（显示进度状态），点击可打开「全局偏好设置」弹窗定位到「关于 CSM」查看详情。
  - `downloaded`：
    - Windows：按钮文案 `重启安装 v1.2.0`，点击调用 `updater.installUpdate()`。
    - macOS：按钮文案 `打开安装包 v1.2.0`，点击调用 `updater.openDownloaded()`。
  - `error`（但仍已知有新版本 `hasUpdate`）：按钮文案 `更新失败 · 重试`（含红点），点击打开全局偏好设置查看原因或重试。
- 原 `#update-banner`：在有顶栏更新按钮的新设计下不再默认弹出占满整行的横幅（从 `panels.js` 移除重复自动请求，统一由 `updater-ui.js` 驱动，避免启动重复请求两次 GitHub）。

### 4.2 全局偏好设置 → 关于 CSM（`public/index.html` + `public/app.js` + `public/updater-ui.js`）
在截图所示「全局偏好设置」弹窗的「关于 CSM」区块扩展如下：
- **软件版本行**：
  - 左侧：标题「软件版本」 + 说明文字「Google Sheets 配置表与本地 xlsx 双向同步工具」
  - 右侧：当前版本标签 `CSM v1.1.3` + **「检查更新」按钮**（`#btn-check-update`，当已知有新版本时按钮旁/右上角带红点 `.update-red-dot`；检测中显示「检查中…」并禁用）。
- **更新详情面板**（`#global-update-panel`，仅在检测出新版本、已是最新（手动检查后反馈）、正在下载、下载完成或报错时展示）：
  - **已是最新**：`✓ 当前已是最新版本（v1.1.3）`（带上次检查时间）。
  - **发现新版本（`available`）**：
    - 标题：`发现新版本 v1.2.0` + `在 GitHub 查看 ↗` 链接 + 发布日期
    - 简明更新说明区域（Release body 纯文本/换行安全渲染，过长可限高滚动）
    - 操作按钮：
      - Windows（`autoInstallSupported === true`）：主按钮「下载更新」
      - Windows（开发态）：提示「开发模式请使用安装包」+「前往 GitHub 下载 ↗」
      - macOS：主按钮「下载安装包 (.dmg)」
  - **下载中（`downloading`）**：
    - 进度条 + 百分比与字节大小（如 `45% · 38.2 MB / 84.9 MB`）。
  - **下载完成（`downloaded`）**：
    - Windows：主按钮「重启并覆盖安装」（点击后禁用并显示「正在退出并安装…」）。
    - macOS：提示保存路径（如 `已下载至 ~/Downloads/CSM-1.2.0-mac-arm64.dmg`）+ 主按钮「打开安装包」+ 次按钮「在访达中显示」。
  - **失败（`error`）**：
    - 错误框展示具体错误信息 + 「重试」按钮 + 「在 GitHub 下载 ↗」按钮。
    - 针对 `missing-artifact`（`latest.yml` 404 或对应 `.dmg` 尚未上传）与 `network-reset`（连接重置/超时），给出参考 `DeepseekHarnessApp` 的中文排查提示。

---

## 5. 测试与验证策略

1. **单元测试（`node --test`）**：
   - `test/github-update.test.js`：
     - GitHub API 正常返回（有新版 / 已是最新 / 无 Release）
     - API 403 / 网络错误时降级到 `releases.atom` 解析与推断 macOS `.dmg` 链接
     - `selectMacDmgAsset` 对 `arm64` / `x64` / 通用命名 / 仅单架构包时的精准匹配（确保 `arm64` 不会误下 `x64`，反之亦然）
   - `test/electron-updater.test.js`：
     - 注入 mock `autoUpdater` 验证 Windows 下载成功 / `404 latest.yml` 错误分类 / `ERR_CONNECTION_RESET` 分类 / `quitAndInstall` 调用 / 代理设置
     - 注入 mock `fetch` + 临时目录验证 macOS 流式下载 `.dmg`、`.download` 原子重命名、字节数校验失败清理、同名文件去重及 `openPath` / `showItemInFolder` 调用
   - 保持既有 `test/update-check.test.js` 与全部 `npm test` 通过。
2. **打包与静态检查**：
   - 执行 `npm test` 验证所有单元测试通过。
   - 验证 `electron-builder` 配置有效性（在本机 macOS 上可验证 `npx electron-builder --dir -m` 或检查配置输出；Windows 交叉打包视本机环境情况说明验证范围）。
   - 检查前后端语法与 Electron 启动渲染正常。
