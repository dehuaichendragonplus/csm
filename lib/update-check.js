'use strict';
// 检查新版本：读取维护者发布的更新清单（latest.json），与当前版本比较。
// 安装包未签名，macOS 不允许静默替换 App，所以只提示并给出下载链接，由用户手动安装。
//
// 更新源（按优先级）：环境变量 CSM_UPDATE_URL > package.json 的 csm.updateUrl。支持：
// - http(s) 地址：直接下载 latest.json
// - Google Drive 文件链接 / drive:<文件ID>：用当前 Google 授权读取（团队共享盘里放一份即可，无需另搭服务器）
//
// latest.json 格式（scripts/make-update-manifest.js 生成）：
// { "version": "1.1.0", "date": "...", "notes": "更新说明", "url": "发布页（可选）",
//   "downloads": { "darwin-arm64": "<dmg 链接>", "darwin-x64": "<dmg 链接>" } }

function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

function driveIdOf(source) {
  const s = String(source || '').trim();
  let m = /^drive:([\w-]+)$/.exec(s);
  if (m) return m[1];
  m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]+)/.exec(s);
  return m ? m[1] : null;
}

/**
 * fetchJson(url) 与 fetchDrive(fileId) 由调用方注入（便于测试，Drive 读取要用服务端的 OAuth）。
 * 返回 { configured, current, latest, hasUpdate, notes, date, download, url }
 */
async function checkForUpdate({ source, current, platform = process.platform, arch = process.arch, fetchJson, fetchDrive }) {
  if (!source) return { configured: false, current, hasUpdate: false };
  const driveId = driveIdOf(source);
  let manifest;
  if (driveId) {
    if (!fetchDrive) throw new Error('需要 Google 授权才能读取 Drive 上的更新清单');
    manifest = await fetchDrive(driveId);
  } else if (/^https?:\/\//i.test(source)) {
    manifest = await fetchJson(source);
  } else {
    throw new Error(`无法识别的更新源：${source}`);
  }
  if (!manifest || typeof manifest !== 'object' || !parseVersion(manifest.version)) throw new Error('更新清单格式不正确（缺少 version）');
  const downloads = manifest.downloads || {};
  return {
    configured: true,
    current,
    latest: String(manifest.version),
    hasUpdate: compareVersions(manifest.version, current) > 0,
    notes: manifest.notes || '',
    date: manifest.date || null,
    download: downloads[`${platform}-${arch}`] || downloads[platform] || null,
    url: manifest.url || null
  };
}

async function httpJson(url, { timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkForUpdate, compareVersions, parseVersion, driveIdOf, httpJson };
