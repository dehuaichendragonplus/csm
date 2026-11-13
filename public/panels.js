// 差异预览 / 本地备份 / 操作历史 / 新版本提示。依赖 app.js 暴露的 window.CSM。
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const CSM = () => window.CSM;
  const fmt = iso => (CSM() ? CSM().formatTime(iso) : iso);
  const fmtSize = n => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  function setMsg(node, text, kind) {
    node.textContent = text || '';
    node.className = `fl-msg${kind ? ` ${kind}` : ''}`;
  }

  // ======================= 差异预览（类似 Fork 的逐行对照） =======================
  const d = {
    modal: $('diff-modal'), title: $('diff-title'), path: $('diff-path'), meta: $('diff-meta'),
    tree: $('diff-tree'), view: $('diff-view'), ruler: $('diff-ruler'), pos: $('diff-pos'),
    seg: $('diff-mode-seg'), swap: $('diff-swap'), onlyCols: $('diff-onlycols'), allRows: $('diff-allrows'),
    prev: $('diff-prev'), next: $('diff-next'),
    find: $('diff-find'), record: $('diff-record'), findSubmit: $('diff-find-submit'),
    findClear: $('diff-find-clear'), findStatus: $('diff-find-status'),
    msg: $('diff-msg'), close: $('diff-close'), cancel: $('diff-cancel'), refresh: $('diff-refresh'),
    direction: $('diff-direction-status'), dl: $('diff-download'), dlHint: $('diff-download-hint'),
    ul: $('diff-upload'), ulHint: $('diff-upload-hint'), ulAction: $('diff-upload-action'),
    editTools: $('diff-edit-tools'), copyRight: $('diff-copy-right'), copyLeft: $('diff-copy-left'), undo: $('diff-undo'),
    saveActions: $('diff-save-actions'), saveLocal: $('diff-save-local'), saveCloud: $('diff-save-cloud'),
    discard: $('diff-discard'), saveStatus: $('diff-save-status')
  };
  let diffState = null;
  const MODE_TITLE = {
    view: '差异预览',
    upload: '上传前确认差异',
    conflict: '解决冲突：云端和本地都改过',
    review: '确认同步方向：没有同步基准'
  };
  const needsDirectionChoice = mode => mode === 'conflict' || mode === 'review';
  function resolveDiffMode(path, mode) {
    const direction = CSM().tableRow(path)?.direction;
    return !needsDirectionChoice(mode) && needsDirectionChoice(direction) ? direction : mode;
  }
  const SIDE_NAME = { local: '本地', cloud: '云端' };
  const CONTEXT = 3;          // 改动前后保留的相同行数，其余折叠
  const MIN_FOLD = 4;         // 少于这么多行的相同段不折叠

  const PREF = { mode: 'csm.diff.mode', onlyCols: 'csm.diff.onlyCols', allRows: 'csm.diff.allRows' };
  const getPref = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : v; } catch (_) { return def; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const prefs = { mode: getPref(PREF.mode, 'unified'), onlyCols: getPref(PREF.onlyCols, '0') === '1', allRows: getPref(PREF.allRows, '0') === '1' };

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colLetter = c => { let s = ''; for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

  function finishDiff(result) {
    if (!diffState) return;
    const { resolve, opener } = diffState;
    diffState = null;
    d.modal.classList.add('hidden');
    if (opener?.isConnected) opener.focus();
    resolve(result);
  }

  function openDiff(path, { mode = 'view' } = {}) {
    if (diffState) finishDiff(null);
    mode = resolveDiffMode(path, mode);
    return new Promise(resolve => {
      diffState = { path, mode, data: null, resolve, opener: document.activeElement };
      d.title.textContent = MODE_TITLE[mode] || MODE_TITLE.view;
      d.path.textContent = path;
      d.modal.classList.remove('hidden');
      loadDiff();
      d.close.focus();
    });
  }

  let diffLoadingTimer = null;
  function showPlaceholder(text, { withSpinner = false } = {}) {
    if (diffLoadingTimer) { clearInterval(diffLoadingTimer); diffLoadingTimer = null; }
    d.tree.innerHTML = '';
    d.ruler.innerHTML = '';
    d.pos.textContent = '';
    d.view.innerHTML = '';
    const box = el('div', 'diff-loading');
    if (withSpinner) {
      box.appendChild(el('div', 'diff-spinner'));
    }
    const txt = el('div', 'diff-loading-text', text);
    box.appendChild(txt);
    d.view.appendChild(box);
    return txt;
  }

  async function loadDiff({ force = false } = {}) {
    const st = diffState;
    const token = Symbol('diff');
    st.token = token;
    st.data = null;
    st.stale = false;
    st.recordSheets = null;
    st.recordToken = null;
    st.models = new Map();   // 编辑模型（按工作表下标）
    st.undo = [];
    st.sel = null;
    d.record.value = '';
    d.findStatus.textContent = '';
    d.findClear.classList.add('hidden');
    d.meta.textContent = '';
    const txtNode = showPlaceholder('正在比较表格差异…', { withSpinner: true });
    const startTime = Date.now();
    diffLoadingTimer = setInterval(() => {
      if (diffState !== st || st.token !== token) {
        clearInterval(diffLoadingTimer);
        diffLoadingTimer = null;
        return;
      }
      const sec = Math.floor((Date.now() - startTime) / 1000);
      if (sec >= 1) {
        txtNode.textContent = `正在从云端导出并逐单元格比较…（已用时 ${sec} 秒，首次比较大表需拉取）`;
      }
    }, 1000);
    setMsg(d.msg, '');
    updateButtons();
    try {
      const url = CSM().api(`/diff?path=${encodeURIComponent(st.path)}${force ? '&force=1' : ''}`);
      const resp = await fetch(url);
      const data = await resp.json().catch(() => ({}));
      if (diffLoadingTimer) { clearInterval(diffLoadingTimer); diffLoadingTimer = null; }
      if (diffState !== st || st.token !== token) return;
      if (!resp.ok) { showPlaceholder(resp.status === 401 ? '需要先完成 Google 授权' : `比较失败：${data.error || resp.status}`); return; }
      st.mode = resolveDiffMode(st.path, st.mode);
      d.title.textContent = MODE_TITLE[st.mode] || MODE_TITLE.view;
      st.newSide = incomingSide() || 'cloud';
      st.oldSide = st.newSide === 'cloud' ? 'local' : 'cloud';
      st.expanded = new Map();
      st.showSame = data.diff.identical;
      const first = data.diff.sheets.findIndex(s => s.status !== 'same');
      st.sheet = first >= 0 ? first : 0;
      st.data = data;
      renderAll();
      if (data.downloadVersion?.reviewed !== true) {
        setMsg(d.msg, '未取得可校验的下载版本，请重新比较。', 'error');
      }
    } catch (err) {
      if (diffLoadingTimer) { clearInterval(diffLoadingTimer); diffLoadingTimer = null; }
      if (diffState === st) {
        st.data = null;
        showPlaceholder(`比较失败：${err.message}`);
      }
    } finally {
      if (diffState === st) updateButtons();
    }
  }

  // 建议保留的一侧与差异视图的显示顺序独立。
  function incomingSide() {
    const st = diffState;
    if (st.mode === 'upload') return 'local';
    if (needsDirectionChoice(st.mode)) return null;
    const row = CSM().tableRow(st.path);
    return row && row.direction === 'upload' ? 'local' : 'cloud';
  }

  // ---------- 统计：按 Beyond Compare 的口径，不分方向 —— 差异行 / 仅本地有的行 / 仅云端有的行 ----------
  function sheetCounts(sheet) {
    const i = diffState.data?.diff.sheets.indexOf(sheet);
    const m = i >= 0 ? diffState.models?.get(i) : null;
    if (m) {
      const c = { mod: 0, lo: 0, co: 0 };
      for (const r of modelView(m).rows) { if (r.k === '~') c.mod++; else if (r.k === 'L') c.lo++; else if (r.k === 'C') c.co++; }
      return c.mod || c.lo || c.co || m.dirty.local || m.dirty.cloud ? c : null;
    }
    if (sheet.status === 'same') return null;
    if (sheet.status === 'local_only') return { mod: 0, lo: sheet.localRows, co: 0 };
    if (sheet.status === 'cloud_only') return { mod: 0, lo: 0, co: sheet.cloudRows };
    const s = sheet.stats;
    return { mod: s.modified, lo: s.localOnly, co: s.cloudOnly };
  }

  function renderAll() {
    renderMeta();
    syncToolbar();
    renderTree();
    renderSheet();
  }

  function renderMeta() {
    const { data, mode, oldSide, newSide } = diffState;
    const sideText = side => side === 'local'
      ? (data.local.exists ? `修改于 ${fmt(data.local.mtime)} · ${fmtSize(data.local.size)}` : '本地还没有这个文件')
      : `修改于 ${fmt(data.cloud.modifiedTime)}${data.cloud.changedVia ? `（源表「${data.cloud.changedVia.name || data.cloud.changedVia.id}」）` : ''}${data.cloud.modifiedBy ? ` · ${data.cloud.modifiedBy}` : ''}${data.cloud.name ? ` · ${data.cloud.name}` : ''}${data.cloud.sourceWarning ? ` · ⚠ ${data.cloud.sourceWarning}` : ''}`;
    d.meta.innerHTML = '';
    const sides = el('div', 'dm-sides');
    const chip = (cls, pos, side) => { const c = el('span', `dm-chip ${cls} ${side}`); c.append(el('b', null, pos), ` ${SIDE_NAME[side]}`); return c; };
    sides.append(chip('old', '左', oldSide), el('span', 'dm-text', sideText(oldSide)), el('span', 'dm-arrow', '⇄'), chip('new', '右', newSide), el('span', 'dm-text', sideText(newSide)));
    d.meta.appendChild(sides);

    const diff = data.diff;
    const summary = el('div', 'dm-summary');
    if (diff.identical) {
      summary.appendChild(el('span', 'diff-same', '✓ 两边内容完全一致（只是修改时间不同）。'));
      if ((!needsDirectionChoice(mode) || diff.identical) && data.local.exists) summary.append(' 可用底部的下载操作把状态记为已同步。');
    } else {
      const t = { mod: 0, lo: 0, co: 0 };
      let changed = 0;
      for (const s of diff.sheets) { const c = sheetCounts(s); if (!c) continue; changed++; t.mod += c.mod; t.lo += c.lo; t.co += c.co; }
      summary.append(`${changed} 个工作表有差异：`);
      if (t.mod) summary.appendChild(el('span', 'dm-n mod', `差异 ${t.mod} 行`));
      // 只在一侧有的行（Beyond Compare 叫「孤立行」）：不说新增 / 删除，那取决于往哪边同步
      if (t.lo) summary.appendChild(el('span', 'dm-n orph', `仅本地 ${t.lo} 行`));
      if (t.co) summary.appendChild(el('span', 'dm-n orph', `仅云端 ${t.co} 行`));
      const reordered = diff.sheets.filter(sheet => sheet.orderChanged).length;
      if (reordered) summary.appendChild(el('span', 'dm-n mod', `${reordered} 个工作表行序变化`));
      let colL = 0;
      let colC = 0;
      for (const s of diff.sheets) {
        if (!s.onlyCols) continue;
        colL += s.onlyCols.local.length;
        colC += s.onlyCols.cloud.length;
      }
      if (colL) summary.appendChild(el('span', 'dm-n orph', `仅本地 ${colL} 列`));
      if (colC) summary.appendChild(el('span', 'dm-n orph', `仅云端 ${colC} 列`));
    }
    d.meta.appendChild(summary);
  }

  function syncToolbar() {
    for (const b of d.seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === prefs.mode);
    d.onlyCols.checked = prefs.onlyCols;
    d.allRows.checked = prefs.allRows;
  }

  const activeSheets = st => st.recordSheets || st.data.diff.sheets;

  function setRecordResults(st, sheets) {
    if (sheets && !st.recordSheets) st.fullSheet = st.sheet;
    st.recordSheets = sheets;
    st.sheet = sheets ? 0 : st.fullSheet ?? st.sheet;
    st.expanded = new Map();
    d.findClear.classList.toggle('hidden', !sheets);
    renderTree();
    renderSheet();
  }

  d.find.addEventListener('submit', async e => {
    e.preventDefault();
    const st = diffState;
    const record = d.record.value.trim();
    if (!st?.data || !record) return;
    const token = Symbol('record');
    st.recordToken = token;
    d.findStatus.textContent = '查找中…';
    const params = new URLSearchParams({ path: st.path, record, snapshot: st.data.snapshot });
    try {
      const response = await fetch(CSM().api(`/diff?${params}`));
      const data = await response.json();
      if (diffState !== st || st.recordToken !== token) return;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const sheets = data.sheets;
      if (sheets.length) {
        setRecordResults(st, sheets);
        const count = sheets.reduce((n, sheet) => n + sheet.matches, 0);
        d.findStatus.textContent = `找到 ${count} 条记录 · ${sheets.length} 个工作表`;
      } else {
        if (st.recordSheets) setRecordResults(st, null);
        d.findStatus.textContent = '未找到此 ID';
      }
    } catch (err) {
      if (diffState === st && st.recordToken === token) d.findStatus.textContent = err.message;
    }
  });
  d.findClear.addEventListener('click', () => {
    const st = diffState;
    if (!st?.data) return;
    st.recordToken = null;
    d.record.value = '';
    d.findStatus.textContent = '';
    if (st.recordSheets) setRecordResults(st, null);
    d.record.focus();
  });

  // ---------- 左侧：工作表列表 ----------
  function renderTree() {
    const st = diffState;
    const sheets = activeSheets(st);
    d.tree.innerHTML = '';
    if (st.recordSheets) {
      d.tree.appendChild(el('div', 'dt-head', '匹配的工作表'));
      sheets.forEach((sheet, i) => {
        const item = el('div', `dt-item${i === st.sheet ? ' sel' : ''}`);
        item.append(el('span', 'dt-name', sheet.name), el('span', 'dt-cnt', `${sheet.matches} 条`));
        item.addEventListener('click', () => selectSheet(i));
        d.tree.appendChild(item);
      });
      return;
    }
    const changed = sheets.map((s, i) => [s, i]).filter(([s]) => s.status !== 'same');
    const same = sheets.map((s, i) => [s, i]).filter(([s]) => s.status === 'same');
    d.tree.appendChild(el('div', 'dt-head', changed.length ? `${changed.length} 个工作表有差异` : '工作表'));
    const item = (s, i) => {
      const c = sheetCounts(s);
      const it = el('div', `dt-item${i === st.sheet ? ' sel' : ''}${c ? '' : ' same'}`);
      let badge = ['=', 'same'];
      if (s.orderChanged) badge = ['↕', 'mod'];
      else if (c) badge = c.mod || (c.lo && c.co) ? ['≠', 'mod'] : ['◐', 'orph'];
      if (s.status === 'local_only' || s.status === 'cloud_only') it.title = `只在${SIDE_NAME[s.status === 'local_only' ? 'local' : 'cloud']}有这个工作表`;
      it.appendChild(el('span', `dt-badge ${badge[1]}`, badge[0]));
      it.appendChild(el('span', 'dt-name', s.name));
      const cnt = el('span', 'dt-cnt');
      if (c) {
        if (c.mod) cnt.appendChild(el('b', 'mod', `≠${c.mod}`));
        if (c.lo) cnt.appendChild(el('b', 'orph', `本${c.lo}`));
        if (c.co) cnt.appendChild(el('b', 'orph', `云${c.co}`));
        const m = diffState.models?.get(i);
        if (m && (m.dirty.local || m.dirty.cloud)) cnt.appendChild(el('b', 'ed', '✎'));
      } else cnt.textContent = `${s.localRows} 行`;
      it.appendChild(cnt);
      it.addEventListener('click', () => selectSheet(i));
      return it;
    };
    changed.forEach(([s, i]) => d.tree.appendChild(item(s, i)));
    if (!same.length) return;
    if (changed.length) {
      const t = el('button', 'dt-toggle', `${st.showSame ? '▾' : '▸'} 无差异的工作表（${same.length}）`);
      t.type = 'button';
      t.addEventListener('click', () => { st.showSame = !st.showSame; renderTree(); });
      d.tree.appendChild(t);
    }
    if (st.showSame || !changed.length) same.forEach(([s, i]) => d.tree.appendChild(item(s, i)));
  }

  function selectSheet(i, { jump } = {}) {
    const st = diffState;
    st.sheet = i;
    st.sel = null;
    renderTree();
    renderSheet();
    if (jump === 'first') goTo(0);
    else if (jump === 'last') goTo(st.groups.length - 1);
  }

  // ---------- 编辑（类似 Beyond Compare：两侧都能改，选中范围「复制到另一侧」，两侧各自保存） ----------
  // 只有整表数据都在（视图未折叠、未截断）、两边都有的工作表能编辑；按业务 ID 查找的结果只读。
  // 模型 = { name, L: [行], C: [行], pairs: [{ l, c }], dirty: { local, cloud } }
  //   行 = { src: 原文件行号（1 起）| null（从另一侧复制来的新行）, v: [单元格], ed: Set(改过的列), add: 是否新插入 }
  //   L / C 按文件里的顺序；pairs 按差异视图的顺序，把两侧对应的行配成一对（只在一侧有的行另一侧为 null）
  const sideKey = side => (side === 'local' ? 'l' : 'c');
  const otherSide = side => (side === 'local' ? 'cloud' : 'local');
  const rowsOfSide = (m, side) => (side === 'local' ? m.L : m.C);

  function isEditable(sheet) {
    const st = diffState;
    return !!(sheet && sheet.view && sheet.view.full && !sheet.view.truncated && sheet.status === 'changed' && !st.recordSheets && !st.busy);
  }

  function modelOf(i) {
    const st = diffState;
    let m = st.models.get(i);
    if (m) return m;
    const sheet = st.data.diff.sheets[i];
    const mk = (src, v) => ({ src, v: [...(v || [])], ed: new Set(), add: false });
    const L = [];
    const C = [];
    const pairs = [];
    for (const r of sheet.view.rows) {
      let l = null;
      let c = null;
      if (r.k === '=') { l = mk(r.l, r.v); c = mk(r.c, r.v); }
      else if (r.k === '~') { l = mk(r.l, r.lv); c = mk(r.c, r.cv); }
      else if (r.k === 'L') l = mk(r.l, r.v);
      else if (r.k === 'C') c = mk(r.c, r.v);
      else continue;
      if (l) L.push(l);
      if (c) C.push(c);
      pairs.push({ l, c });
    }
    // 按主键配对时视图顺序可能和文件顺序不同（行序变化），保存要按文件原顺序写回
    L.sort((a, b) => a.src - b.src);
    C.sort((a, b) => a.src - b.src);
    m = { name: sheet.name, L, C, pairs, dirty: { local: false, cloud: false } };
    st.models.set(i, m);
    return m;
  }

  // 与服务端 sameCell 一致：数字按值比较（1 与 1.0 相同）
  function sameVal(a, b) {
    if (a === b) return true;
    if (a === '' || b === '') return false;
    const x = Number(a);
    const y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  }

  // 编辑模型 → 与服务端同格式的视图（行号按当前位置重排，差异列重新计算）
  function modelView(m) {
    const li = new Map(m.L.map((r, i) => [r, i + 1]));
    const ci = new Map(m.C.map((r, i) => [r, i + 1]));
    const filledL = new Set();
    const filledC = new Set();
    const rows = [];
    let cols = 0;
    m.pairs.forEach((p, x) => {
      const { l, c } = p;
      if (!l && !c) return;
      if (l) { cols = Math.max(cols, l.v.length); l.v.forEach((v, j) => { if (v !== '') filledL.add(j); }); }
      if (c) { cols = Math.max(cols, c.v.length); c.v.forEach((v, j) => { if (v !== '') filledC.add(j); }); }
      if (l && c) {
        const d = [];
        for (let j = 0, n = Math.max(l.v.length, c.v.length); j < n; j++) if (!sameVal(l.v[j] ?? '', c.v[j] ?? '')) d.push(j);
        rows.push({ k: d.length ? '~' : '=', p: x, l: li.get(l), c: ci.get(c), v: l.v, lv: l.v, cv: c.v, d, le: l, ce: c });
      } else if (l) rows.push({ k: 'L', p: x, l: li.get(l), v: l.v, le: l });
      else rows.push({ k: 'C', p: x, c: ci.get(c), v: c.v, ce: c });
    });
    const only = (a, b) => [...a].filter(j => !b.has(j)).sort((x, y) => x - y);
    return { full: true, truncated: false, cols, rows, onlyCols: { local: only(filledL, filledC), cloud: only(filledC, filledL) } };
  }

  // ---------- 右侧：逐行对照 ----------
  // 把视图的行（本地 / 云端）换算成当前左右位置的「旧（左）/ 新（右）」。
  // t：ctx 两边相同 / mod 两边有差异 / del 只在左侧有 / add 只在右侧有（后两种即 Beyond Compare 的孤立行）
  function orientedRows(vs) {
    const oldIsLocal = diffState.oldSide === 'local';
    const out = [];
    for (const r of vs.view.rows) {
      const lo = { n: r.l, v: r.lv ?? r.v, e: r.le };
      const co = { n: r.c, v: r.cv ?? r.v, e: r.ce };
      const O = oldIsLocal ? lo : co;
      const N = oldIsLocal ? co : lo;
      if (r.k === '=') out.push({ t: 'ctx', o: O.n, n: N.n, v: r.v, p: r.p, oe: O.e, ne: N.e });
      else if (r.k === '~') out.push({ t: 'mod', o: O.n, n: N.n, ov: O.v, nv: N.v, d: new Set(r.d), p: r.p, oe: O.e, ne: N.e });
      else if (diffState.recordSheets && !vs.alignedByKey) {
        const local = r.k === 'L';
        out.push({ t: 'ctx', o: oldIsLocal === local ? r.l ?? r.c : null, n: oldIsLocal !== local ? r.l ?? r.c : null, v: r.v });
      }
      else if (r.k === 'L') out.push(oldIsLocal ? { t: 'del', o: r.l, v: r.v, p: r.p, oe: r.le } : { t: 'add', n: r.l, v: r.v, p: r.p, ne: r.le });
      else if (r.k === 'C') out.push(oldIsLocal ? { t: 'add', n: r.c, v: r.v, p: r.p, ne: r.ce } : { t: 'del', o: r.c, v: r.v, p: r.p, oe: r.ce });
      else out.push({ t: 'gap', count: r.n, o: oldIsLocal ? r.l : r.c, n: oldIsLocal ? r.c : r.l, fixed: true });
    }
    return out;
  }

  const isEditedRow = r => !!(r.oe && (r.oe.ed.size || r.oe.add)) || !!(r.ne && (r.ne.ed.size || r.ne.add));

  // 折叠远离改动的相同行（可点击展开）
  function foldRows(rows) {
    const st = diffState;
    if (prefs.allRows) return rows;
    const expanded = st.expanded.get(st.sheet) || new Set();
    const out = [];
    let x = 0;
    while (x < rows.length) {
      if (rows[x].t !== 'ctx' || isEditedRow(rows[x])) { out.push(rows[x]); x++; continue; }
      let y = x;
      while (y < rows.length && rows[y].t === 'ctx' && !isEditedRow(rows[y])) y++;
      const keepHead = x === 0 ? 0 : CONTEXT;
      const keepTail = y === rows.length ? 0 : CONTEXT;
      const from = x + keepHead;
      const to = y - keepTail;
      if (to - from >= MIN_FOLD && !expanded.has(from)) {
        for (let k = x; k < from; k++) out.push(rows[k]);
        out.push({ t: 'gap', count: to - from, o: rows[from].o, n: rows[from].n, key: from });
        for (let k = to; k < y; k++) out.push(rows[k]);
      } else for (let k = x; k < y; k++) out.push(rows[k]);
      x = y;
    }
    return out;
  }

  function keyCol(header) { return header && /^##var$/i.test(String(header[0] || '').trim()) && header.length > 1 ? 1 : 0; }

  function visibleCols(sheet, rows) {
    const all = Array.from({ length: Math.max(1, sheet.view.cols) }, (_, c) => c);
    if (!prefs.onlyCols) return all;
    const set = new Set();
    rows.forEach(r => { if (r.t === 'mod') r.d.forEach(c => set.add(c)); if (r.oe?.ed.size) r.oe.ed.forEach(c => set.add(c)); if (r.ne?.ed.size) r.ne.ed.forEach(c => set.add(c)); });
    const only = sheet.onlyCols;
    if (only) [...only.local, ...only.cloud].forEach(c => { if (c < sheet.view.cols) set.add(c); });
    if (!set.size) return all;
    set.add(keyCol(sheet.header));
    return all.filter(c => set.has(c));
  }

  // 只在一侧有内容的列：按当前方向换算成「旧侧缺 / 新侧缺」（用于斜纹占位）
  function missingCols(sheet) {
    const only = sheet.onlyCols || { local: [], cloud: [] };
    const oldSide = diffState.oldSide;
    const newSide = oldSide === 'local' ? 'cloud' : 'local';
    return { old: new Set(only[newSide]), new: new Set(only[oldSide]) };
  }

  // 列标签直接写「仅本地 / 仅云端」：说「新增 / 删除」要先假定同步方向，
  // 冲突（两边都改过）时本地新加的列会被说成「删除列」，反而误导
  function headHtml(sheet, c, miss) {
    const label = esc(headLabel(sheet, c));
    const only = sheet.onlyCols || { local: [], cloud: [] };
    const side = only.local.includes(c) ? 'local' : only.cloud.includes(c) ? 'cloud' : '';
    if (!side) return label;
    const cls = (side === diffState.newSide) ? 'add' : 'del';
    return `${label}<span class="col-tag ${cls}">仅${SIDE_NAME[side]}</span>`;
  }

  function headLabel(sheet, c) {
    const h = sheet.header && sheet.header[c];
    return h && !/^##/.test(h) ? `${colLetter(c)} · ${h}` : colLetter(c);
  }

  const textWidth = s => { let w = 0; for (const ch of String(s)) { w += ch.charCodeAt(0) > 0x2e80 ? 13 : 7; if (w > 400) break; } return w; };
  function colWidths(sheet, rows, cols) {
    const only = sheet.onlyCols || { local: [], cloud: [] };
    return cols.map(c => {
      let w = textWidth(headLabel(sheet, c)) + (only.local.includes(c) || only.cloud.includes(c) ? 50 : 0);   // 留出「新增列 / 删除列」标签
      for (const r of rows) {
        for (const v of [r.v, r.ov, r.nv]) if (v && v[c]) w = Math.max(w, textWidth(v[c]));
        if (w >= 260) break;
      }
      return Math.max(44, Math.min(280, w + 16));
    });
  }

  // 单元格文本：换行 / 制表符显示成可见符号（否则单行里看不出来）
  // 改动段里的空格也显示出来，避免「只差一个空格 / 换行」时高亮了却看不出差在哪
  // 换行 ↵（\n 或 \r\n）、单独的回车 ␍（\r，Google 表格导出常见）、制表符 ⇥、空格 ·
  const WS_SIGN = { '\t': '⇥', ' ': '·', '\r': '␍' };
  const escWs = (s, re) => esc(s).replace(re, m => `<i class="ws">${WS_SIGN[m] || '↵'}</i>`);
  const escCell = s => escWs(s, /\r\n|\n|\r|\t/g);
  const escMark = s => escWs(s, /\r\n|\n|\r|\t| /g);

  // 单元格里只标出真正变了的那一段（公共前后缀之外）
  function markDiff(a, b) {
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    if (p + s === 0 || p + s >= a.length) return /^\s|\s$/.test(a) ? escMark(a) : escCell(a);
    return `${escCell(a.slice(0, p))}<mark>${escMark(a.slice(p, a.length - s))}</mark>${escCell(a.slice(a.length - s))}`;
  }

  function cellsHtml(vals, cols, hl, other, side, miss, rowObj) {
    let h = '';
    const here = side === 'old' ? diffState.oldSide : diffState.newSide;
    for (const c of cols) {
      if (miss && miss.has(c)) { h += `<td class="nocol" data-c="${c}" title="这一侧没有这一列（整列为空）"></td>`; continue; }
      const v = vals ? vals[c] ?? '' : '';
      const isHl = hl && hl.has(c);
      const isEd = rowObj && rowObj.ed.has(c);
      const o = other ? other[c] ?? '' : '';
      const title = isHl ? `${SIDE_NAME[here]}：${v || '（空）'}\n${SIDE_NAME[otherSide(here)]}：${o || '（空）'}` : v;
      const cls = [isHl && 'hl', isEd && 'ed'].filter(Boolean).join(' ');
      h += `<td data-c="${c}"${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${isHl && v && o ? markDiff(v, o) : escCell(v)}</td>`;
    }
    return h;
  }

  // 行内「复制到另一侧」箭头（只在有差异的行显示）：左侧 →、右侧 ←
  function arrowHtml(r, side, edit) {
    if (!edit || r.p == null || !(r.t === 'mod' || r.t === 'add' || r.t === 'del')) return '';
    const from = side === 'old' ? diffState.oldSide : diffState.newSide;
    const to = otherSide(from);
    const what = r.t === 'mod' ? `用这一行的${SIDE_NAME[from]}内容覆盖${SIDE_NAME[to]}`
      : (r.t === 'del') === (side === 'old') ? `把这一行复制到${SIDE_NAME[to]}` : `在${SIDE_NAME[to]}删除这一行`;
    return `<button type="button" class="cp" data-side="${side}" title="${what}">${side === 'old' ? '→' : '←'}</button>`;
  }

  // 改动行分组：连续的改动（修改 / 新增 / 删除）算一处，用于上下跳转和右侧标尺
  function groupRows(rows) {
    let g = -1;
    let inChange = false;
    for (const r of rows) {
      const chg = r.t === 'mod' || r.t === 'add' || r.t === 'del' || isEditedRow(r);
      if (chg && !inChange) g++;
      inChange = chg;
      r.g = chg ? g : -1;
    }
    return g + 1;
  }

  function gapText(r) {
    if (activeSheets(diffState)[diffState.sheet]?.orderChanged) return `⋯ ${r.fixed ? '' : '展开 '}${r.count} 行相同内容`;
    const range = (a, n) => (a == null ? '' : n > 1 ? `${a}–${a + n - 1}` : `${a}`);
    return `⋯ ${r.fixed ? '' : '展开 '}${r.count} 行相同内容（− ${range(r.o, r.count)} / + ${range(r.n, r.count)}）${r.fixed ? '：表太大，未加载' : ''}`;
  }

  const SHORT = { local: '本', cloud: '云' };
  function unifiedHtml(sheet, rows, cols, widths) {
    const total = 44 * 2 + 22 + widths.reduce((a, b) => a + b, 0);
    let h = `<table class="dg" style="width:${total}px"><colgroup><col style="width:44px"><col style="width:44px"><col style="width:22px">`;
    widths.forEach(w => { h += `<col style="width:${w}px">`; });
    h += `</colgroup><thead><tr><th class="gut g1">${SIDE_NAME[diffState.oldSide]}</th><th class="gut g2">${SIDE_NAME[diffState.newSide]}</th><th class="sign s3"></th>`;
    const miss = missingCols(sheet);
    const so = SHORT[diffState.oldSide];
    const sn = SHORT[diffState.newSide];
    cols.forEach(c => { h += `<th title="${esc(headLabel(sheet, c))}">${headHtml(sheet, c, miss)}</th>`; });
    h += '</tr></thead><tbody>';
    rows.forEach((r, x) => {
      const g = r.g >= 0 ? ` data-g="${r.g}"` : '';
      if (r.t === 'ctx') h += `<tr><td class="gut g1">${r.o ?? ''}</td><td class="gut g2">${r.n ?? ''}</td><td class="sign s3"></td>${cellsHtml(r.v, cols)}</tr>`;
      else if (r.t === 'del') h += `<tr class="orph"${g}><td class="gut g1">${r.o}</td><td class="gut g2"></td><td class="sign s3">${so}</td>${cellsHtml(r.v, cols, null, null, 'old', miss.old, r.oe)}</tr>`;
      else if (r.t === 'add') h += `<tr class="orph"${g}><td class="gut g1"></td><td class="gut g2">${r.n}</td><td class="sign s3">${sn}</td>${cellsHtml(r.v, cols, null, null, 'new', miss.new, r.ne)}</tr>`;
      else if (r.t === 'mod') {
        h += `<tr class="mod"${g}><td class="gut g1">${r.o}</td><td class="gut g2"></td><td class="sign s3">${so}</td>${cellsHtml(r.ov, cols, r.d, r.nv, 'old', miss.old, r.oe)}</tr>`;
        h += `<tr class="mod mod2"${g}><td class="gut g1"></td><td class="gut g2">${r.n}</td><td class="sign s3">${sn}</td>${cellsHtml(r.nv, cols, r.d, r.ov, 'new', miss.new, r.ne)}</tr>`;
      } else h += `<tr class="gap${r.fixed ? ' fixed' : ''}" data-x="${x}"><td class="gut g1">⋯</td><td class="gut g2">⋯</td><td class="sign s3"></td><td colspan="${cols.length}"><span class="gap-text">${gapText(r)}</span></td></tr>`;
    });
    return `${h}</tbody></table>`;
  }

  // 并排：左旧右新，每一行在两边一一对应（缺的一边用斜纹占位）
  function splitHtml(sheet, rows, cols, widths, side, edit) {
    const total = 44 + 22 + widths.reduce((a, b) => a + b, 0);
    let h = `<table class="dg" style="width:${total}px"><colgroup><col style="width:44px"><col style="width:22px">`;
    widths.forEach(w => { h += `<col style="width:${w}px">`; });
    h += `</colgroup><thead><tr><th class="gut g1">#</th><th class="sign s2"></th>`;
    const miss = missingCols(sheet);
    const sideMiss = miss[side];
    cols.forEach(c => { h += `<th title="${esc(headLabel(sheet, c))}">${headHtml(sheet, c, miss)}</th>`; });
    h += '</tr></thead><tbody>';
    // 缺这一行的一侧画斜纹占位（Beyond Compare 的孤立行对面也是空的）
    const fill = (r, attrs) => `<tr class="fill${r.t === 'add' || r.t === 'del' ? ' orph-gap' : ''}"${attrs}><td class="gut g1"></td><td class="sign s2">${arrowHtml(r, side, edit)}</td><td colspan="${cols.length}" data-c="${cols[0] ?? 0}"></td></tr>`;
    rows.forEach((r, x) => {
      const attrs = `${r.g >= 0 ? ` data-g="${r.g}"` : ''}${r.p != null ? ` data-p="${r.p}"` : ''}`;
      const no = side === 'old' ? r.o : r.n;
      const obj = side === 'old' ? r.oe : r.ne;
      const added = obj && obj.add ? ' ed-row' : '';
      const line = (cls, vals, hl, other) => `<tr class="${cls}${added}"${attrs}><td class="gut g1">${no}</td><td class="sign s2">${arrowHtml(r, side, edit)}</td>${cellsHtml(vals, cols, hl, other, side, sideMiss, obj)}</tr>`;
      if (r.t === 'ctx') h += no == null ? fill(r, attrs) : line('', r.v);
      else if (r.t === 'del') h += side === 'old' ? line('orph', r.v) : fill(r, attrs);
      else if (r.t === 'add') h += side === 'new' ? line('orph', r.v) : fill(r, attrs);
      else if (r.t === 'mod') h += side === 'old' ? line('mod', r.ov, r.d, r.nv) : line('mod', r.nv, r.d, r.ov);
      else h += `<tr class="gap${r.fixed ? ' fixed' : ''}" data-x="${x}"><td class="gut g1">⋯</td><td class="sign s2"></td><td colspan="${cols.length}"><span class="gap-text">${gapText(r)}</span></td></tr>`;
    });
    return `${h}</tbody></table>`;
  }

  function paneJumpControl(actualSide, st) {
    if (actualSide === 'local') {
      const btn = el('button', 'diff-pane-jump');
      btn.type = 'button';
      const exists = st.data?.local?.exists !== false;
      btn.title = exists ? '在访达中显示本地文件' : '本地还没有该文件，点击打开所在目录';
      const icon = el('span', 'diff-pane-jump-icon');
      icon.innerHTML = window.CSMIcons?.folder || '📁';
      btn.append(icon, el('span', null, exists ? '在访达中显示' : '打开所在目录'));
      btn.addEventListener('click', async () => {
        const res = await CSM().revealLocal(st.path);
        if (!res) setMsg(d.msg, '打开本地位置失败，请查看底部日志。', 'error');
        else if (!res.exact) setMsg(d.msg, `本地还没有 ${st.path}，已打开所在目录`);
      });
      return btn;
    }
    const spreadsheetId = st.data?.cloud?.spreadsheetId || CSM().tableRow(st.path)?.spreadsheetId;
    if (!spreadsheetId) return null;
    const link = el('a', 'diff-pane-jump');
    link.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = '在新标签页打开云端 Google 表格';
    const icon = el('span', 'diff-pane-jump-icon');
    icon.innerHTML = window.CSMIcons?.external || '↗';
    link.append(icon, el('span', null, '打开云端表'));
    return link;
  }

  let panes = [];
  function renderSheet() {
    const st = diffState;
    const sheet = activeSheets(st)[st.sheet];
    d.view.innerHTML = '';
    d.ruler.innerHTML = '';
    st.groups = [];
    st.cur = -1;
    panes = [];
    if (!sheet || !sheet.view) {
      const box = el('div', 'diff-loading');
      if (st.data.diff.identical) box.appendChild(el('div', 'diff-same-big', '✓ 两边内容完全一致'));
      box.appendChild(el('div', null, sheet ? `工作表「${sheet.name}」两边一致 · ${sheet.localRows} 行` : '没有工作表'));
      d.view.appendChild(box);
      updatePos();
      return;
    }
    const edit = isEditable(sheet);
    const view = edit ? modelView(modelOf(st.sheet)) : sheet.view;
    const vs = { ...sheet, view, onlyCols: view.onlyCols || sheet.onlyCols };
    st.editing = edit && prefs.mode === 'split';
    const oriented = orientedRows(vs);
    const rows = st.recordSheets ? oriented : foldRows(oriented);
    const groupCount = groupRows(rows);
    const cols = visibleCols(vs, rows);
    const widths = colWidths(vs, rows, cols);
    st.rows = rows;
    let scrollTimer = 0;
    const markScrolling = () => {
      panes.forEach(q => q.classList.add('is-scrolling'));
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => panes.forEach(q => q.classList.remove('is-scrolling')), 900);
    };
    if (prefs.mode === 'split') {
      const wrap = el('div', 'diff-split');
      for (const side of ['old', 'new']) {
        const actualSide = side === 'old' ? st.oldSide : st.newSide;
        const pane = el('div', `diff-pane ${side}`);
        const label = el('div', 'diff-pane-label');
        const title = el('span', 'diff-pane-title');
        title.append(el('b', null, side === 'old' ? '左' : '右'), ` ${SIDE_NAME[actualSide]}`);
        label.append(title);
        const jump = paneJumpControl(actualSide, st);
        if (jump) label.append(jump);
        const scroller = el('div', 'diff-scroll');
        scroller.innerHTML = splitHtml(vs, rows, cols, widths, side, st.editing);
        scroller.dataset.side = side;
        if (st.editing) scroller.classList.add('editing');
        pane.append(label, scroller);
        wrap.appendChild(pane);
        panes.push(scroller);
      }
      d.view.appendChild(wrap);
      // 两侧滚动同步：只让用户正在拖的一侧带动另一侧。程序设置另一侧位置后记下目标值，
      // 那一侧随后（往往晚一帧）触发的 scroll 事件若正好停在目标值就忽略 —— 原来用一帧的锁，
      // 锁过期后回声事件又把正在拖的一侧拉回旧位置，两侧来回拉扯，拖横向滑块时画面闪动
      panes.forEach(p => p.addEventListener('scroll', () => {
        markScrolling();
        const echo = p._syncTo;
        p._syncTo = null;
        if (echo && Math.abs(p.scrollTop - echo.top) < 1 && Math.abs(p.scrollLeft - echo.left) < 1) return;
        for (const q of panes) {
          if (q === p) continue;
          const before = { top: q.scrollTop, left: q.scrollLeft };
          q.scrollTop = p.scrollTop;
          q.scrollLeft = p.scrollLeft;
          if (q.scrollTop !== before.top || q.scrollLeft !== before.left) q._syncTo = { top: q.scrollTop, left: q.scrollLeft };
        }
        scheduleViewport();
      }));
    } else {
      const scroller = el('div', 'diff-scroll');
      scroller.innerHTML = unifiedHtml(vs, rows, cols, widths);
      d.view.appendChild(scroller);
      panes.push(scroller);
      scroller.addEventListener('scroll', () => {
        markScrolling();
        scheduleViewport();
      });
    }
    for (const p of panes) p.addEventListener('click', onViewClick);
    const notes = [];
    if (sheet.orderChanged) notes.push('已有记录的行序发生变化，两侧行号保留原位置。');
    if (st.recordSheets && !sheet.alignedByKey) notes.push('这个工作表无法按唯一主键配对，匹配项按两侧分别列出。');
    if (st.recordSheets && sheet.matches > sheet.view.rows.length) notes.push(`当前显示前 ${sheet.view.rows.length} 条匹配。`);
    if (sheet.view.truncated) notes.push('改动太多，只显示前 2000 处；完整内容请直接打开两边文件比较。不能在这里编辑。');
    if (!sheet.view.full) notes.push('表很大，相同的行只保留改动前后几行，无法展开，也不能在这里编辑。');
    if (edit && prefs.mode !== 'split') notes.push('切换到「并排」可以编辑：选中单元格 / 行后复制到另一侧。');
    const colNote = (list, what) => {
      if (!list.length) return;
      const blank = list.filter(c => !String(vs.header?.[c] ?? '').trim());
      notes.push(`${what} ${list.length} 列：${list.map(colLetter).join('、')}${blank.length ? `（其中 ${blank.map(colLetter).join('、')} 的表头为空）` : ''}。`);
    };
    const only = vs.onlyCols || { local: [], cloud: [] };
    colNote(only.local, '只有本地有');
    colNote(only.cloud, '只有云端有');
    if (prefs.onlyCols && cols.length < view.cols) notes.push(`已隐藏 ${view.cols - cols.length} 个没有改动的列。`);
    if (notes.length) d.view.appendChild(el('div', 'diff-note', notes.join(' ')));
    st.groups = Array.from({ length: groupCount }, (_, g) => g);
    requestAnimationFrame(drawRuler);
    paintSelection();
    updatePos();
    updateEditBar();
  }

  function onViewClick(e) {
    const tr = e.target.closest('tr.gap');
    if (!tr || tr.classList.contains('fixed')) return;
    const st = diffState;
    const r = st.rows[Number(tr.dataset.x)];
    if (!r || r.key == null) return;
    if (!st.expanded.has(st.sheet)) st.expanded.set(st.sheet, new Set());
    st.expanded.get(st.sheet).add(r.key);
    const top = panes[0].scrollTop;
    const left = panes[0].scrollLeft;
    renderSheet();
    panes.forEach(p => { p.scrollTop = top; p.scrollLeft = left; });
  }

  // ---------- 右侧标尺：整张表的改动分布 + 当前可视范围 ----------
  function drawRuler() {
    const st = diffState;
    d.ruler.innerHTML = '';
    if (!st || !panes.length) return;
    const table = panes[0].querySelector('table');
    if (!table) return;
    const total = table.offsetHeight || 1;
    const H = d.ruler.clientHeight;
    const marks = new Map();
    for (const tr of table.querySelectorAll('tr[data-g]')) {
      const g = Number(tr.dataset.g);
      const m = marks.get(g) || { top: tr.offsetTop, bottom: 0, add: false, del: false };
      m.bottom = tr.offsetTop + tr.offsetHeight;
      if (tr.classList.contains('add')) m.add = true;
      if (tr.classList.contains('del')) m.del = true;
      if (tr.classList.contains('fill')) { /* 并排的占位行：看另一边 */ }
      marks.set(g, m);
    }
    // 并排模式下左边只有删除 / 占位，用行模型判断类型更准
    const kind = new Map();
    for (const r of st.rows) if (r.g >= 0) { const k = kind.get(r.g) || new Set(); k.add(r.t); kind.set(r.g, k); }
    for (const [g, m] of marks) {
      const k = kind.get(g) || new Set();
      const cls = k.has('mod') || (k.has('add') && k.has('del')) ? 'mod' : 'orph';
      const mk = el('div', `rk ${cls}`);
      mk.style.top = `${(m.top / total) * H}px`;
      mk.style.height = `${Math.max(3, ((m.bottom - m.top) / total) * H)}px`;
      mk.dataset.g = g;
      d.ruler.appendChild(mk);
    }
    d.ruler.appendChild(el('div', 'rk-view'));
    drawViewport();
  }

  // 滚动时标尺上的可视范围框每帧最多重画一次
  let viewportFrame = 0;
  function scheduleViewport() {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(() => { viewportFrame = 0; drawViewport(); });
  }

  function drawViewport() {
    const vp = d.ruler.querySelector('.rk-view');
    if (!vp || !panes.length) return;
    const p = panes[0];
    const H = d.ruler.clientHeight;
    const total = p.scrollHeight || 1;
    vp.style.top = `${(p.scrollTop / total) * H}px`;
    vp.style.height = `${Math.max(6, (p.clientHeight / total) * H)}px`;
  }

  d.ruler.addEventListener('click', e => {
    if (!panes.length) return;
    const mk = e.target.closest('.rk[data-g]');
    if (mk) { goTo(Number(mk.dataset.g)); return; }
    const p = panes[0];
    const frac = (e.clientY - d.ruler.getBoundingClientRect().top) / d.ruler.clientHeight;
    p.scrollTop = frac * p.scrollHeight - p.clientHeight / 2;
  });
  window.addEventListener('resize', () => { if (diffState && diffState.data) drawRuler(); });

  // ---------- 上一处 / 下一处 ----------
  function goTo(g) {
    const st = diffState;
    if (!st || g < 0 || g >= st.groups.length) return;
    st.cur = g;
    for (const p of panes) {
      p.querySelectorAll('tr.cur').forEach(tr => tr.classList.remove('cur'));
      p.querySelectorAll(`tr[data-g="${g}"]`).forEach(tr => tr.classList.add('cur'));
    }
    const first = panes[0].querySelector(`tr[data-g="${g}"]`);
    if (first) panes[0].scrollTop = Math.max(0, first.offsetTop - panes[0].clientHeight / 3);
    updatePos();
  }

  function step(dir) {
    const st = diffState;
    if (!st || !st.data) return;
    const target = st.cur + dir;
    if (target >= 0 && target < st.groups.length) { goTo(target); return; }
    // 跨到上 / 下一个有差异的工作表
    const sheets = activeSheets(st);
    for (let i = st.sheet + dir; i >= 0 && i < sheets.length; i += dir) {
      if (sheets[i].status === 'same') continue;
      selectSheet(i, { jump: dir > 0 ? 'first' : 'last' });
      return;
    }
  }

  function updatePos() {
    const st = diffState;
    const n = st && st.groups ? st.groups.length : 0;
    d.pos.textContent = n ? (st.cur >= 0 ? `第 ${st.cur + 1} / ${n} 处` : `共 ${n} 处改动`) : '';
    const sheets = st && st.data ? activeSheets(st) : [];
    const hasPrevSheet = sheets.slice(0, st ? st.sheet : 0).some(s => s.status !== 'same');
    const hasNextSheet = sheets.slice(st ? st.sheet + 1 : 0).some(s => s.status !== 'same');
    d.prev.disabled = !(st && (st.cur > 0 || hasPrevSheet));
    d.next.disabled = !(st && (st.cur < n - 1 || hasNextSheet));
  }

  d.prev.addEventListener('click', () => step(-1));
  d.next.addEventListener('click', () => step(1));
  d.seg.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (!b || !diffState || !diffState.data) return;
    prefs.mode = b.dataset.v;
    setPref(PREF.mode, prefs.mode);
    syncToolbar();
    renderSheet();
  });
  d.onlyCols.addEventListener('change', () => {
    prefs.onlyCols = d.onlyCols.checked;
    setPref(PREF.onlyCols, prefs.onlyCols ? '1' : '0');
    if (diffState && diffState.data) renderSheet();
  });
  d.allRows.addEventListener('change', () => {
    prefs.allRows = d.allRows.checked;
    setPref(PREF.allRows, prefs.allRows ? '1' : '0');
    if (diffState && diffState.data) renderSheet();
  });
  d.swap.addEventListener('click', () => {
    const st = diffState;
    if (!st || !st.data) return;
    [st.oldSide, st.newSide] = [st.newSide, st.oldSide];
    st.expanded = new Map();
    renderAll();
  });

  function updateButtons() {
    const st = diffState;
    const { data, busy, stale, mode } = st;
    const choice = needsDirectionChoice(mode);
    const allowUpload = CSM().allowUpload();
    const createLocal = data && !data.local.exists;
    const reviewedDownload = data?.downloadVersion?.reviewed === true;
    const choiceReason = mode === 'review' ? '没有同步基准' : '两边都改过';
    const choicePrompt = allowUpload ? '请选择保留哪一侧' : '请核对内容后确认下载';
    d.direction.textContent = data?.diff?.identical
      ? '两边内容完全一致，请点击「云端 → 覆盖本地」记录同步状态。'
      : (choice ? `${choiceReason}，${choicePrompt}。` : '选择同步方向');
    d.dl.textContent = createLocal ? '云端 → 创建本地文件' : '云端 → 覆盖本地';
    d.dlHint.textContent = createLocal ? '当前没有本地文件' : '覆盖前自动备份，可在列表的「本地备份」恢复';
    d.dl.disabled = !!busy || !!stale || !reviewedDownload;
    d.record.disabled = d.findSubmit.disabled = d.findClear.disabled = !!busy || !data;
    d.ul.disabled = !!busy || !!stale || !allowUpload || !data?.local.exists;
    d.ulAction.classList.toggle('hidden', !allowUpload);
    d.refresh.classList.toggle('hidden', !stale && !(data && !reviewedDownload));
    const incoming = data ? incomingSide() : null;
    d.dl.classList.toggle('diff-primary', !!data && (!choice || data.diff.identical) && (incoming === 'cloud' || data.diff.identical));
    d.ul.classList.toggle('diff-primary', !!data && !choice && incoming === 'local' && !data.diff.identical);
    d.close.disabled = d.cancel.disabled = !!busy;
    for (const b of [d.swap, d.prev, d.next, d.onlyCols, d.allRows]) if (!data) b.disabled = true; else if (b !== d.prev && b !== d.next) b.disabled = false;
    if (data) updatePos();
    updateEditBar();
  }

  function confirmOverwrite(st, button, hint) {
    if (!needsDirectionChoice(st.mode) || ((st.mode === 'conflict' || st.mode === 'review') && st.data.diff.identical)) return true;
    return confirm(`${button.textContent}？\n\n${st.path}\n\n${hint.textContent}。`);
  }

  function startDiffOperation(st, message) {
    st.busy = true;
    d.modal.focus();
    updateButtons();
    setMsg(d.msg, message);
  }

  async function doDownload() {
    const st = diffState;
    if (!st?.data || d.dl.disabled || !confirmLoseEdits('整表覆盖') || !confirmOverwrite(st, d.dl, d.dlHint)) return;
    startDiffOperation(st, '下载中…');
    try {
      const summary = await CSM().downloadPaths([st.path], { expected: st.data.downloadVersion });
      if (diffState !== st) return;
      if (summary?.successCount) { finishDiff('downloaded'); return; }
      const result = summary?.results?.[0];
      st.stale = !!result?.skipped;
      const detail = result?.error || summary?.error || (st.stale ? '预览版本已变更' : '详情见日志');
      setMsg(d.msg, `${st.stale ? '已跳过下载' : '下载失败'}：${detail}`, 'error');
    } catch (err) {
      if (diffState === st) setMsg(d.msg, `下载失败：${err.message}`, 'error');
    } finally {
      if (diffState === st) {
        st.busy = false;
        updateButtons();
        if (st.stale) d.refresh.focus();
      }
    }
  }

  async function doUpload() {
    const st = diffState;
    if (!st?.data || d.ul.disabled || !CSM().allowUpload() || !confirmLoseEdits('整表覆盖') || !confirmOverwrite(st, d.ul, d.ulHint)) return;
    startDiffOperation(st, '上传中…');
    // expect：以这次差异预览看到的云端版本为准；之后云端若又被改，服务端会拒绝（409）
    const r = await CSM().uploadRequest(st.path, { expect: st.data.cloud.modifiedTime });
    if (diffState !== st) return;
    st.busy = false;
    if (r.ok) { finishDiff('uploaded'); return; }
    if (r.status === 409 && r.data.error === 'CLOUD_CHANGED') {
      st.stale = true;
      const who = r.data.cloudModifiedBy ? `「${r.data.cloudModifiedBy}」` : '其他人';
      setMsg(d.msg, `云端在 ${fmt(r.data.cloudModifiedTime)} 被${who}修改过（晚于这次差异预览），已取消上传`, 'error');
      if (confirm(`你查看差异之后，云端又被${who}修改了（${fmt(r.data.cloudModifiedTime)}）。\n\n直接上传会覆盖这次修改，已取消上传。\n现在重新比较差异吗？`)) {
        await loadDiff({ force: true });
        return;
      }
    } else if (r.status === 409 && r.data.error === 'NEEDS_WRITE_THROUGH') {
      setMsg(d.msg, '已取消：该表是公式镜像，全部覆盖需要写回源表，未写入任何内容', 'error');
    } else {
      setMsg(d.msg, `上传失败：${r.data.error || r.status}`, 'error');
    }
    updateButtons();
    if (st.stale) d.refresh.focus();
  }

  // ======================= 编辑：选择 / 复制到另一侧 / 撤销 / 保存 =======================
  // 选择以「行对 × 列」为单位：sel = { a: { p, c }, b: { p, c }, rows }（p = 行对下标，c = 列；rows = 整行选择）
  // 两侧窗格同步高亮同一块区域；「复制到右侧 / 左侧」把选中区域里一侧的内容写到另一侧。
  const anyDirty = st => !!st?.models && [...st.models.values()].some(m => m.dirty.local || m.dirty.cloud);
  const dirtySides = st => ({
    local: !!st?.models && [...st.models.values()].some(m => m.dirty.local),
    cloud: !!st?.models && [...st.models.values()].some(m => m.dirty.cloud)
  });

  function selRange(sel) {
    const p0 = Math.min(sel.a.p, sel.b.p);
    const p1 = Math.max(sel.a.p, sel.b.p);
    if (sel.rows || sel.a.c == null || sel.b.c == null) return { p0, p1, cols: null };
    return { p0, p1, cols: [Math.min(sel.a.c, sel.b.c), Math.max(sel.a.c, sel.b.c)] };
  }

  function paintSelection() {
    const st = diffState;
    for (const pane of panes) {
      pane.querySelectorAll('.sel, .sel-row').forEach(n => n.classList.remove('sel', 'sel-row'));
    }
    if (!st?.sel || !st.editing) return;
    const { p0, p1, cols } = selRange(st.sel);
    for (const pane of panes) {
      for (const tr of pane.querySelectorAll('tr[data-p]')) {
        const p = Number(tr.dataset.p);
        if (p < p0 || p > p1) continue;
        if (!cols) { tr.classList.add('sel-row'); continue; }
        for (const td of tr.querySelectorAll('td[data-c]')) {
          const c = Number(td.dataset.c);
          if (td.colSpan > 1 || (c >= cols[0] && c <= cols[1])) td.classList.add('sel');
        }
      }
    }
  }

  function cloneModel(m) {
    const map = new Map();
    const cr = r => {
      if (!r) return null;
      if (!map.has(r)) map.set(r, { src: r.src, v: [...r.v], ed: new Set(r.ed), add: r.add });
      return map.get(r);
    };
    return { name: m.name, L: m.L.map(cr), C: m.C.map(cr), pairs: m.pairs.map(p => ({ l: cr(p.l), c: cr(p.c) })), dirty: { ...m.dirty } };
  }

  const trimRow = r => { while (r.v.length && r.v[r.v.length - 1] === '') r.v.pop(); };

  // 一对行上，把 from 侧的内容写到 to 侧；cols 为 null 时整行。返回是否有改动
  function applyCopy(m, x, from, to, cols) {
    const pair = m.pairs[x];
    if (!pair) return false;
    const S = pair[sideKey(from)];
    const D = pair[sideKey(to)];
    if (!S && !D) return false;
    const target = rowsOfSide(m, to);
    if (S && D) {
      const n = Math.max(S.v.length, D.v.length);
      const a = cols ? cols[0] : 0;
      const b = cols ? Math.min(cols[1], n - 1) : n - 1;
      let changed = false;
      for (let j = a; j <= b; j++) {
        const v = S.v[j] ?? '';
        if ((D.v[j] ?? '') === v) continue;
        while (D.v.length <= j) D.v.push('');
        D.v[j] = v;
        D.ed.add(j);
        changed = true;
      }
      trimRow(D);
      return changed;
    }
    if (S) {
      // 只在 from 侧有：在 to 侧插入整行，位置跟在视图里上一行对应的 to 侧行后面
      let at = 0;
      for (let y = x - 1; y >= 0; y--) {
        const prev = m.pairs[y][sideKey(to)];
        if (prev) { at = target.indexOf(prev) + 1; break; }
      }
      const row = { src: null, v: [...S.v], ed: new Set(S.v.map((_, j) => j)), add: true };
      target.splice(at, 0, row);
      pair[sideKey(to)] = row;
      return true;
    }
    // 只在 to 侧有：from 侧是空的 —— 复制过去就是在 to 侧删掉这一行
    target.splice(target.indexOf(D), 1);
    pair[sideKey(to)] = null;
    return true;
  }

  function copySelection(fromPane) {
    const st = diffState;
    if (!st?.editing || !st.sel || st.busy) return;
    const from = fromPane === 'old' ? st.oldSide : st.newSide;
    const to = otherSide(from);
    const m = modelOf(st.sheet);
    const before = cloneModel(m);
    const { p0, p1, cols } = selRange(st.sel);
    let changed = false;
    for (let x = p0; x <= p1; x++) changed = applyCopy(m, x, from, to, cols) || changed;
    if (!changed) { setMsg(d.msg, '选中范围里两边已经一样，没有可复制的内容'); return; }
    st.undo.push({ sheet: st.sheet, model: before });
    m.dirty[to] = true;
    setMsg(d.msg, `已把${SIDE_NAME[from]}的选中内容复制到${SIDE_NAME[to]}（未保存）`);
    rerenderKeepScroll();
  }

  function undoEdit() {
    const st = diffState;
    if (!st?.undo?.length || st.busy) return;
    const last = st.undo.pop();
    st.models.set(last.sheet, last.model);
    if (st.sheet !== last.sheet) { st.sheet = last.sheet; renderTree(); }
    setMsg(d.msg, '已撤销');
    rerenderKeepScroll();
  }

  function rerenderKeepScroll() {
    const top = panes[0]?.scrollTop || 0;
    const left = panes[0]?.scrollLeft || 0;
    renderMeta();
    renderTree();
    renderSheet();
    panes.forEach(p => { p.scrollTop = top; p.scrollLeft = left; });
    updateButtons();
  }

  // ---------- 鼠标：拖选单元格 / 点行号选整行 / Shift 扩展 ----------
  let dragging = false;
  function hitOf(e) {
    const st = diffState;
    if (!st?.editing) return null;
    const tr = e.target.closest('tr[data-p]');
    if (!tr || !d.view.contains(tr)) return null;
    const p = Number(tr.dataset.p);
    const gut = e.target.closest('td.gut, td.sign');
    const td = e.target.closest('td[data-c]');
    return { p, c: gut || !td ? null : Number(td.dataset.c), row: !!gut };
  }

  d.view.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('button.cp')) return;
    const hit = hitOf(e);
    if (!hit) return;
    const st = diffState;
    e.preventDefault();
    if (e.shiftKey && st.sel) st.sel = { a: st.sel.a, b: { p: hit.p, c: hit.c ?? st.sel.b.c }, rows: st.sel.rows || hit.row };
    else st.sel = { a: { p: hit.p, c: hit.c }, b: { p: hit.p, c: hit.c }, rows: hit.row };
    dragging = true;
    paintSelection();
    updateEditBar();
  });
  d.view.addEventListener('mousemove', e => {
    if (!dragging) return;
    const hit = hitOf(e);
    const st = diffState;
    if (!hit || !st.sel) return;
    const b = { p: hit.p, c: st.sel.rows ? null : (hit.c ?? st.sel.b.c) };
    if (b.p === st.sel.b.p && b.c === st.sel.b.c) return;
    st.sel.b = b;
    paintSelection();
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // 行内箭头：选中这一行并复制到另一侧
  d.view.addEventListener('click', e => {
    const btn = e.target.closest('button.cp');
    if (!btn) return;
    const tr = btn.closest('tr[data-p]');
    const st = diffState;
    if (!tr || !st?.editing) return;
    const p = Number(tr.dataset.p);
    st.sel = { a: { p, c: null }, b: { p, c: null }, rows: true };
    copySelection(btn.dataset.side);
  });

  // ---------- 右键菜单 ----------
  const ctxMenu = el('div', 'diff-ctx hidden');
  document.body.appendChild(ctxMenu);
  const hideCtx = () => ctxMenu.classList.add('hidden');
  d.view.addEventListener('contextmenu', e => {
    const hit = hitOf(e);
    const st = diffState;
    if (!hit) return;
    e.preventDefault();
    const inSel = st.sel && (() => {
      const { p0, p1, cols } = selRange(st.sel);
      return hit.p >= p0 && hit.p <= p1 && (!cols || hit.c == null || (hit.c >= cols[0] && hit.c <= cols[1]));
    })();
    if (!inSel) { st.sel = { a: { p: hit.p, c: hit.c }, b: { p: hit.p, c: hit.c }, rows: hit.row }; paintSelection(); updateEditBar(); }
    ctxMenu.innerHTML = '';
    const item = (text, fn, disabled) => {
      const b = el('button', null, text);
      b.type = 'button';
      b.disabled = !!disabled;
      b.addEventListener('click', () => { hideCtx(); fn(); });
      ctxMenu.appendChild(b);
    };
    item(`复制到右侧（${SIDE_NAME[st.oldSide]} → ${SIDE_NAME[st.newSide]}）`, () => copySelection('old'));
    item(`复制到左侧（${SIDE_NAME[st.newSide]} → ${SIDE_NAME[st.oldSide]}）`, () => copySelection('new'));
    item('撤销', undoEdit, !st.undo.length);
    ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 260)}px`;
    ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 120)}px`;
    ctxMenu.classList.remove('hidden');
  });
  document.addEventListener('mousedown', e => { if (!ctxMenu.contains(e.target)) hideCtx(); });
  window.addEventListener('blur', hideCtx);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtx(); }, true);

  // ---------- 工具栏 / 底部按钮状态 ----------
  function updateEditBar() {
    const st = diffState;
    const sheet = st?.data ? activeSheets(st)[st.sheet] : null;
    const edit = !!st?.data && isEditable(sheet) && prefs.mode === 'split';
    d.editTools.classList.toggle('hidden', !edit);
    if (edit) {
      d.copyRight.textContent = `复制到右侧 →`;
      d.copyLeft.textContent = `← 复制到左侧`;
      d.copyRight.title = `把选中范围从左侧（${SIDE_NAME[st.oldSide]}）复制到右侧（${SIDE_NAME[st.newSide]}）（⌥→）`;
      d.copyLeft.title = `把选中范围从右侧（${SIDE_NAME[st.newSide]}）复制到左侧（${SIDE_NAME[st.oldSide]}）（⌥←）`;
      d.copyRight.disabled = d.copyLeft.disabled = !st.sel || !!st.busy;
      d.undo.disabled = !st.undo?.length || !!st.busy;
    }
    const sides = dirtySides(st);
    const dirty = sides.local || sides.cloud;
    d.saveActions.classList.toggle('hidden', !dirty);
    d.saveLocal.disabled = !sides.local || !!st?.busy;
    d.saveCloud.disabled = !sides.cloud || !!st?.busy || !CSM().allowUpload();
    d.saveLocal.classList.toggle('diff-primary', sides.local);
    d.saveCloud.classList.toggle('diff-primary', sides.cloud);
    d.discard.disabled = !!st?.busy;
    d.saveStatus.textContent = dirty ? `有未保存的编辑：${[sides.local && '本地', sides.cloud && '云端'].filter(Boolean).join('、')}` : '';
  }

  // ---------- 保存 ----------
  async function saveSide(side, extra = {}) {
    const st = diffState;
    if (!st?.data || st.busy) return;
    const models = [...st.models.values()].filter(m => m.dirty[side]);
    if (!models.length) return;
    if (side === 'cloud' && !extra.confirmed) {
      if (!confirm(`把编辑后的内容写入云端表格？\n\n${st.path}\n\n只写入有改动的单元格（有公式的表保留公式）；可在 Google 表格的「文件 → 版本历史」恢复。`)) return;
      extra = { ...extra, confirmed: true };
    }
    const sheets = models.map(m => ({ name: m.name, rows: rowsOfSide(m, side).map(r => ({ src: r.src, v: r.v })) }));
    startDiffOperation(st, side === 'local' ? '正在保存本地文件…' : '正在写入云端…');
    let resp;
    let data;
    try {
      resp = await fetch(CSM().api('/merge/save'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: st.path, side, sheets,
          expect: { localVersion: st.data.downloadVersion?.localVersion, cloudModifiedTime: st.data.cloud.modifiedTime },
          ignoreLock: !!extra.ignoreLock, writeThrough: !!extra.writeThrough
        })
      });
      data = await resp.json().catch(() => ({}));
    } catch (err) {
      resp = { ok: false, status: 0 };
      data = { error: err.message };
    }
    if (diffState !== st) return;
    st.busy = false;
    if (resp.status === 423 && data.error === 'FILE_LOCKED') {
      updateButtons();
      if (confirm(`${data.message}\n\n仍然保存吗？`)) return saveSide(side, { ...extra, ignoreLock: true });
      setMsg(d.msg, '已取消保存', 'error');
      return;
    }
    if (resp.status === 409 && data.error === 'NEEDS_WRITE_THROUGH') {
      updateButtons();
      if (confirm(`这张表是公式镜像（IMPORTRANGE），有 ${data.sourceWriteCount ?? '若干'} 处改动要写回源表。\n\n继续写入吗？（此时还没有写入任何内容）`)) return saveSide(side, { ...extra, writeThrough: true });
      setMsg(d.msg, '已取消：没有写入任何内容', 'error');
      return;
    }
    if (resp.status === 403 && data.error === 'NEED_UPLOAD_SCOPE') {
      updateButtons();
      setMsg(d.msg, '当前 Google 授权只有只读权限，不能写入云端', 'error');
      if (confirm('当前 Google 授权只有只读权限，需要重新授权才能写入云端。现在去授权吗？（未保存的编辑会丢失）')) location.href = '/auth/start';
      return;
    }
    if (!resp.ok) {
      if (resp.status === 409) st.stale = true;
      updateButtons();
      setMsg(d.msg, `保存失败：${data.message || data.error || resp.status}`, 'error');
      return;
    }
    const warn = (data.warnings || []).length ? `；注意：${data.warnings.slice(0, 3).join('；')}` : '';
    const done = side === 'local'
      ? `已保存本地${data.backup ? `（保存前已备份，可在「本地备份」恢复）` : ''}`
      : `已写入云端${data.partial ? '（部分单元格因公式未写入，详见日志）' : ''}`;
    const syncedText = data.synced ? '；两边内容已一致，已记为已同步' : '';
    CSM().appendLog(`✓ 差异窗口：${done} ${st.path}${syncedText}${warn}\n`);
    CSM().reloadTables?.();
    const other = otherSide(side);
    const otherDirty = models.length && [...st.models.values()].some(m => m.dirty[other]);
    if (!otherDirty) {
      await loadDiff({ force: side === 'cloud' });
      if (diffState === st) setMsg(d.msg, `${done}${syncedText}${warn}`, 'ok');
      return;
    }
    // 另一侧还有没保存的编辑：保留，只把这一侧当作新的基准（行号按写入后的位置重排）
    for (const m of st.models.values()) {
      if (!m.dirty[side]) continue;
      rowsOfSide(m, side).forEach((r, i) => { r.src = i + 1; r.ed.clear(); r.add = false; });
      m.dirty[side] = false;
    }
    if (side === 'local' && data.localVersion) st.data.downloadVersion.localVersion = data.localVersion;
    if (side === 'cloud' && data.modifiedTime) st.data.cloud.modifiedTime = data.modifiedTime;
    st.undo = [];
    setMsg(d.msg, `${done}${warn}；${SIDE_NAME[other]}还有未保存的编辑`, 'ok');
    rerenderKeepScroll();
  }

  function discardEdits() {
    const st = diffState;
    if (!st || !anyDirty(st) || st.busy) return;
    if (!confirm('放弃所有未保存的编辑？')) return;
    st.models = new Map();
    st.undo = [];
    st.sel = null;
    setMsg(d.msg, '已放弃编辑');
    rerenderKeepScroll();
  }

  // 有未保存的编辑时，关闭 / 覆盖前先确认
  function confirmLoseEdits(action) {
    const st = diffState;
    if (!anyDirty(st)) return true;
    return confirm(`有未保存的编辑，${action}会丢失这些编辑。继续吗？`);
  }

  d.copyRight.addEventListener('click', () => copySelection('old'));
  d.copyLeft.addEventListener('click', () => copySelection('new'));
  d.undo.addEventListener('click', undoEdit);
  d.saveLocal.addEventListener('click', () => saveSide('local'));
  d.saveCloud.addEventListener('click', () => saveSide('cloud'));
  d.discard.addEventListener('click', discardEdits);

  d.close.addEventListener('click', () => { if (confirmLoseEdits('关闭')) finishDiff(null); });
  d.cancel.addEventListener('click', () => { if (confirmLoseEdits('关闭')) finishDiff(null); });
  d.dl.addEventListener('click', doDownload);
  d.ul.addEventListener('click', doUpload);
  d.refresh.addEventListener('click', () => {
    d.close.focus();
    loadDiff({ force: true });
  });

  // ======================= 本地备份 =======================
  const b = { modal: $('bk-modal'), path: $('bk-path'), tbody: $('bk-tbody'), msg: $('bk-msg'), close: $('bk-close') };
  let bkRow = null;

  async function openBackups(row) {
    bkRow = row;
    b.path.textContent = `${row.name} · ${row.path}`;
    setMsg(b.msg, '');
    b.modal.classList.remove('hidden');
    await loadBackups();
  }

  async function loadBackups() {
    b.tbody.innerHTML = '';
    const resp = await fetch(CSM().api(`/backups?path=${encodeURIComponent(bkRow.path)}`));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { setMsg(b.msg, data.error || `读取失败（${resp.status}）`, 'error'); return; }
    if (!data.backups.length) {
      const tr = el('tr'); const td = el('td', 'fl-empty', '还没有备份：第一次「下载覆盖本地」时会自动备份'); td.colSpan = 4; tr.appendChild(td); b.tbody.appendChild(tr);
      return;
    }
    for (const bk of data.backups) {
      const tr = el('tr');
      tr.appendChild(el('td', 'hist-time', fmt(bk.createdAt)));
      tr.appendChild(el('td', null, bk.reason || '—'));
      tr.appendChild(el('td', null, fmtSize(bk.size)));
      const ops = el('td', 'fl-col-ops');
      const restore = el('button', null, '恢复');
      restore.type = 'button';
      restore.addEventListener('click', () => restoreBackup(bk));
      const show = el('button', null, '在访达中显示');
      show.type = 'button';
      show.addEventListener('click', () => revealBackup(bk));
      ops.append(restore, show);
      tr.appendChild(ops);
      b.tbody.appendChild(tr);
    }
  }

  async function restoreBackup(bk) {
    if (!confirm(`用 ${fmt(bk.createdAt)} 的备份覆盖本地「${bkRow.name}」？\n\n${bkRow.path}\n\n当前本地文件会先自动备份一份。`)) return;
    const resp = await fetch(CSM().api('/backups/restore'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: bkRow.path, id: bk.id })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { setMsg(b.msg, `恢复失败：${data.error || resp.status}`, 'error'); return; }
    setMsg(b.msg, `已恢复 ${fmt(bk.createdAt)} 的备份`, 'ok');
    CSM().appendLog(`✓ 已用备份 ${bk.id} 恢复本地 ${bkRow.path}\n`);
    await loadBackups();
    CSM().reloadTables();
  }

  async function revealBackup(bk) {
    const resp = await fetch(CSM().api('/backups/reveal'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: bkRow.path, id: bk.id })
    });
    if (!resp.ok) setMsg(b.msg, `打开失败：${(await resp.json().catch(() => ({}))).error || resp.status}`, 'error');
  }

  b.close.addEventListener('click', () => b.modal.classList.add('hidden'));

  // ======================= 操作历史 =======================
  const h = { modal: $('hist-modal'), tbody: $('hist-tbody'), filter: $('hist-filter'), count: $('hist-count'), close: $('hist-close') };
  let histRows = [];
  const OP_LABEL = { download: '⬇ 下载', upload: '⬆ 上传', create: '＋ 新建云端表', link: '🔗 关联云端表', restore: '↺ 恢复备份', action: '▶ 执行动作', verify: '≡ 内容核对' };

  function histDetail(r) {
    if (!r.ok) return r.error ? `失败：${r.error}` : '失败';
    switch (r.op) {
      case 'download': return `云端版本 ${fmt(r.cloudModifiedTime)}${r.cloudModifiedBy ? `（${r.cloudModifiedBy}）` : ''}${r.backup ? ` · 覆盖前已备份 ${r.backup}` : ''}`;
      case 'upload': return `覆盖了云端 ${fmt(r.replacedCloudModifiedTime)}${r.replacedCloudModifiedBy ? `（${r.replacedCloudModifiedBy}）` : ''} 的版本${r.forced ? ' · 强制覆盖' : ''}`;
      case 'create': case 'link': return r.cloudDir || '';
      case 'restore': return `恢复到备份 ${r.backup}${r.backupBefore ? ` · 恢复前已备份 ${r.backupBefore}` : ''}`;
      case 'verify': return r.previousStatus === 'local_changed'
        ? '本地文件被重新保存过，内容与云端一致，已标为已同步'
        : `云端 ${fmt(r.cloudModifiedTime)}${r.cloudModifiedBy ? `（${r.cloudModifiedBy}）` : ''} 只改了时间，内容与本地一致，已标为已同步`;
      case 'action': return `退出码 ${r.exitCode}${r.durationMs != null ? ` · 耗时 ${(r.durationMs / 1000).toFixed(1)}s` : ''}`;
      default: return '';
    }
  }

  function renderHistory() {
    const q = h.filter.value.trim().toLowerCase();
    const rows = q ? histRows.filter(r => [r.name, r.path, r.account, r.osUser, r.action].some(v => v && String(v).toLowerCase().includes(q))) : histRows;
    h.count.textContent = `${rows.length} 条${q ? `（共 ${histRows.length}）` : ''}`;
    h.tbody.innerHTML = '';
    if (!rows.length) {
      const tr = el('tr'); const td = el('td', 'fl-empty', histRows.length ? '没有匹配的记录' : '还没有操作记录'); td.colSpan = 5; tr.appendChild(td); h.tbody.appendChild(tr);
      return;
    }
    for (const r of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', 'hist-time', fmt(r.time)));
      tr.appendChild(el('td', `hist-op${r.ok ? '' : ' hist-fail'}`, OP_LABEL[r.op] || r.op));
      const t = el('td');
      t.appendChild(el('div', 'fl-col-name', r.name || '—'));
      if (r.path) t.appendChild(el('div', 'fl-col-path', r.path));
      tr.appendChild(t);
      tr.appendChild(el('td', 'hist-who', [r.account, r.osUser && `（${r.osUser}）`].filter(Boolean).join(' ') || '—'));
      tr.appendChild(el('td', `hist-detail${r.ok ? '' : ' hist-fail'}`, histDetail(r)));
      h.tbody.appendChild(tr);
    }
  }

  async function openHistory() {
    h.modal.classList.remove('hidden');
    h.tbody.innerHTML = '';
    h.count.textContent = '加载中…';
    const resp = await fetch(CSM().api('/history?limit=1000'));
    histRows = resp.ok ? await resp.json() : [];
    renderHistory();
    h.filter.focus();
  }

  h.filter.addEventListener('input', renderHistory);
  h.close.addEventListener('click', () => h.modal.classList.add('hidden'));

  d.modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // 全局 Esc 会直接隐藏弹窗，差异预览还需要结束等待中的调用。
      e.preventDefault();
      e.stopPropagation();
      if (!diffState?.busy && confirmLoseEdits('关闭')) finishDiff(null);
      return;
    }
    // 编辑快捷键：⌘Z / Ctrl+Z 撤销，⌥→ / ⌥← 复制到右侧 / 左侧
    if (diffState?.editing && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoEdit(); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); copySelection('old'); return; }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); copySelection('new'); return; }
    }
    if (e.key === 'Tab') {
      const controls = [...d.modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
        .filter(control => control.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (document.activeElement === d.modal || document.activeElement === (e.shiftKey ? first : last)) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
      return;
    }
    // J / K 或 ⌥↓ / ⌥↑ 跳到下一处 / 上一处改动
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'j' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); step(1); }
    else if (k === 'k' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); step(-1); }
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!b.modal.classList.contains('hidden')) b.modal.classList.add('hidden');
    else if (!h.modal.classList.contains('hidden')) h.modal.classList.add('hidden');
  });

  // 新版本检测与提示统一由 updater-ui.js 驱动（顶栏更新按钮 + 全局偏好设置「关于 CSM」）

  window.CSMPanels = { openDiff, openBackups, openHistory };
})();
