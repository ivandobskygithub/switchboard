const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  assertPathAllowed,
  addAllowedRoot,
  removeAllowedRoot,
  isWithin,
  CLAUDE_DIR,
} = require('../path-guard');

test('rejects paths outside any allowed root', () => {
  const r = assertPathAllowed('/etc/shadow', 'read');
  assert.equal(r.ok, false);
});

test('rejects empty / non-string input', () => {
  assert.equal(assertPathAllowed('', 'read').ok, false);
  assert.equal(assertPathAllowed(null, 'read').ok, false);
  assert.equal(assertPathAllowed(undefined, 'read').ok, false);
});

test('allows a file under ~/.claude/', () => {
  const target = path.join(CLAUDE_DIR, 'MEMORY.md');
  const r = assertPathAllowed(target, 'read');
  assert.equal(r.ok, true);
  assert.equal(r.resolved, path.resolve(target));
});

test('denies .credentials.json even though it is in ~/.claude/', () => {
  const target = path.join(CLAUDE_DIR, '.credentials.json');
  const r = assertPathAllowed(target, 'read');
  assert.equal(r.ok, false);
  assert.match(r.error, /sensitive/);
});

test('denies .ssh directory contents', () => {
  const target = path.join(os.homedir(), '.ssh', 'id_rsa');
  // First make it reachable by allowing the home dir (realistic misconfig)
  addAllowedRoot(os.homedir());
  try {
    const r = assertPathAllowed(target, 'read');
    assert.equal(r.ok, false);
    assert.match(r.error, /sensitive/);
  } finally {
    removeAllowedRoot(os.homedir());
  }
});

test('rejects path traversal escaping an allowed root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  try {
    const traversal = path.join(tmp, '..', '..', 'etc', 'passwd');
    const r = assertPathAllowed(traversal, 'read');
    assert.equal(r.ok, false);
  } finally {
    removeAllowedRoot(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('allows a file under an explicitly added root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  try {
    const target = path.join(tmp, 'sub', 'file.md');
    const r = assertPathAllowed(target, 'write');
    assert.equal(r.ok, true);
  } finally {
    removeAllowedRoot(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isWithin treats identical paths as within', () => {
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b/c', '/a/b'), true);
  assert.equal(isWithin('/a/c', '/a/b'), false);
});
