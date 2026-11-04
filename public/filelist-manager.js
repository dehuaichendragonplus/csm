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
  let cloudPaths = null;  // { [spreadsheetId]: { dirs, name, error } }；null = 加载中
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
    if (cloudPaths) for (const e of entries) {
      const info = cloudPaths[e.spreadsheetId];
      if (info && !info.error) e.cloudName = [...info.dirs, info.name].join(' / ');
    }
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
    tr.appendChild(td(t.path, 'fl-col-path'));
    const target = cloudTargetOf(t.path);
    const tc = document.createElement('td');
    if (!rootInfo) { tc.textContent = '正在识别云端目录…'; tc.className = 'fl-muted'; }
    else if (!target) { tc.textContent = '未设置云端目录映射'; tc.className = 'fl-target warn'; }
    else if (target.outside) { tc.textContent = '不在映射的本地目录下'; tc.className = 'fl-target warn'; }
    else { tc.textContent = `→ ${target.dir}`; tc.className = 'fl-target'; tc.title = '上传后放到这个云端目录（缺的文件夹会自动创建）'; }
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
      loadCloudPaths([data.entry.spreadsheetId]);
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
    loadCloudPaths();
    const summary = `批量上传完成：成功 ${done}${linked ? `（其中关联已有表 ${linked}）` : ''}${failed.length ? `，失败 ${failed.length}（详见日志）` : ''}`;
    setText(el.flash, summary, failed.length ? 'error' : 'ok');
    window.CSM.appendLog(`${summary}\n`);
    window.CSM.reloadTables();
  }

  // 云端路径：映射根目录部分置灰，其余正常显示；云端子目录与本地子目录不一致时给出提示
  function renderCloudPath(cell, e) {
    const a = document.createElement('a');
    a.href = sheetUrl(e.spreadsheetId);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const info = cloudPaths && cloudPaths[e.spreadsheetId];
    if (!cloudPaths) {
      a.textContent = '查询中…';
      a.className = 'fl-muted';
    } else if (!info || info.error) {
      a.textContent = `⚠ ${info && info.error ? info.error : '未查到'}`;
      a.className = 'fl-bad';
    } else {
      const full = [...info.dirs, info.name];
      const r = rootInfo && rootInfo.root && !rootInfo.root.error ? rootInfo.root : null;
      const rootParts = r ? String(r.rootPath).split(' / ') : [];
      const underRoot = r && rootParts.every((p, i) => info.dirs[i] === p);
      if (underRoot) {
        const pre = document.createElement('span');
        pre.className = 'fl-path-root';
        pre.textContent = `${rootParts.join(' / ')} / `;
        a.append(pre, full.slice(rootParts.length).join(' / '));
        // 对比云端子目录与本地子目录
        const cloudSub = info.dirs.slice(rootParts.length).join('/');
        const localParts = String(e.path).split('/');
        const lr = String(r.localRoot || '').split('/').filter(Boolean);
        const localUnder = lr.every((p, i) => (localParts[i] || '').toLowerCase() === p.toLowerCase());
        const localSub = localUnder ? localParts.slice(lr.length, -1).join('/') : null;
        if (localSub !== null && localSub.toLowerCase() !== cloudSub.toLowerCase()) {
          const w = document.createElement('span');
          w.className = 'fl-path-warn';
          w.textContent = ' ⚠';
          w.title = `云端目录与本地目录不一致\n云端：${cloudSub || '（根目录）'}\n本地：${localSub || '（根目录）'}`;
          a.appendChild(w);
        }
      } else {
        a.textContent = full.join(' / ');
      }
    }
    a.title = `${a.title ? `${a.title}\n` : ''}${info && !info.error ? [...info.dirs, info.name].join(' / ') : ''}\n${e.spreadsheetId}\n点击打开云端表`.trim();
    cell.appendChild(a);
  }

  async function loadCloudPaths(ids) {
    const q = ids && ids.length ? `?ids=${encodeURIComponent(ids.join(','))}` : '';
    try {
      const resp = await fetch(api(`/filelist/cloud-paths${q}`));
      if (!resp.ok) { if (!ids) cloudPaths = {}; renderList(); return; }
      const data = await readJson(resp);
      cloudPaths = ids ? { ...(cloudPaths || {}), ...data } : data;
      // 云端路径也参与筛选
      for (const e of entries) {
        const info = cloudPaths[e.spreadsheetId];
        if (info && !info.error) e.cloudName = [...info.dirs, info.name].join(' / ');
      }
      renderList();
    } catch (_) { /* 忽略，保持「查询中」 */ }
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
    tr.appendChild(td(e.path, 'fl-col-path'));
    tr.appendChild(td(e.description, 'fl-col-desc'));

    const cloud = document.createElement('td');
    cloud.className = 'fl-col-cloud';
    if (e.spreadsheetId) renderCloudPath(cloud, e);
    else {
      cloud.textContent = '缺少 ID';
      cloud.classList.add('fl-bad');
    }
    tr.appendChild(cloud);

    const local = td(e.local ? `✓ ${fmtSize(e.local.size)}` : '未下载', e.local ? 'fl-ok' : 'fl-muted');
    if (e.local) local.title = `本地修改时间：${fmtTime(e.local.mtime)}`;
    tr.appendChild(local);

    const ops = document.createElement('td');
    ops.className = 'fl-col-ops';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => openEditor(e));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fl-del';
    del.textContent = '删除';
    del.addEventListener('click', () => removeEntry(e));
    ops.append(edit, del);
    tr.appendChild(ops);
    tr.addEventListener('dblclick', () => openEditor(e));
    return tr;
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
      loadCloudPaths([saved.spreadsheetId]);
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
    cloudPaths = null;
    el.filter.value = '';
    setText(el.flash, '');
    el.modal.classList.remove('hidden');
    el.filter.focus();
    await loadList();
    loadRoot(); // 后台识别云端目录（首次约几秒，之后有缓存）
    loadCloudPaths(); // 后台查询每张云端表的云端路径
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
