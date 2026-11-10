const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { addProject, removeProject, renameProject, loadProjects, findProject, moveProject } = require('../lib/projects');
const { listDirs } = require('../lib/fs-browser');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-proj-')); }

test('目录已有 syncmanager.config.json：直接入库、不改文件', () => {
  const reg = path.join(tmp(), 'projects.json');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'syncmanager.config.json'), JSON.stringify({ title: 'Foo', filelist: 'f.json' }));
  const { project, generated } = addProject(reg, dir);
  assert.strictEqual(generated, false);
  assert.strictEqual(project.name, 'Foo');
  assert.strictEqual(findProject(reg, project.id).dir, dir);
});

test('只有 Input/filelist.json：自动生成最小配置', () => {
  const reg = path.join(tmp(), 'projects.json');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'Input'));
  fs.writeFileSync(path.join(dir, 'Input/filelist.json'), '[]');
  const { generated } = addProject(reg, dir);
  assert.strictEqual(generated, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'syncmanager.config.json'), 'utf8'));
  assert.strictEqual(cfg.filelist, 'Input/filelist.json');
  assert.strictEqual(Object.hasOwn(cfg, 'export'), false);
});

test('既无配置也无 filelist：报错且不入库', () => {
  const reg = path.join(tmp(), 'projects.json');
  assert.throws(() => addProject(reg, tmp()), /没有 syncmanager.config.json/);
  assert.deepStrictEqual(loadProjects(reg), []);
});

test('重复添加返回 DUPLICATE；目录不存在报错', () => {
  const reg = path.join(tmp(), 'projects.json');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'syncmanager.config.json'), JSON.stringify({ filelist: 'f.json' }));
  addProject(reg, dir);
  assert.throws(() => addProject(reg, dir), e => e.code === 'DUPLICATE');
  assert.throws(() => addProject(reg, '/nonexistent/zzz'), /目录不存在/);
});

test('配置不合法时不入库', () => {
  const reg = path.join(tmp(), 'projects.json');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'syncmanager.config.json'), JSON.stringify({}));
  assert.throws(() => addProject(reg, dir), /filelist/);
  assert.deepStrictEqual(loadProjects(reg), []);
});

test('removeProject 只改注册表，不动项目文件', () => {
  const reg = path.join(tmp(), 'projects.json');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'syncmanager.config.json'), JSON.stringify({ filelist: 'f.json' }));
  const { project } = addProject(reg, dir);
  assert.strictEqual(removeProject(reg, project.id), true);
  assert.strictEqual(removeProject(reg, project.id), false);
  assert.ok(fs.existsSync(path.join(dir, 'syncmanager.config.json')));
});

test('listDirs 只列非隐藏子目录并标记候选项目', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'a'));
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.mkdirSync(path.join(dir, 'proj'));
  fs.writeFileSync(path.join(dir, 'proj/filelist.json'), '[]');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  const r = listDirs(dir);
  assert.deepStrictEqual(r.dirs.map(d => [d.name, d.hint]), [['a', false], ['proj', true]]);
  assert.strictEqual(r.parent, path.dirname(dir));
});

test('添加时可自定义项目名，留空用配置 title；支持重命名', () => {
  const reg = path.join(tmp(), 'projects.json');
  const mk = title => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'syncmanager.config.json'), JSON.stringify({ title, filelist: 'f.json' }));
    return dir;
  };
  const a = addProject(reg, mk('T1'), '  我的名字 ').project;
  const b = addProject(reg, mk('T2'), '').project;
  assert.strictEqual(a.name, '我的名字');
  assert.strictEqual(b.name, 'T2');
  assert.strictEqual(renameProject(reg, a.id, '新名').name, '新名');
  assert.strictEqual(findProject(reg, a.id).name, '新名');
  assert.throws(() => renameProject(reg, a.id, '  '), /不能为空/);
  assert.strictEqual(renameProject(reg, 'nope', 'x'), null);
});

test('移动项目会将新顺序写入注册表，保留项目数据', () => {
  const dir = tmp();
  const reg = path.join(dir, 'projects.json');
  const [a, b, c] = ['Alpha', 'Bravo', 'Charlie'].map(id => ({ id, name: id, dir: path.join(dir, id) }));
  fs.writeFileSync(reg, JSON.stringify([a, b, c]));

  moveProject(reg, a.id, c.id, 'after');
  assert.deepStrictEqual(loadProjects(reg), [b, c, a]);
  moveProject(reg, a.id, b.id, 'before');
  assert.deepStrictEqual(loadProjects(reg), [a, b, c]);
});

test('拖动目标已被移除时，拒绝移动并保留其他项目', () => {
  const reg = path.join(tmp(), 'projects.json');
  const projects = [{ id: 'alpha' }, { id: 'bravo' }];
  fs.writeFileSync(reg, JSON.stringify(projects));
  assert.strictEqual(moveProject(reg, 'alpha', 'removed', 'before'), null);
  assert.deepStrictEqual(loadProjects(reg), projects);
});
