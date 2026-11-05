const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const backups = require('../lib/backups');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-bk-'));
  const root = path.join(dir, 'backups');
  const file = path.join(dir, 'Datas', 'Item.xlsx');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { dir, root, file };
}

test('backupFile：文件不存在返回 null；相同内容不重复备份', () => {
  const { root, file } = setup();
  assert.strictEqual(backups.backupFile(root, 'Datas/Item.xlsx', file), null);
  fs.writeFileSync(file, 'v1');
  const a = backups.backupFile(root, 'Datas/Item.xlsx', file, { reason: 'r' });
  assert.strictEqual(a.deduped, false);
  const b = backups.backupFile(root, 'Datas/Item.xlsx', file);
  assert.strictEqual(b.deduped, true);
  assert.strictEqual(b.id, a.id);
  const list = backups.listBackups(root, 'Datas/Item.xlsx');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].reason, 'r');
});

test('backupFile：只保留最近 keep 份，新的在前', () => {
  const { root, file } = setup();
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(file, `v${i}`);
    backups.backupFile(root, 'Datas/Item.xlsx', file, { keep: 3, now: new Date(2026, 0, 1, 0, 0, i) });
  }
  const list = backups.listBackups(root, 'Datas/Item.xlsx');
  assert.strictEqual(list.length, 3);
  assert.ok(list[0].id > list[1].id && list[1].id > list[2].id);
  assert.strictEqual(fs.readFileSync(path.join(root, 'Datas', 'Item.xlsx', list[0].id), 'utf8'), 'v4');
});

test('restoreBackup：恢复前先备份当前文件，恢复后内容正确', () => {
  const { root, file } = setup();
  fs.writeFileSync(file, 'old');
  const saved = backups.backupFile(root, 'Datas/Item.xlsx', file, { now: new Date(2026, 0, 1) });
  fs.writeFileSync(file, 'new');
  const r = backups.restoreBackup(root, 'Datas/Item.xlsx', saved.id, file, { now: new Date(2026, 0, 2) });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old');
  assert.ok(r.backupBefore && !r.backupBefore.deduped);
  assert.strictEqual(backups.listBackups(root, 'Datas/Item.xlsx').length, 2);
});

test('路径与备份 ID 不能跳出备份目录', () => {
  const { root, file } = setup();
  fs.writeFileSync(file, 'x');
  assert.throws(() => backups.backupPath(root, 'Datas/Item.xlsx', '../../etc/passwd'), /无效的备份 ID/);
  const r = backups.backupFile(root, '../../outside/Item.xlsx', file);
  assert.ok(fs.existsSync(path.join(root, 'outside', 'Item.xlsx', r.id)), '.. 段被丢弃，仍在备份根目录内');
});
