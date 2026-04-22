const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeExternalUrl, MAX_URL_LENGTH } = require('../url-guard');

test('accepts plain http and https', () => {
  assert.equal(isSafeExternalUrl('http://example.com'), true);
  assert.equal(isSafeExternalUrl('https://example.com/path?q=1'), true);
  assert.equal(isSafeExternalUrl('https://sub.example.com:8443/a/b'), true);
});

test('rejects non-http schemes', () => {
  for (const url of [
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'vscode://file/etc/passwd',
    'ssh://user@host',
    'ftp://example.com',
    'chrome://settings',
    'about:blank',
  ]) {
    assert.equal(isSafeExternalUrl(url), false, `expected reject for ${url}`);
  }
});

test('rejects urls with credentials', () => {
  assert.equal(isSafeExternalUrl('https://user:pw@example.com/'), false);
  assert.equal(isSafeExternalUrl('https://user@example.com/'), false);
});

test('rejects urls with control characters', () => {
  assert.equal(isSafeExternalUrl('http://example.com/\x00'), false);
  assert.equal(isSafeExternalUrl('http://example.com/\nHeader-Injection'), false);
});

test('rejects non-string and empty / oversized input', () => {
  assert.equal(isSafeExternalUrl(null), false);
  assert.equal(isSafeExternalUrl(undefined), false);
  assert.equal(isSafeExternalUrl(42), false);
  assert.equal(isSafeExternalUrl(''), false);
  assert.equal(isSafeExternalUrl('http://' + 'a'.repeat(MAX_URL_LENGTH)), false);
});

test('rejects garbage that is not parseable as a URL', () => {
  assert.equal(isSafeExternalUrl('not a url'), false);
  assert.equal(isSafeExternalUrl('://missing'), false);
  assert.equal(isSafeExternalUrl('://'), false);
});

test('accepts IP-literal URLs (127.0.0.1, etc)', () => {
  assert.equal(isSafeExternalUrl('http://127.0.0.1:8080/'), true);
  assert.equal(isSafeExternalUrl('http://[::1]/'), true);
});
