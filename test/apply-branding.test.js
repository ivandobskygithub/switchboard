const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const script = path.join(repoRoot, 'scripts', 'apply-branding.js');
const outPath = path.join(repoRoot, 'electron-builder-config.json');

// These tests mutate a generated file in the repo root. They always restore
// it by running apply-branding.js with the default skin at the end.
function runScript(env = {}) {
  const merged = { ...process.env, ...env };
  for (const k of ['SWITCHBOARD_BRANDING', 'SWITCHBOARD_SKIN']) {
    if (!(k in env)) delete merged[k];
  }
  const r = spawnSync(process.execPath, [script], { env: merged, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('apply-branding exited ' + r.status + ': ' + r.stderr);
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

test('generates a config from the default skin', () => {
  const cfg = runScript();
  assert.equal(cfg.appId, 'ai.doctly.switchboard');
  assert.equal(cfg.productName, 'Switchboard');
  assert.ok(cfg.mac); // inherited from package.json build block
});

test('SWITCHBOARD_BRANDING override replaces appId + productName', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'));
  fs.writeFileSync(path.join(tmp, 'branding.json'), JSON.stringify({
    productName: 'Branded',
    appId: 'com.example.branded',
    windowTitle: 'Branded',
    mcpIdeName: 'Branded',
    tmpFilePrefix: 'branded',
    publish: { provider: 'generic', url: 'https://internal/' },
  }));
  try {
    const cfg = runScript({ SWITCHBOARD_BRANDING: tmp });
    assert.equal(cfg.appId, 'com.example.branded');
    assert.equal(cfg.productName, 'Branded');
    assert.deepEqual(cfg.publish, { provider: 'generic', url: 'https://internal/' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('publish field is removed when branding.json omits it', () => {
  const cfg = runScript();
  assert.equal(cfg.publish, undefined);
});

test('per-platform overrides merge into mac/win/linux blocks', () => {
  const dir = path.join(repoRoot, 'skins', 'ztest-platform');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'branding.json'), JSON.stringify({
    productName: 'PlatformTest',
    appId: 'com.pt.app',
    windowTitle: 'PT', mcpIdeName: 'PT', tmpFilePrefix: 'pt',
    mac: { notarize: false },
    linux: { target: ['AppImage'] },
  }));
  try {
    const cfg = runScript({ SWITCHBOARD_SKIN: 'ztest-platform' });
    assert.equal(cfg.mac.notarize, false);
    assert.deepEqual(cfg.linux.target, ['AppImage']);
    // Still inherits fields it didn't override.
    assert.ok(cfg.mac.entitlements);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    runScript(); // restore default config
  }
});

test.after(() => {
  try { runScript(); } catch {}
});
