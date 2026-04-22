const test = require('node:test');
const assert = require('node:assert/strict');
const { originAllowed, tokenMatches, validateHandshake } = require('../mcp-auth');

test('originAllowed: no headers → allowed', () => {
  assert.equal(originAllowed(null), true);
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed({}), true);
});

test('originAllowed: absent Origin header → allowed', () => {
  assert.equal(originAllowed({ host: '127.0.0.1:1234' }), true);
});

test('originAllowed: present Origin header → denied', () => {
  assert.equal(originAllowed({ origin: 'https://evil.example' }), false);
  assert.equal(originAllowed({ Origin: 'https://evil.example' }), false);
  assert.equal(originAllowed({ ORIGIN: 'https://evil.example' }), false);
});

test('originAllowed: empty Origin value → allowed (not actually set)', () => {
  assert.equal(originAllowed({ origin: '' }), true);
});

test('tokenMatches: exact match → true', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
});

test('tokenMatches: mismatch → false', () => {
  assert.equal(tokenMatches('abc123', 'abc124'), false);
});

test('tokenMatches: length differences → false (no exception)', () => {
  assert.equal(tokenMatches('abc', 'abc123'), false);
  assert.equal(tokenMatches('abc123', 'abc'), false);
});

test('tokenMatches: empty / null / undefined → false', () => {
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches('abc', ''), false);
  assert.equal(tokenMatches(null, 'abc'), false);
  assert.equal(tokenMatches('abc', null), false);
  assert.equal(tokenMatches(undefined, undefined), false);
});

test('tokenMatches: non-string input does not throw', () => {
  assert.equal(tokenMatches(42, 'abc'), false);
  assert.equal(tokenMatches({}, 'abc'), false);
  assert.equal(tokenMatches('abc', 42), false);
});

test('validateHandshake: happy path', () => {
  const req = { headers: { 'x-claude-code-ide-authorization': 'token-x' } };
  const r = validateHandshake(req, 'token-x');
  assert.equal(r.ok, true);
});

test('validateHandshake: rejects request with Origin header', () => {
  const req = { headers: { origin: 'http://attacker', 'x-claude-code-ide-authorization': 'token-x' } };
  const r = validateHandshake(req, 'token-x');
  assert.equal(r.ok, false);
  assert.equal(r.code, 4003);
});

test('validateHandshake: wrong token → 4001', () => {
  const req = { headers: { 'x-claude-code-ide-authorization': 'nope' } };
  const r = validateHandshake(req, 'token-x');
  assert.equal(r.ok, false);
  assert.equal(r.code, 4001);
});

test('validateHandshake: missing token header → 4001', () => {
  const req = { headers: {} };
  const r = validateHandshake(req, 'token-x');
  assert.equal(r.ok, false);
  assert.equal(r.code, 4001);
});

test('validateHandshake: req with no headers → 4001 (no crash)', () => {
  const r = validateHandshake({}, 'token-x');
  assert.equal(r.ok, false);
  assert.equal(r.code, 4001);
});

test('validateHandshake: null/undefined req → 4001 (no crash)', () => {
  assert.equal(validateHandshake(null, 'token-x').ok, false);
  assert.equal(validateHandshake(undefined, 'token-x').ok, false);
});
