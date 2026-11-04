'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEnvOutput, mergeEnv } = require('../lib/shell-env');

const M = '__CSM_ENV__';

test('parseEnvOutput 忽略 shell 启动时打印的噪声，只取标记之间的内容', () => {
  const out = `Welcome!\n${M}PATH=/opt/homebrew/bin:/usr/bin\0FOO=a=b\0MULTI=x\ny\0${M}bye`;
  assert.deepStrictEqual(parseEnvOutput(out), { PATH: '/opt/homebrew/bin:/usr/bin', FOO: 'a=b', MULTI: 'x\ny' });
});

test('parseEnvOutput 没有标记时返回空对象', () => {
  assert.deepStrictEqual(parseEnvOutput('garbage'), {});
});

test('mergeEnv 以 shell 的 PATH 为准，其余只补缺失项，跳过 ELECTRON_ 与 PWD', () => {
  const target = { PATH: '/usr/bin', HOME: '/Users/a', ELECTRON_RUN_AS_NODE: '1' };
  mergeEnv(target, { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/b', JAVA_HOME: '/jdk', ELECTRON_RUN_AS_NODE: '0', PWD: '/x' });
  assert.deepStrictEqual(target, { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/a', ELECTRON_RUN_AS_NODE: '1', JAVA_HOME: '/jdk' });
});
