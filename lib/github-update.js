'use strict';
// 从 GitHub Releases 检测新版本，并为当前平台挑选安装包。
// 不依赖 Electron：主进程更新器、Express /api/update-check 与单元测试共用。
//
// 检测顺序：GitHub REST API（releases/latest）→ 失败（403 限流 / 404 / 网络异常）时降级读取 releases.atom。
// Atom 没有资产列表，macOS 按打包命名约定 CSM-${version}-mac-${arch}.dmg 推断直链（assetInferred: true）。
const { execFile } = require('node:child_process');
const { compareVersions, parseVersion } = require('./update-check');

const DEFAULT_REPO = 'dehuaichendragonplus/csm';
const REQUEST_TIMEOUT_MS = 15000;
const ARCHES = ['arm64', 'x64'];

// ---------- 请求头：有 token 时带上，避免本地开发撞上未认证 60 次/小时的限流 ----------
let ghTokenCache = null; // { at, token }
const GH_TOKEN_TTL_MS = 60 * 1000;

function readGhCliToken() {
  if (ghTokenCache && Date.now() - ghTokenCache.at < GH_TOKEN_TTL_MS) return Promise.resolve(ghTokenCache.token);
  return new Promise(resolve => {
    try {
      execFile('gh', ['auth', 'token'], { timeout: 1500 }, (err, stdout) => {
        const token = err ? '' : String(stdout || '').trim();
        ghTokenCache = { at: Date.now(), token };
        resolve(token);
      });
    } catch (_) {
      ghTokenCache = { at: Date.now(), token: '' };
      resolve('');
    }
  });
}

async function getGitHubHeaders({ env = process.env, readGhToken = readGhCliToken } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'CSM-Desktop' };
  let token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  if (!token && readGhToken) {
    try { token = await readGhToken(); } catch (_) { token = ''; }
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function stripV(tag) {
  return String(tag || '').trim().replace(/^[vV]/, '');
}

// ---------- 资产匹配 ----------
function hasArchToken(name, arch) {
  // 以分隔符/边界包围的架构标识，避免 "x64" 误命中 "arm64x64something" 之类
  return new RegExp(`(^|[^a-z0-9])${arch}([^a-z0-9]|$)`, 'i').test(name);
}

/** 挑选 macOS 当前架构的 .dmg；只有另一架构的包时返回 null，不误选。 */
function selectMacDmgAsset(assets, arch) {
  const dmgs = (assets || []).filter(a => a && /\.dmg$/i.test(a.name || ''));
  const others = ARCHES.filter(a => a !== arch);
  const exact = dmgs.find(a => hasArchToken(a.name, arch) && !others.some(o => hasArchToken(a.name, o)));
  if (exact) return exact;
  // 通用命名（不带任何架构标识，如 universal 包）作为次优兜底
  const generic = dmgs.find(a => !ARCHES.some(x => hasArchToken(a.name, x)));
  return generic || null;
}

/** Windows 安装包：优先 -Setup- 的 .exe，其次任意 .exe（忽略 blockmap）。 */
function selectWinExeAsset(assets, arch) {
  const exes = (assets || []).filter(a => a && /\.exe$/i.test(a.name || ''));
  return exes.find(a => /setup/i.test(a.name) && hasArchToken(a.name, arch))
    || exes.find(a => /setup/i.test(a.name))
    || exes[0]
    || null;
}

// ---------- 网络 ----------
async function fetchWithTimeout(fetchImpl, url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 解析 releases.atom 的第一个 <entry>。 */
function parseReleasesAtom(xml) {
  const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(String(xml || ''));
  if (!entry) return null;
  const body = entry[1];
  const pick = re => { const m = re.exec(body); return m ? m[1] : null; };
  const link = pick(/<link[^>]*href="([^"]+)"/i);
  const title = decodeXml(pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || '').trim();
  // tag 优先从链接 /releases/tag/<tag> 取，标题可能是自定义文案
  const tagFromLink = link && /\/releases\/tag\/([^/?#]+)/.exec(link);
  const tag = tagFromLink ? decodeURIComponent(tagFromLink[1]) : title;
  return {
    tag,
    title,
    htmlUrl: link,
    updated: pick(/<updated>([\s\S]*?)<\/updated>/i),
    notes: htmlToText(decodeXml(pick(/<content[^>]*>([\s\S]*?)<\/content>/i) || ''))
  };
}

function macDmgName(version, arch) {
  return `CSM-${version}-mac-${arch}.dmg`;
}

function buildResult({ current, repo, platform, arch, tag, htmlUrl, notes, publishedAt, assets, source }) {
  const latest = stripV(tag);
  if (!parseVersion(latest)) throw new Error(`无法识别的 Release 版本号：${tag || '(空)'}`);
  const result = {
    configured: true,
    source,
    current,
    latest,
    tag,
    hasUpdate: compareVersions(latest, current) > 0,
    notes: notes || '',
    publishedAt: publishedAt || null,
    htmlUrl: htmlUrl || `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    downloadUrl: null,
    fileName: null,
    assetSize: null,
    assetInferred: false
  };
  if (platform === 'darwin') {
    if (assets) {
      const a = selectMacDmgAsset(assets, arch);
      if (a) Object.assign(result, { downloadUrl: a.browser_download_url, fileName: a.name, assetSize: a.size || null });
    } else {
      const fileName = macDmgName(latest, arch);
      Object.assign(result, {
        downloadUrl: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${fileName}`,
        fileName,
        assetInferred: true
      });
    }
  } else if (platform === 'win32' && assets) {
    const a = selectWinExeAsset(assets, arch);
    if (a) Object.assign(result, { downloadUrl: a.browser_download_url, fileName: a.name, assetSize: a.size || null });
  }
  // 兼容旧前端字段
  result.download = result.downloadUrl;
  result.url = result.htmlUrl;
  result.date = result.publishedAt;
  return result;
}

/**
 * 检测 GitHub Release 新版本。
 * API 与 Atom 都失败时不抛异常，返回 { configured: true, current, hasUpdate: false, error }。
 */
async function checkGitHubUpdate({
  current,
  repo = DEFAULT_REPO,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  headers,
  log = () => {}
} = {}) {
  const common = { current, repo, platform, arch };
  let apiError = null;
  try {
    const h = headers || await getGitHubHeaders();
    const resp = await fetchWithTimeout(fetchImpl, `https://api.github.com/repos/${repo}/releases/latest`, { headers: h });
    if (!resp.ok) throw new Error(resp.status === 404 ? 'GitHub 上还没有发布任何 Release（HTTP 404）' : `GitHub API HTTP ${resp.status}`);
    const data = await resp.json();
    return buildResult({
      ...common,
      source: 'github',
      tag: data.tag_name,
      htmlUrl: data.html_url,
      notes: data.body,
      publishedAt: data.published_at,
      assets: Array.isArray(data.assets) ? data.assets : []
    });
  } catch (err) {
    apiError = err;
    log(`[github-update] API 检测失败，降级 releases.atom：${err.message}`);
  }
  try {
    const resp = await fetchWithTimeout(fetchImpl, `https://github.com/${repo}/releases.atom`, { headers: { Accept: 'application/atom+xml', 'User-Agent': 'CSM-Desktop' } });
    if (!resp.ok) throw new Error(`releases.atom HTTP ${resp.status}`);
    const entry = parseReleasesAtom(await resp.text());
    if (!entry) throw new Error('GitHub 上还没有发布任何 Release');
    return buildResult({
      ...common,
      source: 'github-atom',
      tag: entry.tag,
      htmlUrl: entry.htmlUrl,
      notes: entry.notes,
      publishedAt: entry.updated,
      assets: null
    });
  } catch (err) {
    log(`[github-update] Atom 降级也失败：${err.message}`);
    const noRelease = /还没有发布任何 Release/.test(err.message);
    return {
      configured: true,
      source: 'github',
      current,
      hasUpdate: false,
      noRelease,
      htmlUrl: `https://github.com/${repo}/releases`,
      error: noRelease ? `GitHub 仓库 ${repo} 还没有发布任何 Release` : `无法连接 GitHub 检查更新：${(apiError && apiError.message) || err.message}`
    };
  }
}

module.exports = {
  DEFAULT_REPO,
  checkGitHubUpdate,
  selectMacDmgAsset,
  selectWinExeAsset,
  parseReleasesAtom,
  getGitHubHeaders,
  macDmgName,
  stripV
};
