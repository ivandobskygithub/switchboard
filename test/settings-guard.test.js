const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedSettingKey, MAX_KEY_LENGTH } = require('../settings-guard');

test('accepts the three known patterns', () => {
  assert.equal(isAllowedSettingKey('global'), true);
  assert.equal(isAllowedSettingKey('searchTitlesOnly'), true);
  assert.equal(isAllowedSettingKey('project:/Users/me/foo'), true);
  assert.equal(isAllowedSettingKey('project:C:\\Users\\me\\foo'), true);
});

test('rejects unknown keys', () => {
  for (const k of ['', 'foo', 'GLOBAL', 'Global', 'project', 'project:', 'schedule:something', 'cron:run']) {
    assert.equal(isAllowedSettingKey(k), false, `should reject ${JSON.stringify(k)}`);
  }
});

test('rejects non-string input', () => {
  for (const v of [null, undefined, 0, 1, {}, [], true, Symbol('x')]) {
    assert.equal(isAllowedSettingKey(v), false);
  }
});

test('rejects control characters and NUL', () => {
  assert.equal(isAllowedSettingKey('global\x00'), false);
  assert.equal(isAllowedSettingKey('project:\n/path'), false);
  assert.equal(isAllowedSettingKey('\tglobal'), false);
  assert.equal(isAllowedSettingKey('project:\x1b[0m/path'), false);
});

test('rejects oversized keys', () => {
  const base = 'project:';
  const overLimit = base + 'a'.repeat(MAX_KEY_LENGTH + 1);
  assert.equal(isAllowedSettingKey(overLimit), false);
});

test('accepts project: key at exactly the max length', () => {
  const base = 'project:';
  const atLimit = base + 'a'.repeat(MAX_KEY_LENGTH - base.length);
  assert.equal(atLimit.length, MAX_KEY_LENGTH);
  assert.equal(isAllowedSettingKey(atLimit), true);
});

test('project: key cannot be bare (no empty suffix)', () => {
  assert.equal(isAllowedSettingKey('project:'), false);
});
