// 配置表清单（filelist.json）：列表预览；新增 / 编辑 / 云端目录映射各用独立弹窗，确认后直接写回并刷新列表
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = {
    open: $('btn-filelist'),
    manage: $('btn-manage-filelist'),
    // 列表
    modal: $('fl-modal'),
    close: $('fl-close'),
    file: $('fl-file'),
    root: $('fl-root'),
    rootEdit: $('fl-root-edit'),
    filter: $('fl-filter'),
    filterClear: $('fl-filter-clear'),
    tabAll: $('fl-tab-all'),
    tabCloud: $('fl-tab-cloud'),
    tabLocal: $('fl-tab-local'),
    count: $('fl-count'),
    flash: $('fl-flash'),
    add: $('fl-add'),
    tbody: $('fl-tbody'),
    // 新增 / 编辑
    edit: $('fl-edit-modal'),
    editClose: $('fl-edit-close'),
    formTitle: $('fl-form-title'),
    link: $('fl-link'),
    resolve: $('fl-resolve'),
    cloud: $('fl-cloud'),
    name: $('fl-name'),
    path: $('fl-path'),
    base: $('fl-base'),
    desc: $('fl-desc'),
    id: $('fl-id'),
    dirs: $('fl-dirs'),
    msg: $('fl-msg'),
    cancel: $('fl-cancel'),
    save: $('fl-save'),
    // 映射
    rootModal: $('fl-root-modal'),
    rootClose: $('fl-root-close'),
    rootFolder: $('fl-root-folder'),
    rootLocal: $('fl-root-local'),
    rootBase: $('fl-root-base'),
    rootMsg: $('fl-root-msg'),
    rootClear: $('fl-root-clear'),
    rootCancel: $('fl-root-cancel'),
    rootSave: $('fl-root-save'),
    // 上传本地表
    up: $('fl-up-modal'),
    upClose: $('fl-up-close'),
    upLocal: $('fl-up-local'),
    upMeta: $('fl-up-meta'),
    upDir: $('fl-up-dir'),
    upDirTip: $('fl-up-dir-tip'),
    upCloudName: $('fl-up-cloudname'),
    upName: $('fl-up-name'),
    upDesc: $('fl-up-desc'),
    upMsg: $('fl-up-msg'),
    upCancel: $('fl-up-cancel'),
    upSave: $('fl-up-save')
  };

  let entries = [];
  let localTables = [];   // 本地目录下、未加入清单的 xlsx
  let currentTab = 'all'; // 'all' | 'cloud' | 'local'
  const rowBusy = new Map(); // path -> 进行中的操作文案（下载中 / 上传中）
  let cloudQuerying = false; // 正在为缺少云端位置的条目查询
  let cloudFailed = {};      // { [spreadsheetId]: 错误信息 }
  let localRoot = 'Datas';
  const collapsed = { cloud: false, local: false };
  let uploading = null;   // 正在上传弹窗里的本地表
  let batchRunning = false;
  let baseLabel = '';
  let rootInfo = null;    // { root, configured }
  let editingPath = null; // null = 新增；否则为正在编辑条目的原路径
  let resolveSeq = 0;     // 只采用最后一次解析的结果
  let lastResolvedId = '';

  const api = p => window.CSM.api(p);
  const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function readJson(resp) {
    try { return await resp.json(); } catch (_) { return {}; }
  }

  function setText(node, text, kind, base) {
    node.textContent = text || '';
    node.className = `${base || 'fl-msg'}${kind ? ` ${kind}` : ''}`;
    if (text && node === el.flash && window.showToast) {
      window.showToast(text, kind === 'error' ? 'error' : kind === 'ok' ? 'success' : 'info');
    }
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return iso; }
  }

  const sheetUrl = id => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;

  function code(text) {
    const c = document.createElement('code');
    c.textContent = text;
    return c;
  }

  // ---------- 列表 ----------
  async function loadList(highlightPath) {
    if (!entries.length) el.tbody.innerHTML = '<tr><td colspan="6" class="fl-empty">加载中…</td></tr>';
    const resp = await fetch(api('/filelist'));
    const data = await readJson(resp);
    if (!resp.ok) {
      el.tbody.innerHTML = '';
      el.count.textContent = '';
      setText(el.flash, `读取清单失败：${data.error || resp.status}`, 'error');
      return;
    }
    entries = data.entries || [];
    localTables = (data.local && data.local.tables) || [];
    localRoot = (data.local && data.local.root) || 'Datas';
    baseLabel = data.baseLabel || '';
    el.file.textContent = data.filelist || '';
    el.dirs.innerHTML = '';
    (data.dirs || []).forEach(d => {
      const o = document.createElement('option');
      o.value = `${d}/`;
      el.dirs.appendChild(o);
    });
    renderList(highlightPath);
  }

  function groupRow(key, title, count, tip, ops) {
    const tr = document.createElement('tr');
    tr.className = `fl-group ${collapsed[key] ? 'is-collapsed' : ''}`;
    const c = document.createElement('td');
    c.colSpan = 6;

    const inner = document.createElement('div');
    inner.className = 'fl-group-inner';

    const left = document.createElement('div');
    left.className = 'fl-group-left';

    const caret = document.createElement('span');
    caret.className = 'fl-caret';
    caret.innerHTML = window.CSMIcons?.chevronDown || '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5.5 8l4.5 4.5 4.5-4.5"/></svg>';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'fl-group-icon';
    iconSpan.textContent = key === 'cloud' ? '☁️' : '💻';

    const t = document.createElement('span');
    t.className = 'fl-group-title';
    t.textContent = title;

    const countBadge = document.createElement('span');
    countBadge.className = 'fl-group-count';
    countBadge.textContent = count;

    const tipEl = document.createElement('span');
    tipEl.className = 'fl-group-tip';
    tipEl.textContent = tip || '';

    left.append(caret, iconSpan, t, countBadge, tipEl);
    inner.appendChild(left);

    if (ops) {
      const box = document.createElement('div');
      box.className = 'fl-group-ops';
      box.appendChild(ops);
      box.addEventListener('click', e => e.stopPropagation());
      inner.appendChild(box);
    }

    c.appendChild(inner);
    tr.appendChild(c);
    tr.addEventListener('click', () => { collapsed[key] = !collapsed[key]; renderList(); });
    return tr;
  }

  function emptyRow(text) {
    const tr = document.createElement('tr');
    const c = document.createElement('td');
    c.colSpan = 6;
    c.className = 'fl-empty';
    c.textContent = text;
    tr.appendChild(c);
    return tr;
  }

  function renderList(highlightPath) {
    const terms = window.TableSearch.parseQuery(el.filter.value);
    const match = list => (terms.length ? list.filter(e => window.TableSearch.matchRow(e, terms)) : list);
    const cloudShown = match(entries);
    const localShown = match(localTables);
    const total = entries.length + localTables.length;

    // Update tab badges
    if (el.tabAll) el.tabAll.textContent = total;
    if (el.tabCloud) el.tabCloud.textContent = entries.length;
    if (el.tabLocal) el.tabLocal.textContent = localTables.length;

    if (el.count) {
      el.count.textContent = terms.length
        ? `匹配 ${cloudShown.length + localShown.length} / 共 ${total} 项`
        : '';
    }

    el.tbody.innerHTML = '';
    let target = null;

    // 云端表：已在 filelist.json 中
    if (currentTab === 'all' || currentTab === 'cloud') {
      el.tbody.appendChild(groupRow('cloud', '云端已关联配置表', cloudShown.length, '已在 filelist.json 中，与云端 Google 表格保持关联'));
      if (!collapsed.cloud) {
        if (!cloudShown.length) el.tbody.appendChild(emptyRow(entries.length ? '没有匹配的云端配置表' : '清单是空的：可以上传下方的本地表，或点右上角「新增配置表」关联已有云端表'));
        for (const e of cloudShown) {
          const tr = renderRow(e);
          if (highlightPath && e.path === highlightPath) { tr.classList.add('fl-flash'); target = tr; }
          el.tbody.appendChild(tr);
        }
      }
    }

    // 本地表：本地目录下存在、但还没加入清单
    if (currentTab === 'all' || currentTab === 'local') {
      const batchBtn = document.createElement('button');
      batchBtn.type = 'button';
      batchBtn.className = 'fl-btn fl-btn-primary-tint fl-btn-sm';
      batchBtn.innerHTML = `${window.CSMIcons?.upload || '⬆'} <span>${terms.length ? `上传筛选出的 ${localShown.length} 张` : `全部上传并关联 (${localShown.length})`}</span>`;
      batchBtn.disabled = !localShown.length || batchRunning;
      batchBtn.addEventListener('click', () => uploadBatch(localShown));
      el.tbody.appendChild(groupRow('local', '本地未入库表格', localShown.length, `${baseLabel}${localRoot}/ 目录下未加入清单的 xlsx`, localTables.length ? batchBtn : null));
      if (!collapsed.local) {
        if (!localShown.length) el.tbody.appendChild(emptyRow(localTables.length ? '没有匹配的本地表格' : `${baseLabel}${localRoot}/ 下的 xlsx 都已在清单中`));
        for (const t of localShown) el.tbody.appendChild(renderLocalRow(t));
      }
    }
    if (target) target.scrollIntoView({ block: 'center' });
  }

  // 本地路径 → 云端目标目录（按映射镜像相对目录）；没有映射时返回 null
  function cloudTargetOf(localPath) {
    const r = rootInfo && rootInfo.root;
    if (!r || r.error) return null;
    const parts = String(localPath).split('/').filter(Boolean);
    const rootParts = String(r.localRoot || '').split('/').filter(Boolean);
    if (parts.length <= rootParts.length) return null;
    for (let i = 0; i < rootParts.length; i++) if (parts[i].toLowerCase() !== rootParts[i].toLowerCase()) return { outside: true };
    return { dir: [r.rootPath, ...parts.slice(rootParts.length, -1)].join(' / ') };
  }

  function renderLocalRow(t) {
    const tr = document.createElement('tr');
    tr.className = 'fl-row fl-row-local';
    
    // 表名
    const nameTd = document.createElement('td');
    nameTd.className = 'fl-col-name';
    nameTd.innerHTML = `<span class="fl-name-strong">${escapeHtml(t.name)}</span>`;
    tr.appendChild(nameTd);

    // 本地路径
    tr.appendChild(localPathCell(t.path, true));

    // 云端目标位置
    const target = cloudTargetOf(t.path);
    let tc;
    if (!rootInfo) {
      tc = td('正在识别云端目录…', 'fl-muted');
    } else if (!target) {
      tc = document.createElement('td');
      tc.className = 'fl-col-cloud';
      tc.innerHTML = '<span class="fl-status-pill status-warn"><span class="dot"></span>未设置目录映射</span>';
    } else if (target.outside) {
      tc = document.createElement('td');
      tc.className = 'fl-col-cloud';
      tc.innerHTML = '<span class="fl-status-pill status-warn"><span class="dot"></span>不在映射目录下</span>';
    } else {
      // 上传后的云端位置（相对映射根目录）
      const dirs = target.dir.split(' / ');
      const rel = [...(stripPrefix(dirs, cloudRootParts()) || dirs), t.name];
      tc = document.createElement('td');
      tc.className = 'fl-col-cloud';
      const targetPill = document.createElement('div');
      targetPill.className = 'fl-target-pill';
      targetPill.title = `上传后放到：${target.dir} / ${t.name}（缺少的文件夹会自动创建）`;
      targetPill.innerHTML = `<span class="fl-target-arrow">→</span><span class="fl-target-path font-mono">${escapeHtml(rel.join(' / '))}</span>`;
      tc.appendChild(targetPill);
    }
    tr.appendChild(tc);

    // 备注
    const descTd = document.createElement('td');
    descTd.className = 'fl-col-desc';
    descTd.innerHTML = '<span class="fl-desc-empty">—</span>';
    tr.appendChild(descTd);

    // 本地文件状态
    const statusTd = document.createElement('td');
    statusTd.className = 'fl-col-status';
    statusTd.innerHTML = `<span class="fl-status-pill status-unuploaded"><span class="dot"></span>未入库 · ${fmtSize(t.size)}</span>`;
    statusTd.title = `本地修改时间：${fmtTime(t.mtime)}`;
    tr.appendChild(statusTd);

    // 操作
    const ops = document.createElement('td');
    ops.className = 'fl-col-ops';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'fl-action-btn fl-btn-primary';
    up.innerHTML = `${window.CSMIcons?.upload || '⬆'} <span>上传到云端</span>`;
    up.title = '在云端对应目录新建 Google 表格并加入清单';
    up.disabled = batchRunning;
    up.addEventListener('click', () => openUpload(t));
    ops.appendChild(up);
    tr.appendChild(ops);
    tr.addEventListener('dblclick', () => openUpload(t));
    return tr;
  }

  // ---------- 上传本地表 ----------
  function openUpload(t) {
    if (batchRunning) return;
    uploading = t;
    const target = cloudTargetOf(t.path);
    el.upLocal.textContent = `${baseLabel}${t.path}`;
    el.upMeta.textContent = `${fmtSize(t.size)} · ${fmtTime(t.mtime)}`;
    el.upDir.textContent = target && target.dir ? target.dir : '—';
    el.upDirTip.textContent = target && target.dir ? '（与本地相对目录一致，缺的文件夹自动创建）' : '';
    el.upCloudName.value = t.name;
    el.upName.value = t.name;
    el.upDesc.value = '';
    setText(el.upMsg, !rootInfo ? '正在识别云端目录…'
      : !target ? '还没有云端目录映射，请先在清单顶部「设置映射」'
      : target.outside ? `该文件不在映射的本地目录下，无法对应云端目录` : '', target && target.dir ? '' : 'error');
    el.upSave.disabled = !(target && target.dir);
    el.up.classList.remove('hidden');
    el.upCloudName.focus();
    el.upCloudName.select();
  }

  function closeUpload() {
    el.up.classList.add('hidden');
    uploading = null;
  }

  async function postUpload(body) {
    const resp = await fetch(api('/filelist/upload-local'), { method: 'POST', ...json(body) });
    return { resp, data: await readJson(resp) };
  }

  function uploadErrorText(resp, data) {
    if (resp.status === 401) return '需要先完成 Google 授权';
    if (data.error === 'NEED_UPLOAD_SCOPE') return '当前授权只有只读权限，请关闭弹窗后在主界面重新授权（/auth/start）';
    return data.error || `上传失败（${resp.status}）`;
  }

  function logUploaded(data) {
    const folders = data.createdFolders && data.createdFolders.length ? `，新建云端文件夹 ${data.createdFolders.join(' / ')}` : '';
    window.CSM.appendLog(data.linked
      ? `🔗 已关联云端已有表：${data.entry.path} ↔ ${data.cloudDir} / ${data.cloud.name}\n`
      : `⬆ 已上传本地表：${data.entry.path} → ${data.cloudDir} / ${data.cloud.name}${folders}\n`);
  }

  async function saveUpload(onExisting) {
    const t = uploading;
    if (!t) return;
    el.upSave.disabled = true;
    setText(el.upMsg, '上传中…（xlsx 较大时需要十几秒）');
    try {
      const { resp, data } = await postUpload({
        path: t.path,
        cloudName: el.upCloudName.value.trim(),
        name: el.upName.value.trim(),
        description: el.upDesc.value.trim(),
        onExisting: onExisting || 'ask'
      });
      if (resp.status === 409 && data.code === 'CLOUD_EXISTS') {
        setText(el.upMsg, '');
        const ok = confirm(`${data.error}\n\n确定：直接关联这张已有的云端表（不上传、不覆盖它）\n取消：返回，可修改云端表名后再上传`);
        if (ok) return saveUpload('link');
        el.upCloudName.focus();
        return;
      }
      if (!resp.ok) { setText(el.upMsg, uploadErrorText(resp, data), 'error'); return; }
      logUploaded(data);
      closeUpload();
      el.filter.value = '';
      await loadList(data.entry.path);
      setText(el.flash, data.linked ? `已关联：${data.entry.path}` : `已上传并加入清单：${data.entry.path}`, 'ok');
      window.CSM.reloadTables();
    } catch (err) {
      setText(el.upMsg, err.message, 'error');
    } finally {
      el.upSave.disabled = false;
    }
  }

  // 批量上传：逐张进行；云端同目录已有同名表时直接关联，不重复创建
  async function uploadBatch(list) {
    if (!list.length || batchRunning) return;
    const r = rootInfo && rootInfo.root;
    if (!r || r.error) { setText(el.flash, '还没有云端目录映射，请先「设置映射」', 'error'); return; }
    const ok = confirm(`上传 ${list.length} 张本地表到云端 ${r.rootPath}（按本地相对目录放置，缺的文件夹自动创建），并加入清单？\n\n云端同目录已有同名表的，会直接关联已有表、不重复创建。`);
    if (!ok) return;
    batchRunning = true;
    renderList();
    let done = 0;
    let linked = 0;
    const failed = [];
    window.CSM.appendLog(`\n===== 批量上传本地表（${list.length}）=====\n`);
    for (const t of list) {
      setText(el.flash, `上传中 ${done + failed.length + 1}/${list.length}：${t.path}`);
      try {
        const { resp, data } = await postUpload({ path: t.path, onExisting: 'link' });
        if (!resp.ok) {
          failed.push(t.path);
          window.CSM.appendLog(`✗ ${t.path}：${uploadErrorText(resp, data)}\n`);
          if (resp.status === 401 || resp.status === 403 || data.code === 'NO_ROOT') break; // 后面的也会同样失败
          continue;
        }
        done++;
        if (data.linked) linked++;
        logUploaded(data);
      } catch (err) {
        failed.push(t.path);
        window.CSM.appendLog(`✗ ${t.path}：${err.message}\n`);
      }
    }
    batchRunning = false;
    await loadList();
    const summary = `批量上传完成：成功 ${done}${linked ? `（其中关联已有表 ${linked}）` : ''}${failed.length ? `，失败 ${failed.length}（详见日志）` : ''}`;
    setText(el.flash, summary, failed.length ? 'error' : 'ok');
    window.CSM.appendLog(`${summary}\n`);
    window.CSM.reloadTables();
  }

  // ---------- 路径显示：去掉映射目录段，只显示相对部分 ----------
  const lower = x => String(x).toLowerCase();
  function stripPrefix(parts, prefix) {
    if (!prefix.length || parts.length < prefix.length) return null;
    return prefix.every((p, i) => lower(parts[i]) === lower(p)) ? parts.slice(prefix.length) : null;
  }
  const localRootParts = () => String((rootInfo && rootInfo.root && !rootInfo.root.error && rootInfo.root.localRoot) || localRoot || '').split('/').filter(Boolean);
  const cloudRootParts = () => (rootInfo && rootInfo.root && !rootInfo.root.error ? String(rootInfo.root.rootPath).split(' / ') : guessCloudRoot());

  // 映射还没识别出来时（App 刚启动），用清单里已记录的 cloudDir 本地推算云端根目录，让显示立即正确：
  // 每条的云端目录去掉与本地子目录相同的尾部，剩下的就是根目录，取出现最多的那个
  let guessCache = null;
  function guessCloudRoot() {
    if (guessCache && guessCache.entries === entries) return guessCache.parts;
    const votes = new Map();
    const lr = String(localRoot || '').split('/').filter(Boolean);
    for (const e of entries) {
      if (!e.cloudDir) continue;
      const dirs = e.cloudDir.split('/').filter(Boolean);
      const local = (stripPrefix(String(e.path).split('/').filter(Boolean), lr) || []).slice(0, -1);
      let k = 0;
      while (k < local.length && k < dirs.length && lower(local[local.length - 1 - k]) === lower(dirs[dirs.length - 1 - k])) k++;
      const key = dirs.slice(0, dirs.length - k).join('/');
      votes.set(key, (votes.get(key) || 0) + 1);
    }
    let best = '';
    let max = 0;
    for (const [key, n] of votes) if (n > max) { best = key; max = n; }
    guessCache = { entries, parts: best ? best.split('/') : [] };
    return guessCache.parts;
  }

  // 本地路径相对映射目录：Datas/Item/Global.xlsx → Item/Global.xlsx
  function relLocalParts(p) {
    const parts = String(p).split('/').filter(Boolean);
    return stripPrefix(parts, localRootParts()) || parts;
  }

  // 云端位置相对映射根目录：MX11/Data/Item + Global → Item / Global
  function relCloudDirs(e) {
    const dirs = String(e.cloudDir || '').split('/').filter(Boolean);
    return stripPrefix(dirs, cloudRootParts()) || dirs;
  }

  // 只在分隔符处换行，避免把单词从中间截断
  function pathCell(parts, sep, cls, title) {
    const c = document.createElement('td');
    c.className = cls;
    parts.forEach((p, i) => {
      c.appendChild(document.createTextNode(i < parts.length - 1 ? `${p}${sep}` : p));
      if (i < parts.length - 1) c.appendChild(document.createElement('wbr'));
    });
    if (title) c.title = title;
    return c;
  }

  // 本地路径单元格：点击在访达中显示文件（不存在则打开所在目录）
  function localPathCell(relPath, exists) {
    const c = document.createElement('td');
    c.className = 'fl-col-path';
    const pill = document.createElement('div');
    pill.className = `fl-path-pill ${exists ? 'exists' : 'missing'}`;
    pill.title = `${exists ? '在访达中显示' : '本地暂无该文件，点击打开所在目录'}\n${baseLabel}${relPath}`;

    const icon = document.createElement('span');
    icon.className = 'fl-path-icon';
    icon.innerHTML = window.CSMIcons?.file || '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3a1.5 1.5 0 0 1 1.5-1.5h6l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 17V3z"/><path d="M11.5 1.5v4.5h4.5"/></svg>';

    const pathText = document.createElement('span');
    pathText.className = 'fl-path-text font-mono';
    const parts = relLocalParts(relPath);
    parts.forEach((p, i) => {
      pathText.appendChild(document.createTextNode(i < parts.length - 1 ? `${p}/` : p));
      if (i < parts.length - 1) pathText.appendChild(document.createElement('wbr'));
    });

    pill.append(icon, pathText);
    pill.addEventListener('click', ev => { ev.stopPropagation(); revealLocal(relPath); });
    pill.addEventListener('dblclick', ev => ev.stopPropagation());
    c.appendChild(pill);
    return c;
  }

  async function revealLocal(relPath) {
    const data = await window.CSM.revealLocal(relPath);
    if (data && !data.exact) setText(el.flash, `本地还没有 ${relPath}，已打开所在目录`);
  }

  function cloudPathCell(e) {
    const c = document.createElement('td');
    c.className = 'fl-col-cloud';
    if (!e.spreadsheetId) {
      c.innerHTML = '<span class="fl-status-pill status-error"><span class="dot"></span>缺少 ID</span>';
      return c;
    }
    const linkWrap = document.createElement('div');
    linkWrap.className = 'fl-cloud-wrap';

    const a = document.createElement('a');
    a.href = sheetUrl(e.spreadsheetId);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'fl-sheet-link';

    const icon = document.createElement('span');
    icon.className = 'fl-sheet-icon';
    icon.innerHTML = window.CSMIcons?.sheet || '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3a1.5 1.5 0 0 1 1.5-1.5h6l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 17V3z"/><path d="M11.5 1.5v4.5h4.5M7 9.5h6M7 13h6"/></svg>';

    const titleWrap = document.createElement('span');
    titleWrap.className = 'fl-sheet-title';

    if (e.cloudDir && e.cloudFile) {
      const parts = [...relCloudDirs(e), e.cloudFile];
      parts.forEach((p, i) => {
        titleWrap.appendChild(document.createTextNode(i < parts.length - 1 ? `${p} / ` : p));
        if (i < parts.length - 1) titleWrap.appendChild(document.createElement('wbr'));
      });
      a.title = `${e.cloudDir.split('/').join(' / ')} / ${e.cloudFile}\n${e.spreadsheetId}\n点击在浏览器中打开云端 Google 表格`;

      const ext = document.createElement('span');
      ext.className = 'fl-ext-arrow';
      ext.textContent = '↗';
      a.append(icon, titleWrap, ext);
      linkWrap.appendChild(a);

      // 云端子目录与本地子目录不一致时提示
      const cloudSub = relCloudDirs(e).join('/');
      const localUnder = stripPrefix(String(e.path).split('/').filter(Boolean), localRootParts());
      const localSub = localUnder ? localUnder.slice(0, -1).join('/') : null;
      // 本地不在映射目录下（如 DDatas/...）的不比较
      if (localSub !== null && cloudRootParts().length && lower(cloudSub) !== lower(localSub)) {
        const w = document.createElement('span');
        w.className = 'fl-path-warn-pill';
        w.textContent = '⚠️ 路径不一致';
        w.title = `云端目录与本地相对目录不一致\n云端：${cloudSub || '（根目录）'}\n本地：${localSub || '（根目录）'}`;
        linkWrap.appendChild(w);
      }
    } else if (cloudFailed[e.spreadsheetId]) {
      a.innerHTML = `<span class="fl-sheet-fail">⚠ ${escapeHtml(cloudFailed[e.spreadsheetId])}</span>`;
      a.className = 'fl-sheet-link fl-bad';
      a.title = `${e.spreadsheetId}\n点击打开云端表`;
      linkWrap.appendChild(a);
    } else {
      a.innerHTML = `<span class="fl-sheet-muted">${cloudQuerying ? '查询中…' : '未记录云端位置'}</span>`;
      a.className = 'fl-sheet-link fl-muted';
      a.title = `${e.spreadsheetId}\n点击打开云端表`;
      linkWrap.appendChild(a);
    }

    if (e.sync && e.sync.cloudModifiedBy) {
      const modPill = document.createElement('span');
      modPill.className = 'fl-modifier-pill';
      modPill.textContent = `👤 ${e.sync.cloudModifiedBy}`;
      modPill.title = `最后修改人：${e.sync.cloudModifiedBy}\n云端时间：${e.sync.cloudModifiedTime ? new Date(e.sync.cloudModifiedTime).toLocaleString('zh-CN') : '—'}`;
      linkWrap.appendChild(modPill);
    }

    c.appendChild(linkWrap);
    return c;
  }

  // 只为还没有云端位置的条目查询（all=true 时全部重查），结果由服务端写回 filelist.json
  async function syncCloudPaths(all) {
    const missing = entries.filter(e => e.spreadsheetId && (!e.cloudDir || !e.cloudFile));
    if (!all && !missing.length) return;
    cloudQuerying = true;
    cloudFailed = {};
    renderList();
    if (all) setText(el.flash, '正在重新查询全部云端路径…');
    try {
      const resp = await fetch(api('/filelist/cloud-paths'), { method: 'POST', ...json({ all: !!all }) });
      const data = await readJson(resp);
      cloudQuerying = false;
      if (!resp.ok) {
        setText(el.flash, resp.status === 401 ? '需要先完成 Google 授权才能查询云端路径' : `查询云端路径失败：${data.error || resp.status}`, 'error');
        renderList();
        return;
      }
      cloudFailed = data.failed || {};
      await loadList();
      const nFail = Object.keys(cloudFailed).length;
      if (data.updated || nFail || all) {
        setText(el.flash, `云端路径已写入清单：更新 ${data.updated} 条${nFail ? `，${nFail} 条查询失败` : ''}`, nFail ? 'error' : 'ok');
        if (data.updated) window.CSM.appendLog(`✎ 已把 ${data.updated} 条云端路径写入 filelist.json（cloudDir / cloudFile）\n`);
      }
    } catch (err) {
      cloudQuerying = false;
      setText(el.flash, `查询云端路径失败：${err.message}`, 'error');
      renderList();
    }
  }

  function td(text, cls) {
    const c = document.createElement('td');
    if (cls) c.className = cls;
    c.textContent = text == null ? '' : String(text);
    return c;
  }

  // ---------- 本地 ↔ 云端同步 ----------
  function timesText(e) {
    const cloud = e.sync && e.sync.cloudModifiedTime;
    const by = e.sync && e.sync.cloudModifiedBy ? `（${e.sync.cloudModifiedBy}）` : '';
    return `云端修改：${cloud ? fmtTime(cloud) : '—'}${by}\n本地修改：${e.local ? fmtTime(e.local.mtime) : '本地没有文件'}`;
  }

  // 「本地文件」列：微状态胶囊徽标
  function syncStateCell(e) {
    const c = document.createElement('td');
    c.className = 'fl-col-status';
    const dir = e.sync && e.sync.direction;
    let pillClass = '';
    let text = '';
    if (!e.local) {
      pillClass = 'status-missing';
      text = '未下载';
    } else if (dir === 'download') {
      pillClass = 'status-cloud';
      text = `云端较新 · ${fmtSize(e.local.size)}`;
    } else if (dir === 'upload') {
      pillClass = 'status-local';
      text = `本地较新 · ${fmtSize(e.local.size)}`;
    } else if (dir === 'conflict') {
      pillClass = 'status-conflict';
      text = `⚠️ 冲突 · ${fmtSize(e.local.size)}`;
    } else if (e.sync && e.sync.status === 'synced') {
      pillClass = 'status-synced';
      text = `✓ 已同步 · ${fmtSize(e.local.size)}`;
    } else {
      pillClass = 'status-synced';
      text = `✓ ${fmtSize(e.local.size)}`;
    }
    c.innerHTML = `<span class="fl-status-pill ${pillClass}"><span class="dot"></span>${escapeHtml(text)}</span>`;
    c.title = timesText(e);
    return c;
  }

  function renderRow(e) {
    const tr = document.createElement('tr');
    tr.className = 'fl-row';

    // 表名
    const nameTd = document.createElement('td');
    nameTd.className = 'fl-col-name';
    nameTd.innerHTML = `<span class="fl-name-strong">${escapeHtml(e.name)}</span>`;
    tr.appendChild(nameTd);

    // 本地路径
    tr.appendChild(localPathCell(e.path, !!e.local));

    // 云端路径
    tr.appendChild(cloudPathCell(e));

    // 备注
    const descTd = document.createElement('td');
    descTd.className = 'fl-col-desc';
    descTd.innerHTML = e.description
      ? `<span class="fl-desc-text" title="${escapeHtml(e.description)}">${escapeHtml(e.description)}</span>`
      : '<span class="fl-desc-empty">—</span>';
    tr.appendChild(descTd);

    // 本地文件同步状态
    tr.appendChild(syncStateCell(e));

    // 操作按钮组
    const ops = document.createElement('td');
    ops.className = 'fl-col-ops';
    const busy = rowBusy.get(e.path);
    const dir = e.sync && e.sync.direction;

    const group = document.createElement('div');
    group.className = 'fl-actions-group';

    if (busy) {
      const b = document.createElement('span');
      b.className = 'fl-busy-pill';
      b.textContent = busy;
      group.appendChild(b);
    } else if (dir) {
      const sb = document.createElement('button');
      sb.type = 'button';
      sb.className = `fl-action-btn fl-sync-btn ${dir === 'download' ? 'btn-dl' : dir === 'conflict' ? 'btn-cf' : 'btn-ul'}`;
      sb.innerHTML = dir === 'download'
        ? `${window.CSMIcons?.download || '⬇'} <span>下载</span>`
        : dir === 'conflict'
          ? `${window.CSMIcons?.alert || '⚠'} <span>解决冲突</span>`
          : `${window.CSMIcons?.upload || '⬆'} <span>上传</span>`;
      sb.title = `${dir === 'download' ? '用云端表覆盖本地 xlsx（覆盖前自动备份）' : dir === 'conflict' ? '两边都改过：查看差异后选择保留哪一边' : '先预览差异，确认后用本地 xlsx 覆盖云端表'}\n${timesText(e)}`;
      sb.addEventListener('click', () => (dir === 'download' ? downloadEntry(e) : resolveViaDiff(e, dir)));
      group.appendChild(sb);
    }

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'fl-action-btn fl-btn-ghost';
    edit.innerHTML = `${window.CSMIcons?.edit || '✏️'} <span>编辑</span>`;
    edit.title = '编辑配置表信息';
    edit.disabled = !!busy;
    edit.addEventListener('click', () => openEditor(e));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fl-action-btn fl-btn-danger';
    del.innerHTML = `${window.CSMIcons?.trash || '🗑'} <span>删除</span>`;
    del.title = '从清单移除（保留本地与云端文件）';
    del.disabled = !!busy;
    del.addEventListener('click', () => removeEntry(e));

    group.append(edit, del);
    ops.appendChild(group);
    tr.appendChild(ops);
    tr.addEventListener('dblclick', () => openEditor(e));
    return tr;
  }

  function setRowBusy(path, label) {
    if (label) rowBusy.set(path, label); else rowBusy.delete(path);
    renderList();
  }

  // 复用主列表的下载流程（覆盖前自动备份本地文件、下载后按偏好执行动作）
  async function downloadEntry(e) {
    if (e.local && !confirm(`用云端表覆盖本地「${e.name}」？\n\n${e.path}\n${timesText(e)}\n\n本地文件会先自动备份（主列表该行的 🕘 可恢复）。`)) return;
    setRowBusy(e.path, '下载中…');
    window.CSM.appendLog(`→ 下载 ${e.name}（${e.path}）\n`);
    try {
      const summary = await window.CSM.downloadPaths([e.path]);
      if (summary && summary.successCount) setText(el.flash, `已下载：${e.path}`, 'ok');
      else setText(el.flash, '下载失败，详情见主界面日志', 'error');
    } catch (err) {
      setText(el.flash, `下载失败：${err.message}`, 'error');
    } finally {
      rowBusy.delete(e.path);
      await loadList(e.path);
    }
  }

  // 上传 / 冲突：走差异预览，看过差异再决定（上传会带上预览时的云端版本做冲突检测）
  async function resolveViaDiff(e, dir) {
    const result = await window.CSM.openDiff(e.path, dir === 'conflict' ? 'conflict' : 'upload');
    if (result) setText(el.flash, result === 'uploaded' ? `已上传：${e.path}` : `已下载：${e.path}`, 'ok');
    await loadList(e.path);
  }

  // ---------- 云端目录映射 ----------
  function renderRoot() {
    el.root.innerHTML = '';
    if (!rootInfo) {
      el.root.innerHTML = '<div class="fl-root-loading"><span class="fl-spinner"></span> 正在识别云端目录…</div>';
      return;
    }
    if (rootInfo.error) {
      el.root.innerHTML = `<div class="fl-root-error">⚠ ${escapeHtml(rootInfo.error)}</div>`;
      return;
    }
    const r = rootInfo.root;
    if (!r) {
      el.root.innerHTML = `
        <div class="fl-root-empty">
          <span class="fl-root-warn-badge">未设置映射</span>
          <span class="fl-root-sub">清单为空无法推断 —— 新表将按云端所属文件夹自动存放至 <code>${escapeHtml(baseLabel)}Datas/&lt;文件夹名&gt;/</code></span>
        </div>
      `;
      return;
    }
    if (r.error) {
      el.root.innerHTML = `<div class="fl-root-error">⚠ ${escapeHtml(r.error)}</div>`;
      return;
    }

    const isConfig = r.source === 'config';
    const tagText = isConfig ? '项目专属配置' : `自动推断 (${r.votes}/${r.sampled} 一致)`;
    const tagClass = isConfig ? 'badge-config' : 'badge-inferred';

    el.root.innerHTML = `
      <div class="fl-map-pathway">
        <div class="fl-map-node cloud" title="云端根目录：${escapeHtml(r.rootPath)}">
          <span class="fl-map-icon">☁️</span>
          <span class="fl-map-tag">云端根目录</span>
          <span class="fl-map-val">${escapeHtml(r.rootPath)}</span>
        </div>
        <div class="fl-map-connector">⇄</div>
        <div class="fl-map-node local" title="本地映射目录：${escapeHtml(baseLabel + (r.localRoot ? r.localRoot + '/' : ''))}">
          <span class="fl-map-icon">💻</span>
          <span class="fl-map-tag">本地映射</span>
          <span class="fl-map-val">${escapeHtml(baseLabel + (r.localRoot ? r.localRoot + '/' : ''))}</span>
        </div>
        <span class="fl-map-status ${tagClass}">${tagText}</span>
      </div>
    `;
  }

  async function loadRoot() {
    rootInfo = null;
    renderRoot();
    const resp = await fetch(api('/filelist/cloud-root'));
    const data = await readJson(resp);
    if (resp.status === 401) rootInfo = { error: '需要先完成 Google 授权才能识别云端目录' };
    else if (!resp.ok) rootInfo = { error: `识别云端目录失败：${data.error || resp.status}` };
    else rootInfo = data;
    renderRoot();
    renderList();
  }

  function openRootEditor() {
    const conf = rootInfo && rootInfo.configured;
    const r = rootInfo && rootInfo.root;
    el.rootFolder.value = conf ? conf.folderId : (r && r.rootId) || '';
    el.rootLocal.value = conf ? conf.local : (r && r.localRoot != null ? r.localRoot : 'Datas');
    el.rootBase.textContent = baseLabel;
    el.rootClear.classList.toggle('hidden', !conf);
    setText(el.rootMsg, r && r.source === 'inferred' ? '已填入自动推断的结果，确认无误可直接保存' : '');
    el.rootModal.classList.remove('hidden');
    el.rootFolder.focus();
  }

  async function saveRoot() {
    el.rootSave.disabled = true;
    setText(el.rootMsg, '保存中…');
    try {
      const resp = await fetch(api('/filelist/cloud-root'), { method: 'PUT', ...json({ folder: el.rootFolder.value, local: el.rootLocal.value }) });
      const data = await readJson(resp);
      if (!resp.ok) { setText(el.rootMsg, data.error || `保存失败（${resp.status}）`, 'error'); return; }
      rootInfo = data;
      renderRoot();
      renderList();
      el.rootModal.classList.add('hidden');
      setText(el.flash, '已保存云端目录映射（写入 syncmanager.config.json）', 'ok');
      window.CSM.appendLog(`✎ 已设置云端目录映射：${data.root && data.root.rootPath} ↔ ${data.root && data.root.localRoot}\n`);
    } finally {
      el.rootSave.disabled = false;
    }
  }

  async function clearRoot() {
    if (!confirm('清除云端目录映射，改回按已有条目自动推断？')) return;
    const resp = await fetch(api('/filelist/cloud-root'), { method: 'DELETE' });
    const data = await readJson(resp);
    if (!resp.ok) { setText(el.rootMsg, data.error || `清除失败（${resp.status}）`, 'error'); return; }
    el.rootModal.classList.add('hidden');
    setText(el.flash, '已清除云端目录映射', 'ok');
    loadRoot();
  }

  // ---------- 新增 / 编辑 ----------
  function openEditor(e) {
    editingPath = e ? e.path : null;
    lastResolvedId = e ? e.spreadsheetId || '' : '';
    el.formTitle.textContent = e ? `编辑：${e.name || e.path}` : '新增配置表';
    el.save.textContent = e ? '保存修改' : '添加到清单';
    el.base.textContent = baseLabel || 'filelist.json 所在目录';
    el.link.value = '';
    el.name.value = e ? e.name || '' : '';
    el.path.value = e ? e.path || '' : '';
    el.desc.value = e ? e.description || '' : '';
    el.id.value = e ? e.spreadsheetId || '' : '';
    setText(el.cloud, e ? '如需换绑云端表，在上方粘贴新链接' : '粘贴链接后自动识别云端表名和所在目录，并填好下面各项', '', 'fl-cloud');
    setText(el.msg, '');
    el.edit.classList.remove('hidden');
    (e ? el.name : el.link).focus();
  }

  function closeEditor() {
    el.edit.classList.add('hidden');
    resolveSeq++; // 丢弃仍在进行的解析
  }

  const MODE_TEXT = {
    mapped: '已按云端目录对齐',
    parent: '未设置目录映射，按云端所在文件夹放置',
    outside: '不在映射的云端根目录下，已按所在文件夹放置，请确认路径'
  };

  function showCloud(data) {
    el.cloud.innerHTML = '';
    el.cloud.className = 'fl-cloud ok';
    const c = data.cloud;

    const card = document.createElement('div');
    card.className = 'fl-cloud-card';

    const header = document.createElement('div');
    header.className = 'fl-cloud-card-header';

    const titleRow = document.createElement('div');
    titleRow.className = 'fl-cloud-card-title';
    titleRow.innerHTML = `
      <span class="fl-cloud-badge">${window.CSMIcons?.sheet || '📊'} Google Sheets</span>
      <a href="${escapeHtml(c.webViewLink || sheetUrl(data.spreadsheetId))}" target="_blank" rel="noopener noreferrer" class="fl-cloud-link">
        <span>${escapeHtml(c.name)}</span>
        <span class="fl-ext-arrow">↗</span>
      </a>
    `;

    const timeTag = document.createElement('span');
    timeTag.className = 'fl-cloud-time';
    timeTag.textContent = `云端修改: ${fmtTime(c.modifiedTime)}`;

    header.append(titleRow, timeTag);
    card.appendChild(header);

    const loc = data.location;
    if (loc) {
      const line = document.createElement('div');
      line.className = loc.mode === 'outside' ? 'fl-loc-line warn' : 'fl-loc-line';
      const dir = (data.suggestion && data.suggestion.path || '').replace(/[^/]*$/, '');
      line.innerHTML = `
        <div class="fl-loc-flow">
          <span class="fl-loc-item"><span class="fl-loc-lbl">云端目录</span><code>${escapeHtml(loc.cloudDir || '（根目录）')}</code></span>
          <span class="fl-loc-arrow">➔</span>
          <span class="fl-loc-item"><span class="fl-loc-lbl">推荐本地</span><code>${escapeHtml(baseLabel + dir)}</code></span>
        </div>
        <span class="fl-loc-mode">${escapeHtml(MODE_TEXT[loc.mode] || '')}</span>
      `;
      card.appendChild(line);
    }
    if (!c.isGoogleSheet) {
      const w = document.createElement('div');
      w.className = 'fl-cloud-alert warn';
      w.innerHTML = `⚠ 这不是标准 Google 表格文件（类型：${escapeHtml(c.mimeType)}），同步可能失败`;
      card.appendChild(w);
    }
    const dup = (data.existing || []).filter(x => x.path !== editingPath);
    if (dup.length) {
      const w = document.createElement('div');
      w.className = 'fl-cloud-alert warn';
      w.innerHTML = `⚠ 清单中已存在该云端表：<strong>${escapeHtml(dup.map(x => `${x.name} (${x.path})`).join('、'))}</strong>`;
      card.appendChild(w);
    }
    el.cloud.appendChild(card);
  }

  async function resolveLink() {
    const input = el.link.value.trim();
    if (!input) return;
    const seq = ++resolveSeq;
    setText(el.cloud, '正在查询云端表和所在目录…', '', 'fl-cloud');
    el.resolve.disabled = true;
    try {
      const resp = await fetch(api('/filelist/resolve'), { method: 'POST', ...json({ input }) });
      const data = await readJson(resp);
      if (seq !== resolveSeq) return;
      if (!resp.ok) {
        if (resp.status === 401) {
          setText(el.cloud, '需要先完成 Google 授权（关闭弹窗后点页面上的「前往授权」）', 'error', 'fl-cloud');
          window.CSM.showAuthBanner();
        } else {
          setText(el.cloud, `✗ ${data.error || `解析失败（${resp.status}）`}`, 'error', 'fl-cloud');
        }
        return;
      }
      lastResolvedId = data.spreadsheetId;
      el.id.value = data.spreadsheetId;
      showCloud(data);
      const s = data.suggestion || {};
      if (editingPath) {
        // 编辑时换绑：只补空字段，不覆盖已有的表名 / 路径
        if (!el.name.value.trim()) el.name.value = s.name || '';
        if (!el.path.value.trim()) el.path.value = s.path || '';
        if (!el.desc.value.trim()) el.desc.value = s.description || '';
      } else {
        el.name.value = s.name || '';
        el.path.value = s.path || '';
        el.desc.value = s.description || '';
        el.save.focus();
      }
      setText(el.msg, '');
    } catch (err) {
      if (seq === resolveSeq) setText(el.cloud, `✗ ${err.message}`, 'error', 'fl-cloud');
    } finally {
      if (seq === resolveSeq) el.resolve.disabled = false;
    }
  }

  async function save(allowDuplicateId) {
    const entry = {
      name: el.name.value.trim(),
      path: el.path.value.trim(),
      description: el.desc.value.trim(),
      spreadsheetId: el.id.value.trim() || el.link.value.trim()
    };
    if (!entry.spreadsheetId) {
      setText(el.msg, '请先粘贴 Google 表格链接', 'error');
      el.link.focus();
      return;
    }
    const editing = editingPath;
    el.save.disabled = true;
    setText(el.msg, entry.path ? '保存中…' : '保存中…（本地路径留空，按云端目录自动生成）');
    try {
      const resp = await fetch(api('/filelist'), {
        method: editing ? 'PUT' : 'POST',
        ...json(editing ? { originalPath: editing, entry, allowDuplicateId } : { entry, allowDuplicateId })
      });
      const data = await readJson(resp);
      if (resp.status === 409 && data.code === 'DUPLICATE_ID' && !allowDuplicateId) {
        setText(el.msg, '');
        if (confirm(`${data.error}\n\n同一个云端表对应多个本地文件通常是误操作。仍要保存吗？`)) return save(true);
        return;
      }
      if (!resp.ok) {
        setText(el.msg, resp.status === 401 ? '需要先完成 Google 授权' : data.error || `保存失败（${resp.status}）`, 'error');
        return;
      }
      const saved = data.entry;
      window.CSM.appendLog(editing
        ? `✎ 已修改清单条目：${saved.name}（${saved.path}）\n`
        : `＋ 已添加到清单：${saved.name}（${saved.path}）\n`);
      closeEditor();
      el.filter.value = '';
      await loadList(saved.path);
      setText(el.flash, editing ? `已保存：${saved.path}` : `已添加：${saved.path}（本地还没有这个文件，可在主列表里点「下载」）`, 'ok');
      window.CSM.reloadTables();
    } catch (err) {
      setText(el.msg, err.message, 'error');
    } finally {
      el.save.disabled = false;
    }
  }

  async function removeEntry(e) {
    const ok = confirm(`从清单移除「${e.name}」？\n\n${e.path}\n\n只修改 filelist.json，不会删除本地 xlsx 文件，也不会动云端表。`);
    if (!ok) return;
    const resp = await fetch(api(`/filelist?path=${encodeURIComponent(e.path)}`), { method: 'DELETE' });
    const data = await readJson(resp);
    if (!resp.ok) {
      setText(el.flash, data.error || `删除失败（${resp.status}）`, 'error');
      return;
    }
    window.CSM.appendLog(`− 已从清单移除：${e.name}（${e.path}）\n`);
    await loadList();
    setText(el.flash, `已移除：${e.path}`, 'ok');
    window.CSM.reloadTables();
  }

  // ---------- 打开 / 关闭 ----------
  async function open() {
    if (!window.CSM.currentId()) {
      alert('请先添加并选择一个项目');
      return;
    }
    entries = [];
    localTables = [];
    rootInfo = null;
    cloudQuerying = false;
    cloudFailed = {};
    currentTab = 'all';
    document.querySelectorAll('.fl-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'all'));
    el.filter.value = '';
    if (el.filterClear) el.filterClear.classList.add('hidden');
    setText(el.flash, '');
    el.modal.classList.remove('hidden');
    el.filter.focus();
    await loadList();
    loadRoot(); // 后台识别云端目录（首次约几秒，之后有缓存）
    syncCloudPaths(); // 只为还没记录云端路径的条目查询，并写回 filelist.json
  }

  if (el.open) el.open.addEventListener('click', open);
  if (el.manage) el.manage.addEventListener('click', open);
  el.close.addEventListener('click', () => {
    if (batchRunning && !confirm('批量上传还在进行，关闭窗口不会中断上传。确定关闭？')) return;
    el.modal.classList.add('hidden');
  });
  el.modal.addEventListener('click', e => { if (e.target === el.modal) el.modal.classList.add('hidden'); });
  // 差异预览 / 备份弹窗叠在清单上时，Esc 只关上层弹窗（由 panels.js 处理）
  el.modal.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.querySelector('#diff-modal:not(.hidden), #bk-modal:not(.hidden)')) el.modal.classList.add('hidden');
  });

  // 分段筛选标签点击
  document.querySelectorAll('.fl-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.fl-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab || 'all';
      renderList();
    });
  });

  // 搜索框输入与清空
  if (el.filterClear) {
    el.filterClear.addEventListener('click', () => {
      el.filter.value = '';
      el.filterClear.classList.add('hidden');
      renderList();
      el.filter.focus();
    });
  }
  el.filter.addEventListener('input', () => {
    if (el.filterClear) el.filterClear.classList.toggle('hidden', !el.filter.value);
    renderList();
  });
  el.add.addEventListener('click', () => openEditor(null));
  el.rootEdit.addEventListener('click', openRootEditor);
  $('fl-cloud-refresh').addEventListener('click', () => syncCloudPaths(true));
  // 打开映射的本地目录（如 Configs/Input/Datas）
  $('fl-open-local').addEventListener('click', () => revealLocal(localRootParts().join('/')));

  el.editClose.addEventListener('click', closeEditor);
  el.cancel.addEventListener('click', closeEditor);
  el.edit.addEventListener('click', e => { if (e.target === el.edit) closeEditor(); });
  el.edit.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeEditor(); } });
  el.resolve.addEventListener('click', resolveLink);
  el.link.addEventListener('keydown', e => { if (e.key === 'Enter') resolveLink(); });
  el.link.addEventListener('paste', () => setTimeout(resolveLink, 0)); // 粘贴后自动解析
  el.id.addEventListener('change', () => {
    if (el.id.value.trim() !== lastResolvedId) {
      setText(el.cloud, 'spreadsheetId 已手动修改，可粘贴链接重新解析以确认云端表', '', 'fl-cloud');
    }
  });
  [el.name, el.path, el.desc, el.id].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(false); }));
  el.save.addEventListener('click', () => save(false));

  el.upClose.addEventListener('click', closeUpload);
  el.upCancel.addEventListener('click', closeUpload);
  el.up.addEventListener('click', e => { if (e.target === el.up) closeUpload(); });
  el.up.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeUpload(); } });
  [el.upCloudName, el.upName, el.upDesc].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter' && !el.upSave.disabled) saveUpload(); }));
  el.upSave.addEventListener('click', () => saveUpload());

  el.rootClose.addEventListener('click', () => el.rootModal.classList.add('hidden'));
  el.rootCancel.addEventListener('click', () => el.rootModal.classList.add('hidden'));
  el.rootModal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); el.rootModal.classList.add('hidden'); } });
  el.rootSave.addEventListener('click', saveRoot);
  el.rootClear.addEventListener('click', clearRoot);
})();
