const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findScriptMappings, inspectLegacy, countLocalTables } = require('../lib/legacy-import');
const { addProject, updateProject, loadProjects, guessTitle } = require('../lib/projects');
const { listDirs } = require('../lib/fs-browser');
const { scanRootOf } = require('../lib/local-tables');

const ID_A = '16M0hFR7YozQH4hvlZ5wJqfC0YQp22gbTruf62k9DklM';
const ID_B = '1x4vDOxgcYcl_i19b3uRn9hYcOcOGj1X_-xPHEn4E_2E';
const ID_C = '1GO6Lf8riyS4PvOWaN7jd2DGdgSCTCCfpxYI4SUNM28k';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-legacy-')); }
function touch(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// 仿老项目：Res/Configs 放 xlsx，Res/ExcelTools 放导表脚本
function legacyRepo() {
  const res = tmp();
  const configs = path.join(res, 'Configs');
  touch(path.join(configs, 'Modules/Game.xlsx'));
  touch(path.join(configs, 'Shop/Shop.xlsx'));
  touch(path.join(configs, 'Other/Loose.xlsx'));
  touch(path.join(configs, 'Modules/~$Game.xlsx'));
  touch(path.join(configs, 'Modules/__tables__.xlsx'));
  touch(path.join(res, 'ExcelTools/bcModule.sh'), [
    'modulesAll=(',
    `\t{"Game","${ID_A}","../Configs/Modules/Game.xlsx"}`,
    `\t#{"RVDaily","${ID_C}","../Configs/Modules/RVDaily.xlsx"}`,
    '\t{"Var","1AOEMzwhUljvJlb6XzhnKjS4lzSr2iIKdQX5sX5Joq8g","${dir}/Var.xlsx"}',
    ')'
  ].join('\n'));
  touch(path.join(res, 'ExcelTools/bcShop.bat'), `set X={"Shop","https://docs.google.com/spreadsheets/d/${ID_B}/edit","..\\Configs\\Shop\\Shop.xlsx"}\r\n`);
  touch(path.join(res, 'ExcelTools/outside.sh'), `{"Far","${ID_C}","../../Elsewhere/Far.xlsx"}`);
  return { res, configs };
}

test('从附近导表脚本识别映射：跳过注释、变量路径和目录外的表，支持链接与反斜杠路径', () => {
  const { configs } = legacyRepo();
  const { entries, sources } = findScriptMappings(configs);
  assert.deepStrictEqual(entries, [
    { path: 'Modules/Game.xlsx', spreadsheetId: ID_A, name: 'Game' },
    { path: 'Shop/Shop.xlsx', spreadsheetId: ID_B, name: 'Shop' }
  ]);
  assert.deepStrictEqual(sources, ['../ExcelTools/bcModule.sh', '../ExcelTools/bcShop.bat']);
});

test('统计本地 xlsx 并算出未绑定数量；忽略临时文件与 Luban 定义表', () => {
  const { configs } = legacyRepo();
  assert.strictEqual(countLocalTables(configs).count, 3);
  const info = inspectLegacy(configs);
  assert.strictEqual(info.ok, true);
  assert.strictEqual(info.mapped, 2);
  assert.strictEqual(info.unmapped, 1);
});

test('目录大到数不完且脚本里没有映射：不按老项目接入', () => {
  const dir = tmp();
  for (let i = 0; i < 5; i++) touch(path.join(dir, `d${i}/t.xlsx`));
  assert.strictEqual(inspectLegacy(dir, { maxDirs: 3 }).ok, false);
  assert.strictEqual(inspectLegacy(dir).ok, true);
});

test('添加老项目：生成 filelist.json 与配置，条目来自脚本', () => {
  const { configs } = legacyRepo();
  const reg = path.join(tmp(), 'projects.json');
  const { project, generated, legacy } = addProject(reg, configs);
  assert.strictEqual(generated, true);
  assert.deepStrictEqual(legacy, { mapped: 2, unmapped: 1, tables: 3, sources: ['../ExcelTools/bcModule.sh', '../ExcelTools/bcShop.bat'] });
  const cfg = JSON.parse(fs.readFileSync(path.join(configs, 'syncmanager.config.json'), 'utf8'));
  assert.strictEqual(cfg.filelist, 'filelist.json');
  const list = JSON.parse(fs.readFileSync(path.join(configs, 'filelist.json'), 'utf8'));
  assert.deepStrictEqual(list.map(e => e.path), ['Modules/Game.xlsx', 'Shop/Shop.xlsx']);
  assert.strictEqual(loadProjects(reg)[0].id, project.id);
});

test('只有 xlsx、没有脚本：生成空清单，项目也能添加', () => {
  const dir = tmp();
  touch(path.join(dir, 'Tables/A.xlsx'));
  const reg = path.join(tmp(), 'projects.json');
  const { legacy } = addProject(reg, dir);
  assert.deepStrictEqual(legacy, { mapped: 0, unmapped: 1, tables: 1, sources: [] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'filelist.json'), 'utf8')), []);
  // 空清单、没有 Datas 时，本地表扫描落到 xlsx 最多的首级目录
  assert.strictEqual(scanRootOf([], undefined, dir), 'Tables');
});

test('更改项目目录到老项目目录：同样自动生成', () => {
  const reg = path.join(tmp(), 'projects.json');
  const first = tmp();
  fs.writeFileSync(path.join(first, 'syncmanager.config.json'), JSON.stringify({ filelist: 'f.json' }));
  const { project } = addProject(reg, first);
  const { configs } = legacyRepo();
  const res = updateProject(reg, project.id, { dir: configs });
  assert.strictEqual(res.generated, true);
  assert.strictEqual(res.legacy.mapped, 2);
  assert.ok(fs.existsSync(path.join(configs, 'filelist.json')));
});

test('目录浏览：老项目目录返回识别结果，已有配置的目录不返回', () => {
  const { configs } = legacyRepo();
  const listed = listDirs(configs);
  assert.strictEqual(listed.hint, false);
  assert.deepStrictEqual(
    { tables: listed.legacy.tables, mapped: listed.legacy.mapped, unmapped: listed.legacy.unmapped },
    { tables: 3, mapped: 2, unmapped: 1 }
  );
  assert.strictEqual(listDirs(tmp()).legacy, null);
  const withCfg = tmp();
  fs.writeFileSync(path.join(withCfg, 'syncmanager.config.json'), '{}');
  assert.strictEqual(listDirs(withCfg).legacy, null);
});

test('项目名跳过 Configs / Res 等通用目录名', () => {
  assert.strictEqual(guessTitle('/w/SmashBlast1/Res/Configs'), 'SmashBlast1');
  assert.strictEqual(guessTitle('/w/MergeX11/Configs/Input'), 'MergeX11');
  assert.strictEqual(guessTitle('/w/Foo'), 'Foo');
  assert.strictEqual(guessTitle('/Configs'), 'Configs');
});
