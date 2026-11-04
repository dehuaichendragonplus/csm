const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runCommand, resolveScriptCommand } = require('../lib/gen-client-runner');

test('runCommand resolves on exit 0 and captures stdout', async () => {
  const lines = [];
  const code = await runCommand({
    command: process.execPath, // node binary, always present
    args: ['-e', 'console.log("hello"); console.log("world")'],
    cwd: os.tmpdir(),
    onLog: line => lines.push(line)
  });
  assert.strictEqual(code, 0);
  const joined = lines.join('');
  assert.match(joined, /hello/);
  assert.match(joined, /world/);
});

test('runCommand rejects on non-zero exit', async () => {
  await assert.rejects(
    runCommand({
      command: process.execPath,
      args: ['-e', 'process.exit(2)'],
      cwd: os.tmpdir(),
      onLog: () => {}
    }),
    /exit 2/
  );
});

test('runCommand captures stderr too', async () => {
  const lines = [];
  await runCommand({
    command: process.execPath,
    args: ['-e', 'console.error("oops"); process.exit(0)'],
    cwd: os.tmpdir(),
    onLog: line => lines.push(line)
  });
  assert.match(lines.join(''), /oops/);
});

test('resolveScriptCommand returns cmd.exe + .bat on win32', () => {
  const { command, args } = resolveScriptCommand('gen_client', 'win32');
  assert.strictEqual(command, 'cmd.exe');
  assert.deepStrictEqual(args, ['/c', 'gen_client.bat']);
});

test('resolveScriptCommand returns bash + .sh on non-win32 platforms', () => {
  const { command, args } = resolveScriptCommand('gen_localization', 'darwin');
  assert.strictEqual(command, 'bash');
  assert.deepStrictEqual(args, ['gen_localization.sh']);
});
