// 配置表清单（filelist.json）：列表预览；新增 / 编辑 / 云端目录映射各用独立弹窗，确认后直接写回并刷新列表
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = {
    open: $('btn-filelist'),
    // 列表
    modal: $('fl-modal'),
    close: $('fl-close'),
    file: $('fl-file'),
    root: $('fl-root'),
    rootEdit: $('fl-root-edit'),
    filter: $('fl-filter'),
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

  async function readJson(resp) {
    try { return await resp.json(); } catch (_) { return {}; }
  }

  function setText(node, text, kind, base) {
    node.textContent = text || '';
    node.className = `${base || 'fl-msg'}${kind ? ` ${kind}` : ''}`;
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
    tr.className = 'fl-group';
    const c = document.createElement('td');
    c.colSpan = 6;
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = collapsed[key] ? '▶' : '▼';
    const t = document.createElement('span');
    t.textContent = `${title}（${count}）`;
    const tipEl = document.createElement('span');
    tipEl.className = 'fl-group-tip';
    tipEl.textContent = tip || '';
    c.append(caret, t, tipEl);
    if (ops) {
      const box = document.createElement('span');
      box.className = 'fl-group-ops';
      box.appendChild(ops);
      box.addEventListener('click', e => e.stopPropagation());
      c.appendChild(box);
    }
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
    el.count.textContent = terms.length
      ? `匹配 ${cloudShown.length + localShown.length} / 共 ${total} 项`
      : `云端表 ${entries.length} · 本地表 ${localTables.length}`;
    el.tbody.innerHTML = '';
    let target = null;

    // 云端表：已在 filelist.json 中
    el.tbody.appendChild(groupRow('cloud', '云端表', cloudShown.length, '已在 filelist.json 中，与云端 Google 表格关联'));
    if (!collapsed.cloud) {
      if (!cloudShown.length) el.tbody.appendChild(emptyRow(entries.length ? '没有匹配的云端表' : '清单是空的：可以上传下方的本地表，或点「＋ 新增配置表」关联已有云端表'));
      for (const e of cloudShown) {
        const tr = renderRow(e);
        if (highlightPath && e.path === highlightPath) { tr.classList.add('fl-flash'); target = tr; }
        el.tbody.appendChild(tr);
      }
    }

    // 本地表：本地目录下存在、但还没加入清单
    const batchBtn = document.createElement('button');
    batchBtn.type = 'button';
    batchBtn.textContent = terms.length ? `上传筛选出的 ${localShown.length} 张` : `全部上传（${localShown.length}）`;
    batchBtn.disabled = !localShown.length || batchRunning;
    batchBtn.addEventListener('click', () => uploadBatch(localShown));
    el.tbody.appendChild(groupRow('local', '本地表', localShown.length, `${baseLabel}${localRoot}/ 下未加入清单的 xlsx`, localTables.length ? batchBtn : null));
    if (!collapsed.local) {
      if (!localShown.length) el.tbody.appendChild(emptyRow(localTables.length ? '没有匹配的本地表' : `${baseLabel}${localRoot}/ 下的 xlsx 都已在清单中`));
      for (const t of localShown) el.tbody.appendChild(renderLocalRow(t));
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
    tr.appendChild(td(t.name, 'fl-col-name'));
    tr.appendChild(pathCell(relLocalParts(t.path), '/', 'fl-col-path', `${baseLabel}${t.path}`));
    const target = cloudTargetOf(t.path);
    let tc;
    if (!rootInfo) { tc = td('正在识别云端目录…', 'fl-muted'); }
    else if (!target) { tc = td('未设置云端目录映射', 'fl-target warn'); }
    else if (target.outside) { tc = td('不在映射的本地目录下', 'fl-target warn'); }
    else {
      // 上传后的云端位置（相对映射根目录）
      const dirs = target.dir.split(' / ');
      const rel = [...(stripPrefix(dirs, cloudRootParts()) || dirs), t.name];
      tc = pathCell(rel, ' / ', 'fl-target', `上传后放到：${target.dir} / ${t.name}（缺的文件夹会自动创建）`);
      tc.insertBefore(document.createTextNode('→ '), tc.firstChild);
    }
    tr.appendChild(tc);
    tr.appendChild(td('未上传', 'fl-muted'));
    const local = td(`✓ ${fmtSize(t.size)}`, 'fl-ok');
    local.title = `本地修改时间：${fmtTime(t.mtime)}`;
    tr.appendChild(local);
    const ops = document.createElement('td');
    ops.className = 'fl-col-ops';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'fl-up';
    up.textContent = '上传';
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

  function cloudPathCell(e) {
    if (!e.spreadsheetId) {
      const c = td('缺少 ID', 'fl-col-cloud fl-bad');
      return c;
    }
    const c = document.createElement('td');
    c.className = 'fl-col-cloud';
    const a = document.createElement('a');
    a.href = sheetUrl(e.spreadsheetId);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (e.cloudDir && e.cloudFile) {
      const parts = [...relCloudDirs(e), e.cloudFile];
      parts.forEach((p, i) => {
        a.appendChild(document.createTextNode(i < parts.length - 1 ? `${p} / ` : p));
        if (i < parts.length - 1) a.appendChild(document.createElement('wbr'));
      });
      a.title = `${e.cloudDir.split('/').join(' / ')} / ${e.cloudFile}\n${e.spreadsheetId}\n点击打开云端表`;
      c.appendChild(a);
      // 云端子目录与本地子目录不一致时提示
      const cloudSub = relCloudDirs(e).join('/');
      const localUnder = stripPrefix(String(e.path).split('/').filter(Boolean), localRootParts());
      const localSub = localUnder ? localUnder.slice(0, -1).join('/') : null;
      // 本地不在映射目录下（如 DDatas/...）的不比较
      if (localSub !== null && cloudRootParts().length && lower(cloudSub) !== lower(localSub)) {
        const w = document.createElement('span');
        w.className = 'fl-path-warn';
        w.textContent = ' ⚠';
        w.title = `云端目录与本地目录不一致\n云端：${cloudSub || '（根目录）'}\n本地：${localSub || '（根目录）'}`;
        c.appendChild(w);
      }
    } else if (cloudFailed[e.spreadsheetId]) {
      a.textContent = `⚠ ${cloudFailed[e.spreadsheetId]}`;
      a.className = 'fl-bad';
      a.title = `${e.spreadsheetId}\n点击打开云端表`;
      c.appendChild(a);
    } else {
      a.textContent = cloudQuerying ? '查询中…' : '未记录';
      a.className = 'fl-muted';
      a.title = `${e.spreadsheetId}\n点击打开云端表`;
      c.appendChild(a);
    }
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

  function renderRow(e) {
    const tr = document.createElement('tr');
    tr.appendChild(td(e.name, 'fl-col-name'));
    tr.appendChild(pathCell(relLocalParts(e.path), '/', 'fl-col-path', `${baseLabel}${e.path}`));
    tr.appendChild(cloudPathCell(e));
    tr.appendChild(td(e.description, 'fl-col-desc'));

    tr.appendChild(syncStateCell(e));

    const ops = document.createElement('td');
    ops.className = 'fl-col-ops';
    const busy = rowBusy.get(e.path);
    const dir = e.sync && e.sync.direction;
    if (busy) {
      const b = document.createElement('span');
      b.className = 'fl-busy';
      b.textContent = busy;
      ops.appendChild(b);
    } else if (dir) {
      const sb = document.createElement('button');
      sb.type = 'button';
      sb.className = dir === 'download' ? 'fl-dl' : 'fl-ul';
      sb.textContent = dir === 'download' ? '⬇ 下载' : '⬆ 上传';
      sb.title = `${dir === 'download' ? '用云端表覆盖本地 xlsx' : '用本地 xlsx 覆盖云端表'}\n${timesText(e)}`;
      sb.addEventListener('click', () => (dir === 'download' ? downloadEntry(e) : uploadEntry(e)));
      ops.appendChild(sb);
    }
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.disabled = !!busy;
    edit.addEventListener('click', () => openEditor(e));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fl-del';
    del.textContent = '删除';
    del.disabled = !!busy;
    del.addEventListener('click', () => removeEntry(e));
    ops.append(edit, del);
    tr.appendChild(ops);
    tr.addEventListener('dblclick', () => openEditor(e));
    return tr;
  }

  // ---------- 本地 ↔ 云端同步 ----------
  function timesText(e) {
    const cloud = e.sync && e.sync.cloudModifiedTime;
    return `云端修改：${cloud ? fmtTime(cloud) : '—'}\n本地修改：${e.local ? fmtTime(e.local.mtime) : '本地没有文件'}`;
  }

  // 「本地文件」列：大小 + 与云端的关系
  function syncStateCell(e) {
    const c = document.createElement('td');
    c.className = 'fl-sync';
    const dir = e.sync && e.sync.direction;
    if (!e.local) {
      c.textContent = '未下载';
      c.classList.add('fl-muted');
    } else if (dir === 'download') {
      c.textContent = `云端较新 · ${fmtSize(e.local.size)}`;
      c.classList.add('fl-newer-cloud');
    } else if (dir === 'upload') {
      c.textContent = `本地较新 · ${fmtSize(e.local.size)}`;
      c.classList.add('fl-newer-local');
    } else if (e.sync && e.sync.status === 'synced') {
      c.textContent = `✓ 已同步 · ${fmtSize(e.local.size)}`;
      c.classList.add('fl-ok');
    } else {
      c.textContent = `✓ ${fmtSize(e.local.size)}`;
      c.classList.add('fl-ok');
    }
    c.title = timesText(e);
    return c;
  }

  function setRowBusy(path, label) {
    if (label) rowBusy.set(path, label); else rowBusy.delete(path);
    renderList();
  }

  // 复用主列表的下载接口（SSE），读完整个流后看 table-done 结果
  async function downloadEntry(e) {
    if (e.local && !confirm(`用云端表覆盖本地「${e.name}」？\n\n${e.path}\n${timesText(e)}\n\n本地文件会被替换（可用 git 找回）。`)) return;
    setRowBusy(e.path, '下载中…');
    window.CSM.appendLog(`→ 下载 ${e.name}（${e.path}）\n`);
    try {
      const resp = await fetch(api('/sync'), { method: 'POST', ...json({ paths: [e.path] }) });
      if (resp.status === 401) { setText(el.flash, '需要先完成 Google 授权', 'error'); return; }
      const text = await resp.text();
      const done = text.split('\n\n').map(block => {
        const ev = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.*)$/m) || [])[1];
        try { return ev === 'table-done' ? JSON.parse(data) : null; } catch (_) { return null; }
      }).find(Boolean);
      if (done && done.success) {
        window.CSM.appendLog(`✓ 已用云端覆盖本地：${e.path}\n`);
        setText(el.flash, `已下载：${e.path}`, 'ok');
      } else {
        const msg = done && done.error ? done.error : '下载失败';
        window.CSM.appendLog(`✗ 下载失败：${e.path} — ${msg}\n`);
        setText(el.flash, `下载失败：${msg}`, 'error');
      }
    } catch (err) {
      setText(el.flash, `下载失败：${err.message}`, 'error');
    } finally {
      rowBusy.delete(e.path);
      await loadList(e.path);
      window.CSM.reloadTables();
    }
  }

  async function uploadEntry(e) {
    if (!confirm(`用本地 xlsx 覆盖云端表「${e.name}」？\n\n${e.path}\n${timesText(e)}\n\n云端现有内容会被替换（可在 Google 表格版本历史中恢复）。`)) return;
    setRowBusy(e.path, '上传中…');
    window.CSM.appendLog(`→ 上传本地 ${e.name} 覆盖云端（${e.path}）\n`);
    try {
      const resp = await fetch(api(`/upload?path=${encodeURIComponent(e.path)}`), { method: 'POST' });
      const data = await readJson(resp);
      if (resp.ok) {
        window.CSM.appendLog(`✓ 已用本地覆盖云端：${e.path}（云端修改时间 ${fmtTime(data.modifiedTime)}）\n`);
        setText(el.flash, `已上传：${e.path}`, 'ok');
      } else {
        const msg = resp.status === 401 ? '需要先完成 Google 授权'
          : data.error === 'NEED_UPLOAD_SCOPE' ? '当前授权只有只读权限，请在主界面重新授权（/auth/start）'
          : data.error || `上传失败（${resp.status}）`;
        window.CSM.appendLog(`✗ 上传失败：${e.path} — ${msg}\n`);
        setText(el.flash, `上传失败：${msg}`, 'error');
      }
    } catch (err) {
      setText(el.flash, `上传失败：${err.message}`, 'error');
    } finally {
      rowBusy.delete(e.path);
      await loadList(e.path);
      window.CSM.reloadTables();
    }
  }

  // ---------- 云端目录映射 ----------
  function renderRoot() {
    el.root.innerHTML = '';
    el.root.className = 'fl-root';
    if (!rootInfo) { el.root.textContent = '正在识别云端目录…'; return; }
    if (rootInfo.error) { el.root.textContent = rootInfo.error; el.root.classList.add('warn'); return; }
    const r = rootInfo.root;
    if (!r) {
      el.root.append('未设置，且清单为空无法推断 —— 新表按云端所在文件夹放到 ', code(`${baseLabel}Datas/<文件夹名>/`));
      return;
    }
    if (r.error) { el.root.textContent = `⚠ ${r.error}`; el.root.classList.add('warn'); return; }
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = r.source === 'config'
      ? '（项目配置）'
      : `（未设置，按已有条目自动推断：${r.votes}/${r.sampled} 一致）`;
    el.root.append('云端 ', code(r.rootPath), ' ↔ 本地 ', code(`${baseLabel}${r.localRoot ? `${r.localRoot}/` : ''}`), tag);
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
    const a = document.createElement('a');
    a.href = c.webViewLink || sheetUrl(data.spreadsheetId);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = c.name;
    el.cloud.append('✓ 云端表：', a, `　最后修改 ${fmtTime(c.modifiedTime)}`);

    const loc = data.location;
    if (loc) {
      const line = document.createElement('div');
      line.className = loc.mode === 'outside' ? 'fl-warn' : 'fl-loc';
      const dir = (data.suggestion && data.suggestion.path || '').replace(/[^/]*$/, '');
      line.append(loc.mode === 'outside' ? '⚠ ' : '', '云端位置 ', code(loc.cloudDir || '（根目录）'), ' → 本地 ', code(`${baseLabel}${dir}`), `　${MODE_TEXT[loc.mode] || ''}`);
      el.cloud.appendChild(line);
    }
    if (!c.isGoogleSheet) {
      const w = document.createElement('div');
      w.className = 'fl-warn';
      w.textContent = `⚠ 这不是 Google 表格（类型 ${c.mimeType}），同步可能失败`;
      el.cloud.appendChild(w);
    }
    const dup = (data.existing || []).filter(x => x.path !== editingPath);
    if (dup.length) {
      const w = document.createElement('div');
      w.className = 'fl-warn';
      w.textContent = `⚠ 清单里已有这个云端表：${dup.map(x => `${x.name}（${x.path}）`).join('、')}`;
      el.cloud.appendChild(w);
    }
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
    el.filter.value = '';
    setText(el.flash, '');
    el.modal.classList.remove('hidden');
    el.filter.focus();
    await loadList();
    loadRoot(); // 后台识别云端目录（首次约几秒，之后有缓存）
    syncCloudPaths(); // 只为还没记录云端路径的条目查询，并写回 filelist.json
  }

  el.open.addEventListener('click', open);
  el.close.addEventListener('click', () => {
    if (batchRunning && !confirm('批量上传还在进行，关闭窗口不会中断上传。确定关闭？')) return;
    el.modal.classList.add('hidden');
  });
  el.modal.addEventListener('click', e => { if (e.target === el.modal) el.modal.classList.add('hidden'); });
  el.modal.addEventListener('keydown', e => { if (e.key === 'Escape') el.modal.classList.add('hidden'); });
  el.filter.addEventListener('input', () => renderList());
  el.add.addEventListener('click', () => openEditor(null));
  el.rootEdit.addEventListener('click', openRootEditor);
  $('fl-cloud-refresh').addEventListener('click', () => syncCloudPaths(true));

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
