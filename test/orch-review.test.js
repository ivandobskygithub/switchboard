// Multi-lens review: each lens is its own session writing its own verdict
// file; Switchboard aggregates deterministically. The fake openTerminal here
// plays the lens reviewers by writing verdict files based on a configured map.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');
const { OrchWatcher } = require('../orch-watcher');
const { OrchSpawner } = require('../orch-spawner');

const MASTER = 'm-1111-2222-3333-444444444444';
const ROLES = { master: { profileId: 'opus' }, worker: { profileId: 'deepseek', maxConcurrent: 4 }, reviewer: { profileId: 'opus', maxConcurrent: 4 } };
function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-review-')); }

function activeRun(project, extra = {}) {
  const { run } = proto.createRun(project, { title: 'r', roles: ROLES, policy: { isolation: 'none', autoSpawnWorkers: false }, ...extra });
  proto.writeRun(project, { ...run, status: 'active', masterSessionId: MASTER });
  return proto.readRun(project, run.id);
}

// verdictMap: { lens: 'approved'|'changes_requested' }. Lenses not present
// default to approved. If a lens id is in `skip`, its file is NOT written
// (simulates a lens that hasn't reported yet).
function harness(project, runId, verdictMap = {}, skip = []) {
  const calls = { openTerminal: [], sendInput: [] };
  const active = new Set([MASTER]);
  const deps = {
    openTerminal: async (sessionId, cwd, isNew, opts) => {
      calls.openTerminal.push(opts);
      active.add(sessionId);
      const m = /^\/sb-review (\S+) (\S+) (\S+)/.exec(opts.initialPrompt || '');
      if (m) {
        const [, , taskId, lens] = m;
        if (!skip.includes(lens)) {
          const task = proto.readTask(project, runId, taskId);
          const round = task.reviewRound || 1;
          const verdict = verdictMap[lens] || 'approved';
          const dir = path.join(proto.runDir(project, runId), 'reviews');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${taskId}-${lens}-${round}.md`),
            `Verdict: ${verdict}\n\nfindings for ${lens}.\n`);
        }
      }
      return { ok: true };
    },
    sendInput: (id, t) => { calls.sendInput.push({ id, t }); return true; },
    isSessionActive: (id) => active.has(id),
    isSessionBusy: () => false,
    seedSessionJsonl: () => true,
    ensureTaskWorktree: async () => ({ ok: false }),
    rolePrompt: () => 'base',
    newSessionId: (() => { let n = 0; return () => `s-${++n}`; })(),
  };
  return { calls, deps };
}

test('resolveLenses scales with complexity and is configurable', () => {
  const run = proto.createRun(tmpProject(), { title: 'r', roles: ROLES }).run;
  assert.deepEqual(proto.resolveLenses(run, { complexity: 'trivial' }), ['functionality', 'style']);
  assert.deepEqual(proto.resolveLenses(run, { complexity: 'critical' }), ['spec', 'functionality', 'tests', 'security', 'style']);
  // per-task override
  assert.deepEqual(proto.resolveLenses(run, { complexity: 'trivial', lenses: ['security'] }), ['security']);
  // run-level flat override
  const run2 = proto.createRun(tmpProject(), { title: 'r', roles: ROLES, review: { lenses: ['spec', 'tests'] } }).run;
  assert.deepEqual(proto.resolveLenses(run2, { complexity: 'high' }), ['spec', 'tests']);
  // disabled
  const run3 = { ...run, review: { enabled: false } };
  assert.deepEqual(proto.resolveLenses(run3, { complexity: 'high' }), []);
});

test('parseVerdict reads many phrasings', () => {
  assert.equal(proto.parseVerdict('Verdict: approved'), 'approved');
  assert.equal(proto.parseVerdict('# Review\n**Verdict:** changes_requested'), 'changes_requested');
  assert.equal(proto.parseVerdict('verdict - REJECTED'), 'changes_requested');
  assert.equal(proto.parseVerdict('no verdict here'), null);
});

test('all lenses approve → task approved with one entry per lens', async () => {
  const project = tmpProject();
  const run = activeRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf', complexity: 'high' });
  const { calls, deps } = harness(project, run.id, {});
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project); // dispatch 5 lens reviewers (they write files)
    // 5 lens sessions, each /sb-review with a distinct lens
    const lenses = calls.openTerminal.map(o => /sb-review \S+ \S+ (\S+)/.exec(o.initialPrompt)[1]);
    assert.deepEqual(lenses.sort(), ['functionality', 'security', 'spec', 'style', 'tests']);
    watcher.refresh(project);
    await spawner.reconcile(project); // aggregate
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'approved');
    assert.equal(task.reviews.length, 5);
    assert.equal(task.pendingLenses.length, 0);
    assert.ok(proto.readEvents(project, run.id).some(e => e.type === 'review-approved'));
  } finally { spawner.stop(); watcher.dispose(); }
});

test('one lens blocks → task changes_requested (default quorum all)', async () => {
  const project = tmpProject();
  const run = activeRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf', complexity: 'high' });
  const { deps } = harness(project, run.id, { security: 'changes_requested' });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    watcher.refresh(project);
    await spawner.reconcile(project);
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'changes_requested');
    assert.ok(task.reviews.some(r => r.lens === 'security' && r.verdict === 'changes_requested'));
    assert.ok(proto.readEvents(project, run.id).some(e => e.type === 'review-changes-requested'));
  } finally { spawner.stop(); watcher.dispose(); }
});

test('aggregation waits until every lens has reported', async () => {
  const project = tmpProject();
  const run = activeRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf', complexity: 'medium' }); // 4 lenses
  const { deps } = harness(project, run.id, {}, ['tests']); // tests lens never writes
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'reviewing', 'still waiting on the tests lens');
    // tests lens finally reports
    const round = proto.readTask(project, run.id, 'T-1').reviewRound;
    fs.writeFileSync(path.join(proto.runDir(project, run.id), 'reviews', `T-1-tests-${round}.md`), 'Verdict: approved\n');
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'approved');
  } finally { spawner.stop(); watcher.dispose(); }
});

test('quorum N approves with N of M lenses', async () => {
  const project = tmpProject();
  const run = activeRun(project, { review: { lenses: ['spec', 'functionality', 'style'], quorum: 2 } });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf', complexity: 'high' });
  const { deps } = harness(project, run.id, { style: 'changes_requested' }); // 2 approve, 1 blocks
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'approved', '2/3 meets quorum 2');
  } finally { spawner.stop(); watcher.dispose(); }
});

test('a completed review aggregates even though its reviewer sessions have exited (no re-dispatch)', async () => {
  // Regression for the live-smoke bug: headless lens reviewers exit after
  // writing their files; the stale sweep must NOT recover the reviewing task
  // and inflate the round before aggregation completes it.
  const project = tmpProject();
  const run = activeRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf', complexity: 'low' }); // functionality,tests,style
  // harness writes verdict files, but mark every spawned session as INACTIVE
  // immediately (reviewers exit) by not adding them to the active set.
  const calls = { openTerminal: [] };
  const deps = {
    openTerminal: async (sessionId, cwd, isNew, opts) => {
      calls.openTerminal.push(opts);
      const m = /^\/sb-review (\S+) (\S+) (\S+)/.exec(opts.initialPrompt || '');
      if (m) {
        const [, , taskId, lens] = m;
        const round = proto.readTask(project, run.id, taskId).reviewRound || 1;
        const dir = path.join(proto.runDir(project, run.id), 'reviews');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${taskId}-${lens}-${round}.md`), 'Verdict: approved\n');
      }
      return { ok: true }; // session is NOT added to any active set → "exited"
    },
    sendInput: () => true,
    isSessionActive: () => false, // every reviewer session has already exited
    isSessionBusy: () => false,
    seedSessionJsonl: () => true,
    ensureTaskWorktree: async () => ({ ok: false }),
    rolePrompt: () => 'base',
    newSessionId: (() => { let n = 0; return () => `s-${++n}`; })(),
  };
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps, staleGraceMs: 10 });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);          // dispatch 3 lenses (sessions exit, files written)
    const dispatched = calls.openTerminal.length;
    assert.equal(dispatched, 3);
    await new Promise(r => setTimeout(r, 40));  // exceed the stale grace
    watcher.refresh(project);
    await spawner.reconcile(project);          // aggregation must win over the sweep
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'approved');
    assert.equal(task.reviewRound, 1, 'round must not have been inflated by a spurious re-dispatch');
    assert.equal(calls.openTerminal.length, dispatched, 'no extra reviewers spawned');
    assert.ok(!proto.readEvents(project, run.id).some(e => e.type === 'review-stuck'));
  } finally { spawner.stop(); watcher.dispose(); }
});

test('review disabled → auto-approve without spawning a reviewer', async () => {
  const project = tmpProject();
  const run = activeRun(project, { review: { enabled: false } });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf', complexity: 'high' });
  const { calls, deps } = harness(project, run.id);
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0);
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'approved');
    assert.ok(task.reviews[0].autoApproved);
  } finally { spawner.stop(); watcher.dispose(); }
});

test('rework after multi-lens points the worker at the rejected lens files', async () => {
  const project = tmpProject();
  const run = activeRun(project, { policy: { isolation: 'none' } }); // autoSpawnWorkers default true
  proto.writeRun(project, { ...proto.readRun(project, run.id), policy: { ...proto.readRun(project, run.id).policy, autoSpawnWorkers: true } });
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'changes_requested', kind: 'leaf', complexity: 'medium',
    sessionIds: ['w-old'], attempts: 1, reviewRound: 1,
    reviews: [
      { file: 'reviews/T-1-spec-1.md', verdict: 'approved', lens: 'spec', round: 1 },
      { file: 'reviews/T-1-security-1.md', verdict: 'changes_requested', lens: 'security', round: 1 },
      { file: 'reviews/T-1-tests-1.md', verdict: 'changes_requested', lens: 'tests', round: 1 },
    ],
  });
  const { calls, deps } = harness(project, run.id);
  // worker session not active → resume path opens a terminal with the prompt
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    const reworkPrompt = calls.openTerminal.map(o => o.initialPrompt).find(p => /sb-work/.test(p));
    assert.ok(reworkPrompt, 'rework dispatched');
    assert.match(reworkPrompt, /reviews\/T-1-security-1\.md/);
    assert.match(reworkPrompt, /reviews\/T-1-tests-1\.md/);
    assert.ok(!/T-1-spec-1/.test(reworkPrompt), 'approved lens not included');
  } finally { spawner.stop(); watcher.dispose(); }
});
