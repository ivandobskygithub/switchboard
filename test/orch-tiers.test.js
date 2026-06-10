const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');
const { OrchWatcher } = require('../orch-watcher');
const { OrchSpawner } = require('../orch-spawner');

function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tier-')); }

const ROLES = {
  master: { profileId: 'opus' },
  worker: { profileId: 'deepseek', maxConcurrent: 8 },
  reviewer: { profileId: 'opus', maxConcurrent: 4 },
};
const TIERS = {
  trivial:  { profileId: 'qwen-local', maxConcurrent: 2 },
  high:     { profileId: 'opus', reviewerProfileId: 'opus', maxConcurrent: 1 },
};

test('createRun stores cleaned tiers and validates them', () => {
  const project = tmpProject();
  const r = proto.createRun(project, {
    title: 'tiered', roles: ROLES,
    tiers: {
      trivial: { profileId: 'qwen-local', maxConcurrent: 5 },
      high: { profileId: 'opus' },
      bogus: { profileId: 'x' },          // unknown tier name dropped
      low: { profileId: 'has space!' },    // invalid id dropped
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.run.tiers).sort(), ['high', 'trivial']);
  assert.equal(r.run.tiers.trivial.maxConcurrent, 5);
  assert.equal(r.run.tiers.low, undefined);
  assert.equal(proto.validateRun(r.run), null);
});

test('resolveProfile precedence: task override → tier → role default', () => {
  const run = { ...proto.createRun(tmpProject(), { title: 'r', roles: ROLES, tiers: TIERS }).run };
  // role default (no complexity / medium tier not defined)
  assert.equal(proto.resolveProfile(run, { id: 'A', complexity: 'medium' }, 'worker'), 'deepseek');
  // tier for the task's complexity
  assert.equal(proto.resolveProfile(run, { id: 'B', complexity: 'trivial' }, 'worker'), 'qwen-local');
  assert.equal(proto.resolveProfile(run, { id: 'C', complexity: 'high' }, 'worker'), 'opus');
  // explicit per-task override beats the tier
  assert.equal(proto.resolveProfile(run, { id: 'D', complexity: 'trivial', profileId: 'special' }, 'worker'), 'special');
  // reviewer resolution: tier reviewerProfileId, else role default
  assert.equal(proto.resolveProfile(run, { id: 'E', complexity: 'high' }, 'reviewer'), 'opus');
  assert.equal(proto.resolveProfile(run, { id: 'F', complexity: 'trivial' }, 'reviewer'), 'opus'); // role default
  assert.equal(proto.resolveProfile(run, { id: 'G', complexity: 'low', reviewerProfileId: 'rev-x' }, 'reviewer'), 'rev-x');
});

test('tierCap returns the per-tier cap or null', () => {
  const run = proto.createRun(tmpProject(), { title: 'r', roles: ROLES, tiers: TIERS }).run;
  assert.equal(proto.tierCap(run, 'trivial'), 2);
  assert.equal(proto.tierCap(run, 'high'), 1);
  assert.equal(proto.tierCap(run, 'medium'), null); // no tier → uncapped (only global cap applies)
});

test('validateTask accepts complexity + profile overrides, rejects bad ones', () => {
  assert.equal(proto.validateTask({ id: 'T', title: 't', status: 'ready', complexity: 'high' }), null);
  assert.equal(proto.validateTask({ id: 'T', title: 't', status: 'ready', profileId: 'qwen-local' }), null);
  assert.match(proto.validateTask({ id: 'T', title: 't', status: 'ready', complexity: 'epic' }), /invalid complexity/);
  assert.match(proto.validateTask({ id: 'T', title: 't', status: 'ready', profileId: 'bad id!' }), /invalid profileId/);
});

test('spawner routes each task to its tier model and enforces per-tier caps', async () => {
  const project = tmpProject();
  const base = proto.createRun(project, { title: 'r', roles: ROLES, tiers: TIERS, policy: { isolation: 'none' } }).run;
  proto.writeRun(project, { ...base, status: 'active', masterSessionId: 'm-1' });
  const runId = base.id;
  // 3 trivial (tier cap 2), 1 high (tier cap 1), 1 medium (role default).
  proto.writeTask(project, runId, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf', complexity: 'trivial' });
  proto.writeTask(project, runId, { id: 'T-2', title: 'b', status: 'ready', kind: 'leaf', complexity: 'trivial' });
  proto.writeTask(project, runId, { id: 'T-3', title: 'c', status: 'ready', kind: 'leaf', complexity: 'trivial' });
  proto.writeTask(project, runId, { id: 'T-4', title: 'd', status: 'ready', kind: 'leaf', complexity: 'high' });
  proto.writeTask(project, runId, { id: 'T-5', title: 'e', status: 'ready', kind: 'leaf', complexity: 'medium' });

  const calls = [];
  const deps = {
    openTerminal: async (sessionId, cwd, isNew, opts) => { calls.push(opts); return { ok: true }; },
    sendInput: () => true,
    isSessionActive: () => false,
    isSessionBusy: () => false,
    seedSessionJsonl: () => true,
    ensureTaskWorktree: async () => ({ ok: false }),
    rolePrompt: () => 'p',
    newSessionId: (() => { let n = 0; return () => `s-${++n}`; })(),
  };
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    const byProfile = calls.reduce((m, o) => { m[o.profileId] = (m[o.profileId] || 0) + 1; return m; }, {});
    // trivial tier capped at 2 (not 3); high capped at 1; medium uses role default.
    assert.equal(byProfile['qwen-local'], 2, 'trivial tier capped at 2');
    assert.equal(byProfile['opus'], 1, 'high tier capped at 1');
    assert.equal(byProfile['deepseek'], 1, 'medium task uses worker default');
    assert.equal(proto.readTask(project, runId, 'T-3').status, 'ready', 'third trivial deferred by tier cap');

    // Free a trivial slot → the deferred one dispatches.
    proto.transitionTask(project, runId, 'T-1', 'in_progress', 'needs_review');
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(proto.readTask(project, runId, 'T-3').status, 'in_progress');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});
