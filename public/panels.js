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
    msg: $('diff-msg'), close: $('diff-close'), cancel: $('diff-cancel'), dl: $('diff-download'), ul: $('diff-upload')
  };
  // diffState：{ path, mode, data, resolve, token, oldSide, newSide, sheet, expanded, showSame, groups, cur }
  let diffState = null;
  const MODE_TITLE = { view: '差异预览', upload: '上传前确认差异', conflict: '解决冲突：云端和本地都改过' };
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
    const { resolve } = diffState;
    diffState = null;
    d.modal.classList.add('hidden');
    resolve(result);
  }

  // mode：view（查看）/ upload（上传前确认）/ conflict（冲突，两个方向都可选、都不预设）
  function openDiff(path, { mode = 'view' } = {}) {
    if (diffState) finishDiff(null);
    return new Promise(resolve => {
      diffState = { path, mode, data: null, resolve, token: Symbol('diff') };
      d.title.textContent = MODE_TITLE[mode] || MODE_TITLE.view;
      d.path.textContent = path;
      d.modal.classList.remove('hidden');
      loadDiff();
    });
  }

  function showPlaceholder(text) {
    d.tree.innerHTML = '';
    d.ruler.innerHTML = '';
    d.pos.textContent = '';
    d.view.innerHTML = '';
    d.view.appendChild(el('div', 'diff-loading', text));
  }

  async function loadDiff() {
    const st = diffState;
    const token = Symbol('diff');
    st.token = token;
    st.data = null;
    st.recordSheets = null;
    st.recordToken = null;
    d.record.value = '';
    d.findStatus.textContent = '';
    d.findClear.classList.add('hidden');
    d.meta.textContent = '';
    showPlaceholder('正在从云端导出并逐单元格比较…（大表需要几秒）');
    setMsg(d.msg, '');
    updateButtons();
    try {
      const resp = await fetch(CSM().api(`/diff?path=${encodeURIComponent(st.path)}`));
      const data = await resp.json().catch(() => ({}));
      if (diffState !== st || st.token !== token) return;
      if (!resp.ok) { showPlaceholder(resp.status === 401 ? '需要先完成 Google 授权' : `比较失败：${data.error || resp.status}`); return; }
      st.data = data;
      st.newSide = incomingSide() || 'cloud';
      st.oldSide = st.newSide === 'cloud' ? 'local' : 'cloud';
      st.expanded = new Map();
      st.showSame = data.diff.identical;
      const first = data.diff.sheets.findIndex(s => s.status !== 'same');
      st.sheet = first >= 0 ? first : 0;
      renderAll();
    } catch (err) {
      if (diffState === st) showPlaceholder(`比较失败：${err.message}`);
    } finally {
      if (diffState === st) updateButtons();
    }
  }

  // 哪一边是「将要生效」的新值：上传 → 本地；下载 / 查看 → 云端；冲突时两边都不预设
  function incomingSide() {
    const st = diffState;
    if (st.mode === 'upload') return 'local';
    if (st.mode === 'conflict') return null;
    const row = CSM().tableRow(st.path);
    return row && row.direction === 'upload' ? 'local' : 'cloud';
  }

  // ---------- 按「旧 / 新」方向统计 ----------
  function sheetCounts(sheet) {
    const { oldSide } = diffState;
    if (sheet.status === 'same') return null;
    if (sheet.status === 'local_only' || sheet.status === 'cloud_only') {
      const side = sheet.status === 'local_only' ? 'local' : 'cloud';
      const n = side === 'local' ? sheet.localRows : sheet.cloudRows;
      return side === oldSide ? { add: 0, del: n, mod: 0 } : { add: n, del: 0, mod: 0 };
    }
    const s = sheet.stats;
    return oldSide === 'local' ? { add: s.cloudOnly, del: s.localOnly, mod: s.modified } : { add: s.localOnly, del: s.cloudOnly, mod: s.modified };
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
      : `修改于 ${fmt(data.cloud.modifiedTime)}${data.cloud.modifiedBy ? ` · ${data.cloud.modifiedBy}` : ''}${data.cloud.name ? ` · ${data.cloud.name}` : ''}`;
    d.meta.innerHTML = '';
    const sides = el('div', 'dm-sides');
    const chip = (cls, sign, side) => { const c = el('span', `dm-chip ${cls}`); c.append(el('b', null, sign), ` ${SIDE_NAME[side]}`); return c; };
    sides.append(chip('old', '−', oldSide), el('span', 'dm-text', sideText(oldSide)), el('span', 'dm-arrow', '→'), chip('new', '+', newSide), el('span', 'dm-text', sideText(newSide)));
    d.meta.appendChild(sides);

    const diff = data.diff;
    const summary = el('div', 'dm-summary');
    if (diff.identical) {
      summary.appendChild(el('span', 'diff-same', '✓ 两边内容完全一致（只是修改时间不同）。'));
      summary.append(' 点「用云端覆盖本地」即可把状态记为已同步（会先备份本地文件）。');
    } else {
      const t = { add: 0, del: 0, mod: 0 };
      let changed = 0;
      for (const s of diff.sheets) { const c = sheetCounts(s); if (!c) continue; changed++; t.add += c.add; t.del += c.del; t.mod += c.mod; }
      summary.append(`${changed} 个工作表有差异：`);
      if (t.mod) summary.appendChild(el('span', 'dm-n mod', `修改 ${t.mod} 行`));
      if (t.add) summary.appendChild(el('span', 'dm-n add', `+${t.add} 行`));
      const reordered = diff.sheets.filter(sheet => sheet.orderChanged).length;
      if (reordered) summary.appendChild(el('span', 'dm-n mod', `${reordered} 个工作表行序变化`));
      if (t.del) summary.appendChild(el('span', 'dm-n del', `−${t.del} 行`));
      if (mode === 'conflict') summary.appendChild(el('span', 'diff-warn', '　上次同步后两边都改过：无论选哪个方向，另一边的改动都会被覆盖，请先确认需要保留的内容。'));
      else summary.appendChild(el('span', 'dir-tip', `　「+」一边是${newSide === incomingSide() ? '将要生效的' : ''}${SIDE_NAME[newSide]}内容`));
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
      else if (c) badge = c.mod || (c.add && c.del) ? ['M', 'mod'] : c.add ? ['+', 'add'] : ['−', 'del'];
      if (s.status === 'local_only' || s.status === 'cloud_only') it.title = `只在${SIDE_NAME[s.status === 'local_only' ? 'local' : 'cloud']}有这个工作表`;
      it.appendChild(el('span', `dt-badge ${badge[1]}`, badge[0]));
      it.appendChild(el('span', 'dt-name', s.name));
      const cnt = el('span', 'dt-cnt');
      if (c) {
        if (c.add) cnt.appendChild(el('b', 'add', `+${c.add}`));
        if (c.del) cnt.appendChild(el('b', 'del', `−${c.del}`));
        if (c.mod) cnt.appendChild(el('b', 'mod', `~${c.mod}`));
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
    renderTree();
    renderSheet();
    if (jump === 'first') goTo(0);
    else if (jump === 'last') goTo(st.groups.length - 1);
  }

  // ---------- 右侧：逐行对照 ----------
  // 把服务端的行（本地 / 云端）换算成当前方向的「旧 / 新」
  function orientedRows(sheet) {
    const oldIsLocal = diffState.oldSide === 'local';
    const out = [];
    for (const r of sheet.view.rows) {
      if (r.k === '=') out.push({ t: 'ctx', o: oldIsLocal ? r.l : r.c, n: oldIsLocal ? r.c : r.l, v: r.v });
      else if (r.k === '~') out.push({ t: 'mod', o: oldIsLocal ? r.l : r.c, n: oldIsLocal ? r.c : r.l, ov: oldIsLocal ? r.lv : r.cv, nv: oldIsLocal ? r.cv : r.lv, d: new Set(r.d) });
      else if (diffState.recordSheets && !sheet.alignedByKey) {
        const local = r.k === 'L';
        out.push({ t: 'ctx', o: oldIsLocal === local ? r.l ?? r.c : null, n: oldIsLocal !== local ? r.l ?? r.c : null, v: r.v });
      }
      else if (r.k === 'L') out.push(oldIsLocal ? { t: 'del', o: r.l, v: r.v } : { t: 'add', n: r.l, v: r.v });
      else if (r.k === 'C') out.push(oldIsLocal ? { t: 'add', n: r.c, v: r.v } : { t: 'del', o: r.c, v: r.v });
      else out.push({ t: 'gap', count: r.n, o: oldIsLocal ? r.l : r.c, n: oldIsLocal ? r.c : r.l, fixed: true });
    }
    return out;
  }

  // 折叠远离改动的相同行（可点击展开）
  function foldRows(rows) {
    const st = diffState;
    if (prefs.allRows) return rows;
    const expanded = st.expanded.get(st.sheet) || new Set();
    const out = [];
    let x = 0;
    while (x < rows.length) {
      if (rows[x].t !== 'ctx') { out.push(rows[x]); x++; continue; }
      let y = x;
      while (y < rows.length && rows[y].t === 'ctx') y++;
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
    rows.forEach(r => { if (r.t === 'mod') r.d.forEach(c => set.add(c)); });
    if (!set.size) return all;
    set.add(keyCol(sheet.header));
    return all.filter(c => set.has(c));
  }

  function headLabel(sheet, c) {
    const h = sheet.header && sheet.header[c];
    return h && !/^##/.test(h) ? `${colLetter(c)} · ${h}` : colLetter(c);
  }

  const textWidth = s => { let w = 0; for (const ch of String(s)) { w += ch.charCodeAt(0) > 0x2e80 ? 13 : 7; if (w > 400) break; } return w; };
  function colWidths(sheet, rows, cols) {
    return cols.map(c => {
      let w = textWidth(headLabel(sheet, c));
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

  function cellsHtml(vals, cols, hl, other, side) {
    let h = '';
    for (const c of cols) {
      const v = vals ? vals[c] ?? '' : '';
      const isHl = hl && hl.has(c);
      const o = other ? other[c] ?? '' : '';
      const title = isHl ? `${side === 'old' ? '旧' : '新'}：${v || '（空）'}\n${side === 'old' ? '新' : '旧'}：${o || '（空）'}` : v;
      h += `<td${isHl ? ' class="hl"' : ''}${title ? ` title="${esc(title)}"` : ''}>${isHl && v && o ? markDiff(v, o) : escCell(v)}</td>`;
    }
    return h;
  }

  // 改动行分组：连续的改动（修改 / 新增 / 删除）算一处，用于上下跳转和右侧标尺
  function groupRows(rows) {
    let g = -1;
    let inChange = false;
    for (const r of rows) {
      const chg = r.t === 'mod' || r.t === 'add' || r.t === 'del';
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

  function unifiedHtml(sheet, rows, cols, widths) {
    const total = 44 * 2 + 22 + widths.reduce((a, b) => a + b, 0);
    let h = `<table class="dg" style="width:${total}px"><colgroup><col style="width:44px"><col style="width:44px"><col style="width:22px">`;
    widths.forEach(w => { h += `<col style="width:${w}px">`; });
    h += '</colgroup><thead><tr><th class="gut g1">−</th><th class="gut g2">+</th><th class="sign s3"></th>';
    cols.forEach(c => { h += `<th title="${esc(headLabel(sheet, c))}">${esc(headLabel(sheet, c))}</th>`; });
    h += '</tr></thead><tbody>';
    rows.forEach((r, x) => {
      const g = r.g >= 0 ? ` data-g="${r.g}"` : '';
      if (r.t === 'ctx') h += `<tr><td class="gut g1">${r.o ?? ''}</td><td class="gut g2">${r.n ?? ''}</td><td class="sign s3"></td>${cellsHtml(r.v, cols)}</tr>`;
      else if (r.t === 'del') h += `<tr class="del"${g}><td class="gut g1">${r.o}</td><td class="gut g2"></td><td class="sign s3">−</td>${cellsHtml(r.v, cols)}</tr>`;
      else if (r.t === 'add') h += `<tr class="add"${g}><td class="gut g1"></td><td class="gut g2">${r.n}</td><td class="sign s3">+</td>${cellsHtml(r.v, cols)}</tr>`;
      else if (r.t === 'mod') {
        h += `<tr class="del"${g}><td class="gut g1">${r.o}</td><td class="gut g2"></td><td class="sign s3">−</td>${cellsHtml(r.ov, cols, r.d, r.nv, 'old')}</tr>`;
        h += `<tr class="add"${g}><td class="gut g1"></td><td class="gut g2">${r.n}</td><td class="sign s3">+</td>${cellsHtml(r.nv, cols, r.d, r.ov, 'new')}</tr>`;
      } else h += `<tr class="gap${r.fixed ? ' fixed' : ''}" data-x="${x}"><td class="gut g1">⋯</td><td class="gut g2">⋯</td><td class="sign s3"></td><td colspan="${cols.length}"><span class="gap-text">${gapText(r)}</span></td></tr>`;
    });
    return `${h}</tbody></table>`;
  }

  // 并排：左旧右新，每一行在两边一一对应（缺的一边用斜纹占位）
  function splitHtml(sheet, rows, cols, widths, side) {
    const total = 44 + 22 + widths.reduce((a, b) => a + b, 0);
    let h = `<table class="dg" style="width:${total}px"><colgroup><col style="width:44px"><col style="width:22px">`;
    widths.forEach(w => { h += `<col style="width:${w}px">`; });
    h += `</colgroup><thead><tr><th class="gut g1">${side === 'old' ? '−' : '+'}</th><th class="sign s2"></th>`;
    cols.forEach(c => { h += `<th title="${esc(headLabel(sheet, c))}">${esc(headLabel(sheet, c))}</th>`; });
    h += '</tr></thead><tbody>';
    const fill = g => `<tr class="fill"${g}><td class="gut g1"></td><td class="sign s2"></td><td colspan="${cols.length}"></td></tr>`;
    rows.forEach((r, x) => {
      const g = r.g >= 0 ? ` data-g="${r.g}"` : '';
      const no = side === 'old' ? r.o : r.n;
      if (r.t === 'ctx') h += no == null ? fill(g) : `<tr><td class="gut g1">${no}</td><td class="sign s2"></td>${cellsHtml(r.v, cols)}</tr>`;
      else if (r.t === 'del') h += side === 'old' ? `<tr class="del"${g}><td class="gut g1">${no}</td><td class="sign s2">−</td>${cellsHtml(r.v, cols)}</tr>` : fill(g);
      else if (r.t === 'add') h += side === 'new' ? `<tr class="add"${g}><td class="gut g1">${no}</td><td class="sign s2">+</td>${cellsHtml(r.v, cols)}</tr>` : fill(g);
      else if (r.t === 'mod') {
        h += side === 'old'
          ? `<tr class="del"${g}><td class="gut g1">${no}</td><td class="sign s2">−</td>${cellsHtml(r.ov, cols, r.d, r.nv, 'old')}</tr>`
          : `<tr class="add"${g}><td class="gut g1">${no}</td><td class="sign s2">+</td>${cellsHtml(r.nv, cols, r.d, r.ov, 'new')}</tr>`;
      } else h += `<tr class="gap${r.fixed ? ' fixed' : ''}" data-x="${x}"><td class="gut g1">⋯</td><td class="sign s2"></td><td colspan="${cols.length}"><span class="gap-text">${gapText(r)}</span></td></tr>`;
    });
    return `${h}</tbody></table>`;
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
    const oriented = orientedRows(sheet);
    const rows = st.recordSheets ? oriented : foldRows(oriented);
    const groupCount = groupRows(rows);
    const cols = visibleCols(sheet, rows);
    const widths = colWidths(sheet, rows, cols);
    st.rows = rows;
    if (prefs.mode === 'split') {
      const wrap = el('div', 'diff-split');
      for (const side of ['old', 'new']) {
        const pane = el('div', `diff-pane ${side}`);
        const label = el('div', 'diff-pane-label');
        label.append(el('b', null, side === 'old' ? '−' : '+'), ` ${SIDE_NAME[side === 'old' ? st.oldSide : st.newSide]}`);
        const scroller = el('div', 'diff-scroll');
        scroller.innerHTML = splitHtml(sheet, rows, cols, widths, side);
        pane.append(label, scroller);
        wrap.appendChild(pane);
        panes.push(scroller);
      }
      d.view.appendChild(wrap);
      let lock = false;
      panes.forEach(p => p.addEventListener('scroll', () => {
        if (lock) return;
        lock = true;
        for (const q of panes) if (q !== p) { q.scrollTop = p.scrollTop; q.scrollLeft = p.scrollLeft; }
        requestAnimationFrame(() => { lock = false; });
        drawViewport();
      }));
    } else {
      const scroller = el('div', 'diff-scroll');
      scroller.innerHTML = unifiedHtml(sheet, rows, cols, widths);
      d.view.appendChild(scroller);
      panes.push(scroller);
      scroller.addEventListener('scroll', drawViewport);
    }
    for (const p of panes) p.addEventListener('click', onViewClick);
    const notes = [];
    if (sheet.orderChanged) notes.push('已有记录的行序发生变化，两侧行号保留原位置。');
    if (st.recordSheets && !sheet.alignedByKey) notes.push('这个工作表无法按唯一主键配对，匹配项按两侧分别列出。');
    if (st.recordSheets && sheet.matches > sheet.view.rows.length) notes.push(`当前显示前 ${sheet.view.rows.length} 条匹配。`);
    if (sheet.view.truncated) notes.push('改动太多，只显示前 2000 处；完整内容请直接打开两边文件比较。');
    if (!sheet.view.full) notes.push('表很大，相同的行只保留改动前后几行，无法展开。');
    if (prefs.onlyCols && cols.length < sheet.view.cols) notes.push(`已隐藏 ${sheet.view.cols - cols.length} 个没有改动的列。`);
    if (notes.length) d.view.appendChild(el('div', 'diff-note', notes.join(' ')));
    st.groups = Array.from({ length: groupCount }, (_, g) => g);
    requestAnimationFrame(drawRuler);
    updatePos();
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
      const cls = k.has('mod') || (k.has('add') && k.has('del')) ? 'mod' : k.has('add') ? 'add' : 'del';
      const mk = el('div', `rk ${cls}`);
      mk.style.top = `${(m.top / total) * H}px`;
      mk.style.height = `${Math.max(3, ((m.bottom - m.top) / total) * H)}px`;
      mk.dataset.g = g;
      d.ruler.appendChild(mk);
    }
    d.ruler.appendChild(el('div', 'rk-view'));
    drawViewport();
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

  function updateButtons(busy) {
    const st = diffState;
    const data = st && st.data;
    d.dl.disabled = !!busy || !data;
    d.record.disabled = d.findSubmit.disabled = !!busy || !data;
    d.findClear.disabled = !!busy || !data;
    d.ul.disabled = !!busy || !data || !data.local.exists;
    d.ul.classList.toggle('hidden', !CSM().allowUpload());
    const incoming = data ? incomingSide() : null;
    d.dl.classList.toggle('diff-primary', !!data && st.mode !== 'conflict' && (incoming === 'cloud' || data.diff.identical));
    d.ul.classList.toggle('diff-primary', !!data && st.mode !== 'conflict' && incoming === 'local' && !data.diff.identical);
    d.cancel.disabled = !!busy;
    for (const b of [d.swap, d.prev, d.next, d.onlyCols, d.allRows]) if (!data) b.disabled = true; else if (b !== d.prev && b !== d.next) b.disabled = false;
    if (data) updatePos();
  }

  async function doDownload() {
    const st = diffState;
    if (!st || !st.data) return;
    if (st.mode === 'conflict' && !st.data.diff.identical
      && !confirm('用云端覆盖本地？\n\n本地在上次同步后的改动会被覆盖（覆盖前会自动备份，可在「🕘 本地备份」里恢复）。')) return;
    updateButtons(true);
    setMsg(d.msg, '下载中…');
    const summary = await CSM().downloadPaths([st.path]);
    if (diffState !== st) return;
    if (summary && summary.successCount) finishDiff('downloaded');
    else { setMsg(d.msg, '下载失败，详情见日志', 'error'); updateButtons(false); }
  }

  async function doUpload() {
    const st = diffState;
    if (!st || !st.data) return;
    if (st.mode === 'conflict' && !st.data.diff.identical
      && !confirm('用本地覆盖云端？\n\n云端在上次同步后的改动会被覆盖（可在 Google 表格「版本历史」中找回）。')) return;
    updateButtons(true);
    setMsg(d.msg, '上传中…');
    // expect：以这次差异预览看到的云端版本为准；之后云端若又被改，服务端会拒绝（409）
    const r = await CSM().uploadRequest(st.path, { expect: st.data.cloud.modifiedTime });
    if (diffState !== st) return;
    if (r.ok) { finishDiff('uploaded'); return; }
    if (r.status === 409 && r.data.error === 'CLOUD_CHANGED') {
      const who = r.data.cloudModifiedBy ? `「${r.data.cloudModifiedBy}」` : '其他人';
      setMsg(d.msg, `云端在 ${fmt(r.data.cloudModifiedTime)} 被${who}修改过（晚于这次差异预览），已取消上传`, 'error');
      if (confirm(`你查看差异之后，云端又被${who}修改了（${fmt(r.data.cloudModifiedTime)}）。\n\n直接上传会覆盖这次修改，已取消上传。\n现在重新比较差异吗？`)) {
        await loadDiff();
        return;
      }
    } else {
      setMsg(d.msg, `上传失败：${r.data.error || r.status}`, 'error');
    }
    updateButtons(false);
  }

  d.close.addEventListener('click', () => finishDiff(null));
  d.cancel.addEventListener('click', () => finishDiff(null));
  d.dl.addEventListener('click', doDownload);
  d.ul.addEventListener('click', doUpload);

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

  // Esc 关闭最上层的这几个弹窗
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') {
      // 差异预览里：J / K 或 ⌥↓ / ⌥↑ 跳到下一处 / 上一处改动
      if (d.modal.classList.contains('hidden') || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); step(1); }
      else if (k === 'k' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); step(-1); }
      return;
    }
    if (!d.modal.classList.contains('hidden')) { if (!d.cancel.disabled) finishDiff(null); }
    else if (!b.modal.classList.contains('hidden')) b.modal.classList.add('hidden');
    else if (!h.modal.classList.contains('hidden')) h.modal.classList.add('hidden');
  });

  // ======================= 新版本提示 =======================
  const u = { banner: $('update-banner'), text: $('update-text'), link: $('update-link'), dismiss: $('update-dismiss') };
  const DISMISS_KEY = 'csm.updateDismissed';
  async function checkUpdate() {
    try {
      const r = await (await fetch('/api/update-check')).json();
      const titleEl = $('app-title');
      if (r.current && titleEl) titleEl.title = `CSM v${r.current}`;
      if (!r.hasUpdate) return;
      let dismissed = null;
      try { dismissed = localStorage.getItem(DISMISS_KEY); } catch (_) {}
      if (dismissed === r.latest) return;
      u.text.textContent = `发现新版本 v${r.latest}（当前 v${r.current}）${r.notes ? `：${r.notes}` : ''}`;
      const href = r.download || r.url;
      u.link.classList.toggle('hidden', !href);
      if (href) u.link.href = href;
      u.banner.classList.remove('hidden');
      u.dismiss.onclick = () => {
        try { localStorage.setItem(DISMISS_KEY, r.latest); } catch (_) {}
        u.banner.classList.add('hidden');
      };
    } catch (_) { /* 检查失败不打扰 */ }
  }
  checkUpdate();
  setInterval(checkUpdate, 6 * 60 * 60 * 1000);

  window.CSMPanels = { openDiff, openBackups, openHistory };
})();
