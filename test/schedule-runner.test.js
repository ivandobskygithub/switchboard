const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildScheduleCommand,
  cronMatches,
  parseFrontmatter,
} = require('../schedule-runner');

const UID = '12345678-aaaa-bbbb-cccc-1234567890ab';

// ── buildScheduleCommand: happy paths ────────────────────────────────

test('builds a minimal schedule command with defaults', () => {
  const r = buildScheduleCommand(UID, { cli: {} });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /^claude --resume '[0-9a-fA-F-]+' -p 'Run the scheduled task'/);
  assert.ok(r.cmd.includes(`--permission-mode 'acceptEdits'`));
  assert.ok(r.cmd.includes('--allowedTools'));
});

test('respects a whitelisted permission-mode', () => {
  const r = buildScheduleCommand(UID, { cli: { 'permission-mode': 'plan' } });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /--permission-mode 'plan'/);
});

test('passes a valid model through', () => {
  const r = buildScheduleCommand(UID, { cli: { model: 'claude-sonnet-4-5' } });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /--model 'claude-sonnet-4-5'/);
});

// ── Injection rejection ──────────────────────────────────────────────

test('rejects permission-mode with metacharacters', () => {
  for (const v of ['$(id)', '`whoami`', 'plan; rm -rf ~', 'plan\n', 'acceptEdits || curl evil']) {
    const r = buildScheduleCommand(UID, { cli: { 'permission-mode': v } });
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(v)}`);
  }
});

test('rejects model with metacharacters', () => {
  for (const v of ['$(id)', '`whoami`', 'opus; rm -rf ~', 'claude/../../../etc', 'claude opus']) {
    const r = buildScheduleCommand(UID, { cli: { model: v } });
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(v)}`);
  }
});

test('rejects tools outside the whitelist', () => {
  const r = buildScheduleCommand(UID, {
    cli: { 'allowed-tools': 'Bash,Read,$(evil),WebFetch' },
  });
  assert.equal(r.ok, false);
});

test('rejects append-system-prompt without rejecting — it is fully shq-escaped', () => {
  // append-system-prompt is user content; we allow arbitrary data but
  // shell-escape it so the shell only ever sees it as a literal argument.
  const r = buildScheduleCommand(UID, {
    cli: { 'append-system-prompt': '"; rm -rf ~; echo "' },
  });
  assert.equal(r.ok, true);
  // The entire value is wrapped in single quotes; the inner metachars are
  // neutralised.
  assert.ok(r.cmd.includes('--append-system-prompt'));
  // No bare sequence of ; rm -rf in the resulting command (would only appear
  // inside single-quoted literal).
  assert.ok(!/\s;\s*rm\s/.test(r.cmd.replace(/'[^']*'/g, "''")));
});

test('rejects relative add-dir values (path traversal vector)', () => {
  for (const v of ['../etc', './secrets', '..\\windows', 'relative/path']) {
    const r = buildScheduleCommand(UID, { cli: { 'add-dirs': v } });
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(v)}`);
  }
});

test('accepts absolute add-dir paths and shell-quotes them', () => {
  const r = buildScheduleCommand(UID, { cli: { 'add-dirs': '/tmp/a,/tmp/b' } });
  assert.equal(r.ok, true);
  const matches = r.cmd.match(/--add-dir '[^']+'/g) || [];
  assert.equal(matches.length, 2);
});

test('rejects max-budget-usd that is not a plain number', () => {
  for (const v of ['$(id)', '10; rm', '10x', 'NaN', '1e10']) {
    const r = buildScheduleCommand(UID, { cli: { 'max-budget-usd': v } });
    assert.equal(r.ok, false, `expected reject for ${v}`);
  }
});

test('accepts a numeric max-budget-usd', () => {
  const r = buildScheduleCommand(UID, { cli: { 'max-budget-usd': '5.00' } });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /--max-budget-usd 5\.00/);
});

test('rejects non-UUID sessionId', () => {
  const r = buildScheduleCommand('$(curl evil)', { cli: {} });
  assert.equal(r.ok, false);
});

// ── cronMatches ──────────────────────────────────────────────────────

test('cronMatches: 5-field expr with exact values', () => {
  const now = new Date('2025-01-15T09:30:00');
  assert.equal(cronMatches('30 9 15 1 3', now), true); // Wed (3)
});

test('cronMatches: wildcard matches every minute', () => {
  assert.equal(cronMatches('* * * * *', new Date()), true);
});

test('cronMatches: malformed expr does not throw', () => {
  assert.equal(cronMatches('not valid', new Date()), false);
  assert.equal(cronMatches('1 2 3', new Date()), false);
});

// ── parseFrontmatter ─────────────────────────────────────────────────

test('parseFrontmatter extracts meta and body', () => {
  const src = `---\nname: hello\ncron: "* * * * *"\n---\nBody content\n`;
  const { meta, body } = parseFrontmatter(src);
  assert.equal(meta.name, 'hello');
  assert.match(meta.cron, /\* \* \* \* \*/);
  assert.equal(body, 'Body content');
});

test('parseFrontmatter handles nested cli block', () => {
  const src = `---\nname: hi\ncli:\n  model: opus\n  permission-mode: plan\n---\nbody\n`;
  const { meta } = parseFrontmatter(src);
  assert.equal(meta.cli.model, 'opus');
  assert.equal(meta.cli['permission-mode'], 'plan');
});
