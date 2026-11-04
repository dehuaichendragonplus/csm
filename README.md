# CSM（Config Sync Manager）

> 通用工具：项目相关的内容（表格清单、导出服务、生成命令）全部在 `syncmanager.config.json` 里，代码本身与项目无关，可直接复用到其他项目，见下文「复用到其他项目」。

图形化工具（桌面 App，或浏览器访问本地服务），用于检测配置文件里 `filelist` 所指的的 Google Sheets 表格哪些与本地 xlsx 文件存在差异，并支持下载到本地、或把本地 xlsx 上传覆盖云端。

可同时管理多个项目（见「多项目平台」）。

## 桌面 App（推荐，仅 macOS）

不需要安装 Node，双击即用。安装包由维护者构建后分发（见下文「构建 App 安装包」）：

| 系统 | 安装包 |
|---|---|
| macOS Apple 芯片（M 系列） | `CSM-<版本>-mac-arm64.dmg` |
| macOS Intel 芯片 | `CSM-<版本>-mac-x64.dmg` |

**首次打开（macOS）**：安装包没有 Apple 开发者签名，第一次双击会被系统拦截。把 App 拖进「应用程序」后，在 Finder 里**右键 → 打开 → 打开**即可，之后正常双击。如果提示「已损坏，无法打开」，在终端执行一次：

```bash
xattr -dr com.apple.quarantine "/Applications/CSM.app"
```

App 与命令行版的区别：

- **Google 授权在系统浏览器里完成**（Google 不允许在 App 内嵌窗口里登录）。点「前往授权」后会打开默认浏览器，授权完成后回到 App，App 会自动刷新。
- **数据目录**改为系统应用数据目录：`~/Library/Application Support/CSM/`（由旧版 Sync Manager App 升级时，首次启动会自动把旧目录的项目、授权和同步状态复制过来）。目录结构与命令行版的 `data/` 相同；从命令行版迁移时，把工具目录 `data/` 下的内容复制过去即可。运行日志在该目录的 `logs/main.log`。
- **OAuth 凭证**：构建时工具目录里有 `credentials.json` 就会打进安装包，用户无需再配置；没有打进去时，App 首次启动会让用户选择一次 `credentials.json`，并保存到数据目录。
- **自定义动作的环境变量**：从访达或 Dock 启动的 App 拿不到终端里的 PATH，App 启动时会读取一次登录 shell 的环境变量（Homebrew、dotnet 等），所以 `actions` 里的命令和在终端里执行时一样。
- 同一时间只能运行一个实例；macOS 关闭窗口后 App 仍在 Dock 中，点 Dock 图标可以重新打开窗口。

### 构建 App 安装包（维护者）

```bash
npm install
npm run app        # 开发模式直接运行（不打包）
npm run dist:mac   # 输出 dist/ 下的 arm64 + x64 dmg
```

- 版本号取 `package.json` 的 `version`，发新版前先改这里。
- 构建前把 `credentials.json` 放在工具目录，就会打进安装包（`Contents/Resources/credentials.json`）。不要把安装包发到团队以外。
- 目前**不签名**（`build.mac.identity: null`）。有公司 Apple Developer ID 后，删掉这一项并配置签名和公证，用户就不用再「右键打开」。

## 环境要求（命令行 / 浏览器方式）

- Node.js ≥ 18（项目使用 Node 内置测试运行器）
- 拥有各项目表格读取权限（要上传覆盖则需编辑权限）的 Google 账号
- 一个 OAuth 2.0 客户端（Desktop 类型）—— 详见下文「初次配置」

## 多项目平台

一个 CSM 管理多个项目。页面最上方是项目标签栏；下方是当前项目区（项目名、目录，左侧是刷新、下载所有更新、自定义动作，右侧是配置表清单、清除缓存，都只作用于当前项目），切换项目后整块随之切换：

- **添加项目**：点「＋ 添加项目」，在弹窗里逐级浏览目录，选中项目的**配置表目录**（含 `syncmanager.config.json` 或 `filelist.json` 的目录会标 ★），点「添加此目录」。
  - 目录里已有 `syncmanager.config.json` → 直接使用。
  - 只有 `filelist.json`（根目录或 `Input/` 下）→ 自动生成一份最小配置（走 Drive API 导出、无自定义动作），之后可自行编辑补充。
  - 两者都没有 → 提示错误，不添加。
- **移除项目**：点标签上的 ✕。只是平台不再管理，项目目录里的文件不会被删。
- **切换项目**：点标签。上次选的项目会被记住。

### 数据放在哪

| 内容 | 位置 |
|---|---|
| 项目注册表 | `data/projects.json` |
| Google 授权令牌（所有项目共用一个账号） | `data/.tokens/token.json` |
| 各项目同步状态 | `data/projects/<项目id>/.sync_state.json` |
| 项目自己的配置 | 项目目录下的 `syncmanager.config.json`（建议随项目入库） |
| OAuth 客户端凭证 | 工具目录 `credentials.json` |

以上是命令行版的位置；桌面 App 的数据目录见「桌面 App」一节。两种方式都可用环境变量 `CSM_DATA` 改变数据目录（旧名 `SYNC_MANAGER_DATA` 仍然有效）。配置文件每次请求都会重新读取，改完无需重启。

### 项目配置 `syncmanager.config.json`

路径一律相对该配置文件所在目录，样例见 `syncmanager.config.example.json`。

| 字段 | 必填 | 说明 |
|---|---|---|
| `filelist` | 是 | 表格清单 JSON 路径，格式为数组，每项 `{ "path": "相对清单目录的 xlsx 路径", "spreadsheetId": "...", "name": "...", "description": "..." }`（可选 `mergeCells`，仅内部导出服务使用） |
| `title` | 否 | 标签页上显示的项目名，默认目录名 |
| `sidecar` | 否 | 入仓的版本记录文件，用于 `git pull` 后避免误判「有更新」；不填则不启用 |
| `export.url` / `export.password` | 否 | 内部导出服务。**不填则直接用 Drive API 导出 xlsx**（单表 ≤10MB） |
| `cloudRoot` | 否 | 云端目录映射 `{ "folderId": "云端根文件夹 ID", "local": "Datas" }`，新增配置表时按云端子目录放到本地对应目录；不填则自动推断，见「云端目录映射」 |
| `allowUpload` | 否 | 是否显示每行的「上传」按钮，默认 true |
| `actions` | 否 | 自定义动作列表，每项 `{ id, label, steps:[{ label, cwd, command }] }`，渲染成顶部按钮，点击后依次执行各步骤（任一步失败即中止），日志实时显示；`command` 可写字符串，或 `{ "unix": "...", "win": "..." }`，在 `cwd` 下经 shell 执行。动作只手动触发，下载后不会自动执行 |

## 配置表清单（filelist.json）预览与编辑

项目栏右侧「📋 配置表清单」打开当前项目 `filelist.json` 的列表，不用手改 JSON。

- **列表分两组**（筛选对两组都生效，分组可折叠）：
  - **云端表**：已在 `filelist.json` 中的条目——表名、本地路径、备注、云端链接、本地 xlsx 是否已下载；双击行或点「编辑」修改
  - **本地表**：本地目录（映射的本地目录，默认 `Datas/`）下存在、但还没加入清单的 xlsx，显示上传后会放到的云端目录
- **上传本地表**：点「上传」（或双击）弹出确认窗口，可改云端表名 / 表名 / 备注；确认后：
  1. 按本地相对目录在云端映射根目录下找到**同样的相对目录**（例如本地 `Datas/Activity/Sub/X.xlsx` → 云端 `<根目录> / Activity / Sub / X`），缺的文件夹逐级自动创建
  2. 用本地 xlsx 新建 Google 表格（不会修改本地文件）
  3. 加入 `filelist.json`，并记为已同步（有 sidecar 时同时写入）
  - 云端同目录已有同名表时会询问：直接关联那张已有表（不上传、不覆盖），或返回改名
  - 「全部上传」/「上传筛选出的 N 张」：逐张上传，遇到同名表自动关联，结果写进日志
  - 需要先有云端目录映射（项目配置或自动推断）；不在映射本地目录下的文件无法上传
  - 需要 Google 授权包含 drive 写权限（与「上传覆盖云端」相同）
- **新增 / 编辑**：点「＋ 新增配置表」或「编辑」弹出独立窗口，确认后直接写回 `filelist.json` 并刷新列表（新行会高亮）
  - 粘贴 Google 表格链接（或 ID）自动解析：云端表名、所在云端目录，并填好表名（括号里的中文）、本地路径、备注（完整云端表名）
  - **本地路径与云端目录对齐**：云端 `MX11 / Data / Activity / 表` → 本地 `Configs/Input/Datas/Activity/表.xlsx`
  - 表名、本地路径、备注都可以留空：保存时按云端表自动生成
  - 编辑时粘贴新链接可以换绑云端表（只补空字段）；`mergeCells` 等其他字段会保留
  - 支持的链接：`docs.google.com/spreadsheets/d/<id>/...`、`drive.google.com/file/d/<id>/...`、`...?id=<id>`，或直接粘贴 ID
- **删除**：只从 `filelist.json` 里移除条目，**不删除本地 xlsx，也不动云端表**
- **校验**：路径必须是相对 `filelist.json` 所在目录的 `.xlsx` 路径且不能跳出该目录；路径重复直接拒绝；同一个云端表已在清单中时弹窗确认（现有清单里本来就有这种情况，所以只提醒、不禁止）
- **写回格式**：保留原文件的缩进、字段顺序和末尾换行；格式不规范的地方（如 `}` 和 `,` 分在两行）第一次保存时会被规整，提交前看一下 diff
- 改完记得在项目仓库里提交 `filelist.json`

### 云端目录映射

决定「云端哪个文件夹」对应「本地哪个目录」，列表顶部会显示当前生效的映射。按以下优先级取：

1. **项目配置**：点「设置映射」，粘贴云端根文件夹链接（`https://drive.google.com/drive/folders/…`）和本地目录（默认 `Datas`），写入项目的 `syncmanager.config.json`：
   ```json
   "cloudRoot": { "folderId": "<云端文件夹 ID>", "local": "Datas" }
   ```
2. **自动推断**（未配置时）：抽样清单里已有的条目，对比它们的云端目录和本地路径，推断出映射。例如 MergeX11 推断为云端 `MX11 / Data` ↔ 本地 `Datas`。首次需要几秒，之后会缓存
3. **按所在文件夹**（清单为空推断不出时）：放到 `Datas/<云端所在文件夹名>/`

新表不在映射的云端根目录下时，同样按所在文件夹放置，并在界面上提示需要人工确认路径。

## 搜索配置表

表格列表上方的搜索框（快捷键 `⌘F`，或不在输入框里时按 `/`）按**表名、xlsx 路径、云端表名、备注、spreadsheetId** 实时过滤，大小写不敏感；空格分隔多个关键词时需全部命中。

- 命中的分组会自动展开，命中文字高亮；如果是靠路径命中的，表名后面会显示路径
- 只命中一个表时按回车，直接下载这个表
- 按 `Esc` 或点输入框里的 ✕ 清空搜索
- 搜索只影响显示，「下载所有更新」仍然作用于全部表

## 上传覆盖云端

每行的「上传」按钮会把该行对应的**本地 xlsx** 直接覆盖到云端 Google 表（确认后执行，云端旧内容可在 Google 表格版本历史中恢复）。需要 Google 授权包含 `drive` 写权限：旧版本只授权了只读，首次上传若提示权限不足，访问 `/auth/start` 重新授权一次即可。

## 初次配置

`credentials.json`（OAuth 客户端密钥）**不入库**：首次使用请从团队 wiki / 维护者处获取，放到本目录（格式见 `credentials.json.example`）。之后：

1. `cd` 到本目录
2. 运行 `./start.sh`（Mac）或 `start.bat`（Windows）。
3. 首次启动时浏览器会自动跳转到 Google 授权页 → 点击「允许」（首次使用需保证你的 Google 账号已被加入 OAuth 客户端的 test users 名单，由维护者管理）。refresh token 会保存在本地 `.tokens/token.json`。
4. 主页面按状态分组列出所有表格。

### 维护者：如何重新生成 OAuth 客户端（仅在 client_secret 泄漏 / 失效时执行）

1. [Google Cloud Console](https://console.cloud.google.com/) → 启用 **Google Drive API**
2. 「OAuth 同意屏」选 External，把团队成员的 Google 邮箱加到 **Test users**
3. 「Credentials」→ 创建 OAuth client ID，类型必须是 **Desktop app**
4. 下载生成的 JSON → 替换本目录下的 `credentials.json`
5. 把新的 `credentials.json` 分发给使用者（该文件已被 .gitignore 忽略）

> Desktop 类型 OAuth 的 `client_secret` 按 [Google 官方文档](https://developers.google.com/identity/protocols/oauth2#installed)说明并非真正机密，仅在私有内部仓库中提交是可接受的实践。

## 日常使用

- **刷新**：调用 Drive API 查询每个表格的 `modifiedTime`，更新状态徽标。
- **下载**（或点击单行）：下载该表对应的 xlsx 到本地，并更新本地状态。
- **下载所有更新**：批量下载所有需要同步的表。
- **顶部自定义按钮**（如 MergeX11 的「Luban导出」）：由项目配置的 `actions` 生成，手动点击执行。
- **上传**：见下文「上传覆盖云端」。

## 目录结构

> 下面的 `.sync_state.json`、`.tokens/`、`sync-versions` 已按上文「数据放在哪」调整：状态与令牌在 `data/`，sidecar 在各项目目录里。

- `server.js` — Express 服务，默认监听端口 7321（被占用时自动递增寻找可用端口）
- `lib/` — 各功能模块（status、sync-state、drive-api、downloader、gen-client-runner、version-sidecar 等）
- `public/` — HTML / CSS / JS 前端
- `lib/filelist-editor.js` — filelist.json 的增删改、链接解析、表名与路径推荐
- `lib/drive-tree.js` — 云端目录链查询、云端根目录推断与本地路径对齐
- `lib/local-tables.js` — 扫描未加入清单的本地表、计算对应的云端相对目录
- `electron/main.js` — 桌面 App 外壳（启动 server.js、窗口、系统浏览器授权、原生选目录）
- `build/icon.png` — App 图标（electron-builder 自动转换为 icns / ico）
- `.sync_state.json` — 本机每个表上次同步时的 size / mtime / 云端 `modifiedTime`（gitignore）
- `.tokens/token.json` — OAuth refresh token（gitignore）
- `credentials.json` — OAuth 客户端 ID / Secret
- `各项目 `sidecar` 所指文件` — **入仓**的 sidecar：每个 xlsx 对应的云端 `modifiedTime`。下载时由本工具自动维护

## sidecar 协同（解决 git pull 后误判"有更新"）

如果你刚从 git 拉取了新的 xlsx，工具会读取项目配置里 `sidecar` 指向的入仓文件（如 `Input/.sync-versions.json`），**自动**为本地 `.sync_state.json` 填充对应条目（lastSyncedModifiedTime 取 sidecar 的值，size / mtime 取本地实际值）。然后正常状态判定：

- 云端 modifiedTime == sidecar 记录 → **已同步**（不会误标"有更新"）
- 云端 modifiedTime > sidecar 记录 → **有更新**（说明仓库里的版本旧于云端最新版）

每次本工具下载完一个 xlsx 后，会同时更新 `.sync_state.json`（本机）和 `.sync-versions.json`（入仓）。提交 xlsx 改动时把 sidecar 文件一起提交即可。

## 常见问题排查

| 现象 | 解决方法 |
|---|---|
| 启动时报「OAuth credentials not found」 | 确认目录下存在 `credentials.json` |
| 浏览器一直被重定向到 `/auth/start` | Token 可能已被撤销；删除 `.tokens/` 目录并重新授权 |
| 某行显示「错误: forbidden」 | 你的 Google 账号无权读取该表格，联系表格所有者添加共享权限 |
| 端口 7321 被占用 | 工具会自动寻找下一个可用端口；查看控制台输出获取实际 URL |

## 运行测试

```bash
npm test
```

执行 `node --test 'test/**/*.test.js'`。覆盖纯逻辑层（状态判定、状态持久化、filelist 解析、端口扫描、表格聚合、基于本地 mock server 的下载器）。OAuth 与 Drive API 部分通过手动方式验证。
