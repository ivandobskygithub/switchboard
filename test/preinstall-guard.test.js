const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', 'scripts', 'preinstall-guard.js');

function run(env) {
  return spawnSync(process.execPath, [script], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

test('blocks npm install without opt-in env var', () => {
  const r = run({ npm_command: 'install', SWITCHBOARD_ALLOW_NPM_INSTALL: '' });
  assert.notEqual(r.status, 0, 'expected non-zero exit');
  assert.match(r.stderr, /npm install/);
});

test('allows npm ci', () => {
  const r = run({ npm_command: 'ci', SWITCHBOARD_ALLOW_NPM_INSTALL: '' });
  assert.equal(r.status, 0);
});

test('allows npm install when SWITCHBOARD_ALLOW_NPM_INSTALL=1', () => {
  const r = run({ npm_command: 'install', SWITCHBOARD_ALLOW_NPM_INSTALL: '1' });
  assert.equal(r.status, 0);
});

test('allows an unset npm_command (e.g. direct node invocation)', () => {
  const r = run({ npm_command: '', SWITCHBOARD_ALLOW_NPM_INSTALL: '' });
  assert.equal(r.status, 0);
});

test('other npm lifecycles (run, test) are not blocked', () => {
  for (const cmd of ['run-script', 'test', 'ls']) {
    const r = run({ npm_command: cmd, SWITCHBOARD_ALLOW_NPM_INSTALL: '' });
    assert.equal(r.status, 0, `expected pass for ${cmd}`);
  }
});
