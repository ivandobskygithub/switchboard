// Hardening tests for orch-spawner: failure rollbacks, attempt boundaries,
// dead-session recovery, orphan detection, and idle-pass economy. These
// cover the failure paths a long-running fully-automated run WILL hit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');
const { OrchWatcher } = require('../orch-watcher');
const { OrchSpawner } = require('../orch-spawner');

const MASTER = 'master-1111-2222-3333-444444444444';
const ROLES = {
  master: { profileId: 'anthropic' },
  worker: { profileId: 'deepseek', maxConcurrent: 4 },
  reviewer: { profileId: 'anthropic', maxConcurrent: 2 },
};

function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hard-')); }

function makeActiveRun(project, policy = {}) {
  const { run } = proto.createRun(project, {
    title: 'hardening', roles: ROLES, policy: { isolation: 'none', ...policy },
  });
  const active = { ...run, status: 'active', masterSessionId: MASTER };
  proto.writeRun(project, active);
  return active;
}

function makeHarness(overrides = {}) {
  const calls = { openTerminal: [], sendInput: [] };
  let counter = 0;
  const activeSessions = new Set([MASTER]);
  const deps = {
    openTerminal: async (sessionId, cwd, isNew, opts) => {
      calls.openTerminal.push({ sessionId, cwd, isNew, opts });
      activeSessions.add(sessionId);
      return { ok: true };
    },
    sendInput: (sessionId, text) => { calls.sendInput.push({ sessionId, text }); return true; },
    isSessionActive: (id) => activeSessions.has(id),
    isSessionBusy: () => false,
    seedSessionJsonl: () => true,
    ensureTaskWorktree: async () => ({ ok: false, error: 'not expected in this test' }),
    rolePrompt: (role) => `prompt for ${role}`,
    newSessionId: () => `sess-${String(++counter).padStart(4, '0')}-aaaa-bbbb-cccc`,
    ...overrides,
  };
  return { calls, deps, activeSessions };
}

test('reviewer spawn failure rolls back to needs_review and restores reviewSessionIds', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf', reviewSessionIds: ['old-review'],
  });
  const { deps } = makeHarness({
    openTerminal: async () => ({ ok: false, error: 'pty exploded' }),
  });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'needs_review');
    assert.deepEqual(task.reviewSessionIds, ['old-review'], 'failed spawn id must not linger');
    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'review-spawn-failed' && /pty exploded/.test(e.error)));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('maxAttempts is an exact boundary: N failed spawns, no N+1th attempt', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project, { maxAttempts: 2 });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  const { calls, deps } = makeHarness({
    openTerminal: async (...args) => {
      calls.openTerminal.push(args);
      return { ok: false, error: 'always fails' };
    },
  });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    for (let i = 0; i < 4; i++) {
      watcher.refresh(project);
      await spawner.reconcile(project);
    }
    assert.equal(calls.openTerminal.length, 2, 'exactly maxAttempts spawn attempts');
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'blocked');
    assert.equal(task.attempts, 2);
    assert.match(task.blockedReason, /max attempts/);
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('worktree preparation failure rolls back without ever opening a terminal', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project, { isolation: 'worktree' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  const { calls, deps } = makeHarness({
    ensureTaskWorktree: async () => ({ ok: false, error: 'git imploded' }),
  });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0);
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'ready');
    assert.equal(task.attempts, 1);
    assert.equal(task.pendingSessionId, null);
    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'spawn-failed' && /git imploded/.test(e.error)));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('rework falls back to terminal resume when PTY input write fails', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  const { calls, deps, activeSessions } = makeHarness({
    sendInput: (sessionId, text) => { calls.sendInput.push({ sessionId, text }); return false; },
  });
  activeSessions.add('w-original');
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'changes_requested', kind: 'leaf',
    sessionIds: ['w-original'], attempts: 1,
  });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.sendInput.length, 1, 'input write attempted first');
    assert.equal(calls.openTerminal.length, 1, 'falls back to resume');
    assert.equal(calls.openTerminal[0].sessionId, 'w-original');
    assert.equal(calls.openTerminal[0].isNew, false);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'in_progress');
    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'rework-resumed'));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('stale sweep recovers tasks whose sessions died (worker, reviewer, spawner crash)', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project, { autoSpawnWorkers: false, autoSpawnReviewers: false });
  proto.writeTask(project, run.id, {
    id: 'T-work', title: 'a', status: 'in_progress', kind: 'leaf', sessionIds: ['dead-worker'],
  });
  proto.writeTask(project, run.id, {
    id: 'T-rev', title: 'b', status: 'reviewing', kind: 'leaf', reviewSessionIds: ['dead-reviewer'],
  });
  proto.writeTask(project, run.id, {
    id: 'T-spawn', title: 'c', status: 'spawning', kind: 'leaf', pendingSessionId: 'never-arrived', attempts: 1,
  });
  proto.writeTask(project, run.id, {
    id: 'T-live', title: 'd', status: 'in_progress', kind: 'leaf', sessionIds: ['alive-worker'],
  });

  const { deps, activeSessions } = makeHarness();
  activeSessions.add('alive-worker');
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps, staleGraceMs: 30 });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);       // first sighting — grace starts
    assert.equal(proto.readTask(project, run.id, 'T-work').status, 'in_progress');
    await new Promise(r => setTimeout(r, 60));
    watcher.refresh(project);
    await spawner.reconcile(project);       // grace elapsed — recover

    const work = proto.readTask(project, run.id, 'T-work');
    assert.equal(work.status, 'failed');
    assert.match(work.failReason, /session ended/);
    assert.equal(proto.readTask(project, run.id, 'T-rev').status, 'needs_review');
    const spawnTask = proto.readTask(project, run.id, 'T-spawn');
    assert.equal(spawnTask.status, 'ready');
    assert.equal(spawnTask.pendingSessionId, null);
    assert.equal(proto.readTask(project, run.id, 'T-live').status, 'in_progress', 'live session untouched');

    const types = proto.readEvents(project, run.id).map(e => e.type);
    for (const expected of ['worker-died', 'reviewer-died', 'stale-spawn-recovered']) {
      assert.ok(types.includes(expected), `events must include ${expected}`);
    }
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('session spawned but task hijacked mid-flight is reported as orphan-session', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  const { deps } = makeHarness({
    openTerminal: async () => {
      // A rogue writer rewrites the task while the terminal is starting.
      const cur = proto.readTask(project, run.id, 'T-1');
      proto.writeTask(project, run.id, { ...cur, status: 'failed' });
      return { ok: true };
    },
  });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'orphan-session' && e.task === 'T-1'),
      'conflicting completion must be loudly recorded');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('file-overlap guard: overlapping ready tasks serialize, disjoint ones parallelize', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project); // worker cap 4
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'ready', kind: 'leaf', filesHint: ['src/auth.js', 'test/auth.test.js'],
  });
  // Overlaps T-1 via case/separator variant of the same path.
  proto.writeTask(project, run.id, {
    id: 'T-2', title: 'b', status: 'ready', kind: 'leaf', filesHint: ['src\\Auth.js'],
  });
  proto.writeTask(project, run.id, {
    id: 'T-3', title: 'c', status: 'ready', kind: 'leaf', filesHint: ['src/other.js'],
  });
  // Occupies files even though no session is running yet — its branch holds
  // unmerged edits until done.
  proto.writeTask(project, run.id, {
    id: 'T-0', title: 'awaiting merge', status: 'approved', kind: 'leaf', filesHint: ['src/other2.js'],
    reviews: [{ file: 'reviews/T-0-1.md', verdict: 'approved' }],
  });
  proto.writeTask(project, run.id, {
    id: 'T-4', title: 'd', status: 'ready', kind: 'leaf', filesHint: ['src/other2.js'],
  });

  const { calls, deps } = makeHarness();
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'in_progress');
    assert.equal(proto.readTask(project, run.id, 'T-2').status, 'ready', 'overlap with T-1 defers T-2');
    assert.equal(proto.readTask(project, run.id, 'T-3').status, 'in_progress', 'disjoint task runs in parallel');
    assert.equal(proto.readTask(project, run.id, 'T-4').status, 'ready', 'overlap with unmerged approved task defers T-4');
    assert.equal(calls.openTerminal.length, 2);

    // T-1 finishing its branch life (done = merged) releases its files.
    for (const [from, to] of [['in_progress', 'needs_review'], ['needs_review', 'approved'], ['approved', 'done']]) {
      proto.transitionTask(project, run.id, 'T-1', from, to);
    }
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(proto.readTask(project, run.id, 'T-2').status, 'in_progress', 'released files unblock T-2');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('a verdict without a recorded review raises protocol-warning once and nudges the master', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project, { autoSpawnWorkers: false, autoSpawnReviewers: false });
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'approved', kind: 'leaf', reviews: [],
  });
  proto.writeTask(project, run.id, {
    id: 'T-2', title: 'b', status: 'approved', kind: 'leaf',
    reviews: [{ file: 'reviews/T-2-1.md', verdict: 'approved' }],
  });
  const { calls, deps } = makeHarness();
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps, nudgeDebounceMs: 20 });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    await spawner.reconcile(project); // second pass must not duplicate
    const warnings = proto.readEvents(project, run.id).filter(e => e.type === 'protocol-warning');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].task, 'T-1');
    await new Promise(r => setTimeout(r, 100));
    const nudges = calls.sendInput.filter(c => c.sessionId === MASTER);
    assert.equal(nudges.length, 1);
    assert.match(nudges[0].text, /NO recorded review/);
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('near-miss reviewer verdicts are normalized into the canonical reviews[] schema', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project, { autoSpawnWorkers: false, autoSpawnReviewers: false });
  // Drift mode A: rogue `review` object + off-pattern file name on disk.
  fs.mkdirSync(path.join(proto.runDir(project, run.id), 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(proto.runDir(project, run.id), 'reviews', 'T-1.md'), '# verdict\napproved\n');
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'approved', kind: 'leaf',
    review: { verdict: 'approved', summary: 'looks good' },
  });
  // Drift mode B: review file exists but nothing recorded in the task at all.
  fs.writeFileSync(path.join(proto.runDir(project, run.id), 'reviews', 'T-2-1.md'), '# verdict\nchanges\n');
  proto.writeTask(project, run.id, {
    id: 'T-2', title: 'b', status: 'changes_requested', kind: 'leaf',
  });

  const { deps } = makeHarness();
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);

    const t1 = proto.readTask(project, run.id, 'T-1');
    assert.equal(t1.reviews.length, 1);
    assert.equal(t1.reviews[0].verdict, 'approved');
    assert.equal(t1.reviews[0].file, 'reviews/T-1.md');
    assert.equal(t1.reviews[0].normalized, true);
    assert.equal(t1.review, undefined, 'rogue field removed');

    const t2 = proto.readTask(project, run.id, 'T-2');
    assert.equal(t2.reviews.length, 1);
    assert.equal(t2.reviews[0].verdict, 'changes_requested');
    assert.equal(t2.reviews[0].file, 'reviews/T-2-1.md');

    const events = proto.readEvents(project, run.id);
    assert.equal(events.filter(e => e.type === 'review-normalized').length, 2);
    assert.equal(events.filter(e => e.type === 'protocol-warning').length, 0);
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('nudge waits out a busy master and delivers once it goes idle', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'reviewing', kind: 'leaf' });
  let busy = true;
  const { calls, deps } = makeHarness({ isSessionBusy: () => busy });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps, nudgeDebounceMs: 20, nudgeRetryMs: 40 });
  try {
    spawner.start();
    watcher.watchProject(project);
    await new Promise(r => setTimeout(r, 30));
    proto.transitionTask(project, run.id, 'T-1', 'reviewing', 'approved', null, 'reviewer');
    watcher.refresh(project);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(calls.sendInput.filter(c => c.sessionId === MASTER).length, 0, 'busy master not interrupted');
    busy = false;
    // Poll for delivery — retry timer cadence shifts under suite load.
    const deadline = Date.now() + 10_000;
    while (calls.sendInput.filter(c => c.sessionId === MASTER).length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 150));
    const nudges = calls.sendInput.filter(c => c.sessionId === MASTER);
    assert.equal(nudges.length, 1, 'delivered exactly once after master idles');
    assert.match(nudges[0].text, /T-1 approved/);
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('agent-written text in nudges cannot inject control characters into the master PTY', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project, { autoSpawnWorkers: false });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'blocked', kind: 'leaf', attempts: 0 });
  const { calls, deps } = makeHarness();
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps, nudgeDebounceMs: 20 });
  try {
    spawner.start();
    watcher.watchProject(project);
    await new Promise(r => setTimeout(r, 30));
    // A hostile blockedReason trying to submit an extra command to the master.
    proto.transitionTask(project, run.id, 'T-1', 'blocked', 'ready', {});
    proto.transitionTask(project, run.id, 'T-1', 'ready', 'blocked',
      { blockedReason: 'oops\r/dangerous-command --yes\rmore' });
    watcher.refresh(project);
    const deadline = Date.now() + 10_000;
    while (calls.sendInput.filter(c => c.sessionId === MASTER).length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    const nudges = calls.sendInput.filter(c => c.sessionId === MASTER);
    assert.equal(nudges.length, 1);
    const body = nudges[0].text.slice(0, -1); // trailing \r is the intentional submit
    assert.ok(!/[\x00-\x1f]/.test(body), `no control chars in nudge body: ${JSON.stringify(body)}`);
    assert.ok(nudges[0].text.endsWith('\r'));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('idle reconcile passes do not force watcher rescans', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'done', kind: 'leaf' });
  const { deps } = makeHarness();
  const watcher = new OrchWatcher();
  let refreshes = 0;
  const origRefresh = watcher.refresh.bind(watcher);
  watcher.refresh = (p) => { refreshes++; return origRefresh(p); };
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(refreshes, 0, 'nothing dispatched → no forced rescan');

    proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'ready', kind: 'leaf' });
    origRefresh(project);
    await spawner.reconcile(project);
    assert.ok(refreshes >= 1, 'dispatching work forces a rescan');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});
