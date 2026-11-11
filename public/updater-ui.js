// 应用内更新 UI：顶栏更新按钮 + 红点、全局偏好设置「关于 CSM」里的检查更新与下载/安装面板。
// - Electron 桌面端：状态来自主进程 electron/updater.js（window.electronBridge.updater）
// - 纯浏览器模式：调用 /api/update-check，只做检测并跳转下载页
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const bridge = window.electronBridge && window.electronBridge.updater;

  const els = {
    topBtn: $('btn-app-update'),
    topLabel: $('btn-app-update-label'),
    profileDot: $('profile-update-dot'),
    appTitle: $('app-title'),
    profileBtn: $('tab-strip-profile'),
    versionTag: $('global-settings-version'),
    checkBtn: $('btn-check-update'),
    checkLabel: $('btn-check-update-label'),
    checkDot: $('check-update-dot'),
    panel: $('global-update-panel'),
    aboutGroup: $('settings-about-group')
  };

  let state = null;
  let manualChecked = false; // 手动检查过才展示「已是最新」反馈
  let installing = false;

  // ---------- 工具 ----------
  function fmtBytes(n) {
    if (!n || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function tildePath(p) {
    return String(p || '').replace(/^\/Users\/[^/]+/, '~');
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'onclick') node.addEventListener('click', v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  const ERROR_HINTS = {
    'missing-artifact': '新版本的安装包可能还在上传中，或 GitHub Release 中缺少 latest.yml / 当前架构的安装包。请稍后重试，或前往 GitHub 页面手动下载。',
    'network-reset': '连接 GitHub 下载服务器被重置或超时（国内网络常见）。可开启或切换代理 / 加速器后重试，或前往 GitHub 页面手动下载安装包。',
    unsupported: '当前环境不支持应用内安装，请前往 GitHub 页面下载安装包手动安装。'
  };

  // ---------- 浏览器模式：把 /api/update-check 结果转成与桌面端一致的状态 ----------
  function fromApiResult(r, prev) {
    const base = {
      platform: 'browser',
      isPackaged: false,
      autoInstallSupported: false,
      currentVersion: r.current,
      percent: 0,
      receivedBytes: 0,
      totalBytes: 0,
      downloadedFilePath: null,
      checkedAt: new Date().toISOString()
    };
    if (r.error) {
      return {
        ...(prev || {}), ...base,
        status: 'error', error: r.error, errorKind: /无法连接|超时|ECONN|ENOTFOUND|fetch failed/i.test(r.error) ? 'network-reset' : 'unknown',
        hasUpdate: !!(prev && prev.hasUpdate), htmlUrl: r.htmlUrl || r.url || (prev && prev.htmlUrl) || null
      };
    }
    return {
      ...base,
      status: r.hasUpdate ? 'available' : 'up-to-date',
      latestVersion: r.latest || null,
      hasUpdate: !!r.hasUpdate,
      notes: r.notes || '',
      publishedAt: r.publishedAt || r.date || null,
      htmlUrl: r.htmlUrl || r.url || null,
      downloadUrl: r.downloadUrl || r.download || null,
      fileName: r.fileName || null,
      error: null,
      errorKind: null
    };
  }

  async function apiCheck(force) {
    setState({ ...(state || {}), status: 'checking' });
    try {
      const r = await (await fetch(`/api/update-check${force ? '?force=1' : ''}`)).json();
      setState(fromApiResult(r, state));
    } catch (err) {
      setState(fromApiResult({ current: state && state.currentVersion, error: `检查更新失败：${err.message}` }, state));
    }
  }

  // ---------- 动作 ----------
  function openExternal(url) {
    if (url) window.open(url, '_blank', 'noopener');
  }

  function openRelease() {
    if (bridge) bridge.openRelease();
    else openExternal(state && (state.htmlUrl || state.downloadUrl));
  }

  function check() {
    manualChecked = true;
    if (bridge) return bridge.check().then(setState);
    return apiCheck(true);
  }

  function download() {
    if (!bridge) return openExternal(state && (state.downloadUrl || state.htmlUrl));
    return bridge.download().then(setState);
  }

  async function install() {
    if (!bridge || !state) return;
    if (state.platform === 'win32') {
      installing = true;
      render();
      const r = await bridge.install();
      if (r && !r.ok) { installing = false; render(); alert(r.error || '安装失败'); }
      return;
    }
    const r = await bridge.openDownloaded();
    if (r && !r.ok) alert(r.error || '无法打开安装包');
  }

  async function reveal() {
    if (!bridge) return;
    const r = await bridge.revealDownloaded();
    if (r && !r.ok) alert(r.error || '无法在访达中显示');
  }

  function openAboutSettings() {
    if (els.profileBtn) els.profileBtn.click();
    requestAnimationFrame(() => {
      if (els.aboutGroup) els.aboutGroup.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // ---------- 渲染 ----------
  function setState(next) {
    if (!next) return;
    state = next;
    render();
  }

  function isMac() { return state && state.platform === 'darwin'; }
  function isWin() { return state && state.platform === 'win32'; }

  function renderTopButton() {
    const btn = els.topBtn;
    if (!btn) return;
    const s = state;
    const show = !!(s && (s.hasUpdate || s.status === 'downloaded'));
    btn.classList.toggle('hidden', !show);
    if (els.profileDot) els.profileDot.classList.toggle('hidden', !show);
    if (!show) return;
    const v = s.latestVersion ? ` v${s.latestVersion}` : '';
    btn.classList.remove('is-downloading', 'is-ready', 'is-error');
    let label = `更新${v}`;
    let title = `发现新版本${v}，点击${bridge ? '下载' : '前往下载'}`;
    if (s.status === 'downloading') {
      label = `下载中 ${s.percent || 0}%`;
      title = '正在下载新版本，点击查看详情';
      btn.classList.add('is-downloading');
    } else if (s.status === 'downloaded') {
      label = installing ? '正在安装…' : (isWin() ? `重启安装${v}` : `打开安装包${v}`);
      title = isWin() ? '新版本已下载，点击重启并覆盖安装' : `安装包已下载到 ${tildePath(s.downloadedFilePath)}，点击打开`;
      btn.classList.add('is-ready');
    } else if (s.status === 'error') {
      label = '更新失败 · 重试';
      title = s.error || '更新失败，点击查看原因';
      btn.classList.add('is-error');
    } else if (s.status === 'checking') {
      title = '正在检查更新…';
    }
    els.topLabel.textContent = label;
    btn.title = title;
    btn.disabled = installing;
  }

  function onTopButtonClick() {
    const s = state;
    if (!s) return;
    if (s.status === 'downloaded') return install();
    if (s.status === 'downloading' || s.status === 'error') return openAboutSettings();
    if (bridge && isWin() && !s.autoInstallSupported) return openAboutSettings();
    return download();
  }

  function renderCheckButton() {
    if (els.versionTag && state && state.currentVersion) els.versionTag.textContent = `CSM v${state.currentVersion}`;
    if (els.appTitle && state && state.currentVersion) els.appTitle.title = `CSM v${state.currentVersion}`;
    if (!els.checkBtn) return;
    const checking = state && state.status === 'checking';
    els.checkBtn.disabled = !!checking || (state && state.status === 'downloading') || installing;
    if (els.checkLabel) els.checkLabel.textContent = checking ? '检查中…' : '检查更新';
    if (els.checkDot) els.checkDot.classList.toggle('hidden', !(state && state.hasUpdate));
  }

  function primary(text, onclick, extraClass = '') {
    return el('button', { type: 'button', class: `update-action-primary ${extraClass}`.trim(), text, onclick });
  }
  function secondary(text, onclick) {
    return el('button', { type: 'button', class: 'btn-text-action', text, onclick });
  }

  function versionHeader(s) {
    const date = fmtDate(s.publishedAt);
    return el('div', { class: 'update-panel-head' }, [
      el('strong', { text: s.status === 'downloaded' ? `新版本 v${s.latestVersion} 已下载` : `发现新版本 v${s.latestVersion}` }),
      date ? el('span', { class: 'update-panel-date', text: `发布于 ${date}` }) : null,
      el('a', { href: '#', class: 'update-panel-link', text: '在 GitHub 查看 ↗', onclick: e => { e.preventDefault(); openRelease(); } })
    ]);
  }

  function notesBlock(s) {
    const notes = String(s.notes || '').trim();
    if (!notes) return null;
    return el('div', { class: 'update-notes', text: notes });
  }

  function renderPanel() {
    const panel = els.panel;
    if (!panel) return;
    const s = state;
    panel.replaceChildren();
    if (!s) { panel.classList.add('hidden'); return; }

    // 后台静默检测失败（且不知道有新版本）时不打扰，手动检查过才展示
    const show = ['available', 'downloading', 'downloaded'].includes(s.status)
      || (s.status === 'error' && (manualChecked || s.hasUpdate))
      || (s.status === 'up-to-date' && manualChecked);
    panel.classList.toggle('hidden', !show);
    if (!show) return;
    panel.dataset.status = s.status;

    if (s.status === 'up-to-date') {
      panel.append(el('div', { class: 'update-ok' }, [
        el('span', { text: `✓ 当前已是最新版本（v${s.currentVersion}）` }),
        s.checkedAt ? el('span', { class: 'update-panel-date', text: `上次检查 ${fmtTime(s.checkedAt)}` }) : null
      ]));
      return;
    }

    if (s.status === 'available') {
      panel.append(versionHeader(s));
      const n = notesBlock(s);
      if (n) panel.append(n);
      const actions = el('div', { class: 'update-actions' });
      if (!bridge) {
        actions.append(primary('前往下载 ↗', download));
      } else if (isWin() && s.autoInstallSupported) {
        actions.append(primary('下载更新', download));
      } else if (isWin()) {
        actions.append(el('span', { class: 'update-hint', text: '开发模式请使用安装包' }), secondary('前往 GitHub 下载 ↗', openRelease));
      } else if (isMac()) {
        actions.append(primary('下载安装包 (.dmg)', download));
      } else {
        actions.append(secondary('前往 GitHub 下载 ↗', openRelease));
      }
      panel.append(actions);
      return;
    }

    if (s.status === 'downloading') {
      panel.append(el('div', { class: 'update-panel-head' }, [el('strong', { text: `正在下载 v${s.latestVersion || ''}` })]));
      const bar = el('div', { class: 'update-progress' }, [el('div', { class: 'update-progress-bar' })]);
      bar.firstChild.style.width = `${Math.max(0, Math.min(100, s.percent || 0))}%`;
      const detail = s.totalBytes > 0
        ? `${s.percent || 0}% · ${fmtBytes(s.receivedBytes)} / ${fmtBytes(s.totalBytes)}`
        : `${s.percent || 0}%${s.receivedBytes ? ` · ${fmtBytes(s.receivedBytes)}` : ''}`;
      panel.append(bar, el('div', { class: 'update-progress-text', text: detail }));
      return;
    }

    if (s.status === 'downloaded') {
      panel.append(versionHeader(s));
      const actions = el('div', { class: 'update-actions' });
      if (isWin()) {
        actions.append(primary(installing ? '正在退出并安装…' : '重启并覆盖安装', install));
        if (installing) actions.firstChild.disabled = true;
      } else {
        panel.append(el('div', { class: 'update-hint', text: `已下载至 ${tildePath(s.downloadedFilePath)}，打开后将 CSM 拖入「应用程序」覆盖即可` }));
        actions.append(primary('打开安装包', install), secondary('在访达中显示', reveal));
      }
      panel.append(actions);
      return;
    }

    // error
    const box = el('div', { class: 'update-error' }, [
      el('strong', { text: s.hasUpdate && s.latestVersion ? `更新到 v${s.latestVersion} 失败` : '检查更新失败' }),
      el('div', { class: 'update-error-msg', text: s.error || '未知错误' })
    ]);
    const hint = ERROR_HINTS[s.errorKind];
    if (hint) box.append(el('div', { class: 'update-error-hint', text: hint }));
    panel.append(box);
    const actions = el('div', { class: 'update-actions' });
    const canRetryDownload = bridge && s.hasUpdate && s.errorKind !== 'unsupported';
    actions.append(
      primary('重试', () => (canRetryDownload ? download() : check())),
      secondary('在 GitHub 下载 ↗', openRelease)
    );
    panel.append(actions);
  }

  function render() {
    renderTopButton();
    renderCheckButton();
    renderPanel();
  }

  // ---------- 初始化 ----------
  if (els.topBtn) els.topBtn.addEventListener('click', onTopButtonClick);
  if (els.checkBtn) els.checkBtn.addEventListener('click', check);

  if (bridge) {
    bridge.onStateChange(setState);
    bridge.getState().then(setState).catch(() => {});
  } else {
    apiCheck(false);
    setInterval(() => apiCheck(false), 6 * 60 * 60 * 1000);
  }

  window.CSMUpdater = { check, download, getState: () => state };
})();
