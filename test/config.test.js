const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadConfig, publicConfig } = require('../lib/config');
const { runSteps } = require('../lib/gen-client-runner');

function writeCfg(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cfg-'));
  const p = path.join(dir, 'syncmanager.config.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return { dir, p };
}

test('loadConfig 相对路径按配置文件目录解析，并带默认值', () => {
  const { dir, p } = writeCfg({ filelist: 'a/filelist.json' });
  const cfg = loadConfig(p);
  assert.strictEqual(cfg.filelistPath, path.join(dir, 'a/filelist.json'));
  assert.strictEqual(cfg.statePath, path.join(dir, '.sync_state.json'));
  assert.strictEqual(cfg.exportUrl, null);
  assert.strictEqual(cfg.allowUpload, true);
  assert.strictEqual(cfg.sidecarPath, null);
  assert.strictEqual(cfg.port, 7321);
});

test('loadConfig 缺少 filelist / 文件不存在 都报错', () => {
  assert.throws(() => loadConfig('/nonexistent/x.json'), /找不到配置文件/);
  assert.throws(() => loadConfig(writeCfg({}).p), /filelist/);
});

test('actions 的 command 支持字符串与 {unix,win}', () => {
  const { p } = writeCfg({
    filelist: 'f',
    actions: [{ id: 'a', label: 'A', steps: [{ command: 'echo hi' }, { command: { unix: 'u' } }] }]
  });
  const [a] = loadConfig(p).actions;
  assert.deepStrictEqual(a.steps[0].command, { unix: 'echo hi', win: 'echo hi' });
  assert.deepStrictEqual(a.steps[1].command, { unix: 'u', win: 'u' });
});

test('publicConfig 不暴露密码与绝对路径', () => {
  const { p } = writeCfg({ filelist: 'f', export: { url: 'http://x', password: 'secret' } });
  const json = JSON.stringify(publicConfig(loadConfig(p)));
  assert.ok(!json.includes('secret'));
  assert.ok(!json.includes(os.tmpdir()));
});

test('overrides.statePath 把同步状态指到平台数据目录', () => {
  const { p } = writeCfg({ filelist: 'f' });
  assert.strictEqual(loadConfig(p, { statePath: '/data/x/.sync_state.json' }).statePath, '/data/x/.sync_state.json');
});

test('runSteps 按序执行，失败即中止', async () => {
  const logs = [];
  const mk = (label, cmd) => ({ label, cwd: os.tmpdir(), command: { unix: cmd, win: cmd } });
  await runSteps({ steps: [mk('one', 'echo first'), mk('two', 'echo second')], platform: 'linux', onLog: l => logs.push(l) });
  assert.match(logs.join(''), /first[\s\S]*second/);
  const logs2 = [];
  await assert.rejects(
    runSteps({ steps: [mk('bad', 'exit 3'), mk('never', 'echo nope')], platform: 'linux', onLog: l => logs2.push(l) }),
    /exit 3/
  );
  assert.ok(!logs2.join('').includes('nope'));
});
