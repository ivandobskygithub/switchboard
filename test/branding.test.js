const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const loadInChild = (envOverrides = {}) => {
  const env = { ...process.env, ...envOverrides };
  // Clear anything we don't set explicitly so the parent's env doesn't leak.
  for (const k of ['SWITCHBOARD_BRANDING', 'SWITCHBOARD_SKIN']) {
    if (!(k in envOverrides)) delete env[k];
  }
  const code = `const b = require(${JSON.stringify(path.join(repoRoot, 'branding.js'))}); process.stdout.write(JSON.stringify(b));`;
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('child exited ' + r.status + ': ' + r.stderr);
  return JSON.parse(r.stdout);
};

test('default skin loads when nothing is set', () => {
  const b = loadInChild({});
  assert.equal(b.productName, 'Switchboard');
  assert.equal(b.appId, 'ai.doctly.switchboard');
  assert.equal(typeof b.strings, 'object');
});

test('SWITCHBOARD_SKIN selects an in-tree skin directory', () => {
  const dir = path.join(repoRoot, 'skins', 'ztest-branding');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'branding.json'), JSON.stringify({
    productName: 'ZTest',
    appId: 'com.ztest.app',
    windowTitle: 'ZTest',
    mcpIdeName: 'ZTest',
    tmpFilePrefix: 'ztest',
  }));
  try {
    const b = loadInChild({ SWITCHBOARD_SKIN: 'ztest-branding' });
    assert.equal(b.productName, 'ZTest');
    assert.equal(b.appId, 'com.ztest.app');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SWITCHBOARD_BRANDING file path wins over SWITCHBOARD_SKIN', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
  const file = path.join(tmp, 'branding.json');
  fs.writeFileSync(file, JSON.stringify({
    productName: 'AbsPath',
    appId: 'com.abs.path',
    windowTitle: 'AbsPath',
    mcpIdeName: 'AbsPath',
    tmpFilePrefix: 'abs',
  }));
  try {
    const b = loadInChild({ SWITCHBOARD_BRANDING: file, SWITCHBOARD_SKIN: 'switchboard' });
    assert.equal(b.productName, 'AbsPath');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SWITCHBOARD_BRANDING accepts a directory containing branding.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-dir-'));
  fs.writeFileSync(path.join(tmp, 'branding.json'), JSON.stringify({
    productName: 'AbsDir',
    appId: 'com.abs.dir',
    windowTitle: 'AbsDir',
    mcpIdeName: 'AbsDir',
    tmpFilePrefix: 'absdir',
  }));
  try {
    const b = loadInChild({ SWITCHBOARD_BRANDING: tmp });
    assert.equal(b.productName, 'AbsDir');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('strings overlay is loaded and _comment stripped', () => {
  const dir = path.join(repoRoot, 'skins', 'ztest-strings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'branding.json'), JSON.stringify({
    productName: 'ZTestS', appId: 'com.z.s', windowTitle: 'ZTestS', mcpIdeName: 'ZTestS', tmpFilePrefix: 'zs',
  }));
  fs.writeFileSync(path.join(dir, 'strings.json'), JSON.stringify({
    _comment: 'should be stripped',
    sidebar_sessions: 'Convos',
  }));
  try {
    const b = loadInChild({ SWITCHBOARD_SKIN: 'ztest-strings' });
    assert.equal(b.strings.sidebar_sessions, 'Convos');
    assert.equal('_comment' in b.strings, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing strings.json yields empty strings object (not undefined)', () => {
  const dir = path.join(repoRoot, 'skins', 'ztest-nostrings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'branding.json'), JSON.stringify({
    productName: 'ZTestN', appId: 'com.z.n', windowTitle: 'ZTestN', mcpIdeName: 'ZTestN', tmpFilePrefix: 'zn',
  }));
  try {
    const b = loadInChild({ SWITCHBOARD_SKIN: 'ztest-nostrings' });
    assert.deepEqual(b.strings, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown skin name falls back to inline defaults without throwing', () => {
  const b = loadInChild({ SWITCHBOARD_SKIN: 'definitely-does-not-exist-xyz' });
  assert.equal(b.productName, 'Switchboard');
  assert.equal(b.appId, 'local.switchboard');
});

test('malformed branding.json falls back to inline defaults', () => {
  const dir = path.join(repoRoot, 'skins', 'ztest-bad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'branding.json'), '{not valid json}');
  try {
    const b = loadInChild({ SWITCHBOARD_SKIN: 'ztest-bad' });
    assert.equal(b.productName, 'Switchboard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
