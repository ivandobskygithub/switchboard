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
  master: { profileId: 'opus' }, worker: { profileId: 'deepseek', maxConcurrent: 4 }, reviewer: { profileId: 'opus' },
};
function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-budget-')); }

function activeRun(project, policy) {
  const { run } = proto.createRun(project, { title: 'b', roles: ROLES, policy: { isolation: 'none', ...policy } });
  proto.writeRun(project, { ...run, status: 'active', masterSessionId: MASTER });
  return proto.readRun(project, run.id);
}

function harness(spend) {
  const calls = { openTerminal: [], sendInput: [] };
  const active = new Set([MASTER]);
  const deps = {
    openTerminal: async (id) => { calls.openTerminal.push(id); active.add(id); return { ok: true }; },
    sendInput: (id, t) => { calls.sendInput.push({ id, t }); return true; },
    isSessionActive: (id) => active.has(id),
    isSessionBusy: () => false,
    seedSessionJsonl: () => true,
    ensureTaskWorktree: async () => ({ ok: false }),
    rolePrompt: () => 'p',
    computeSpend: () => spend,
    newSessionId: (() => { let n = 0; return () => `s-${++n}`; })(),
  };
  return { calls, deps };
}

test('output-token cap pauses the run and nudges the master before spawning', async () => {
  const project = tmpProject();
  const run = activeRun(project, { maxOutputTokens: 1000 });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  const { calls, deps } = harness({ outputTokens: 1500, costUSD: 0, hasCost: false });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps, nudgeDebounceMs: 10 });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0, 'no worker spawned over budget');
    assert.equal(proto.readRun(project, run.id).status, 'paused');
    assert.ok(proto.readEvents(project, run.id).some(e => e.type === 'budget-paused'));
    await new Promise(r => setTimeout(r, 60));
    assert.ok(calls.sendInput.some(c => c.id === MASTER && /auto-paused/.test(c.t)));
  } finally { spawner.stop(); watcher.dispose(); }
});

test('usd cap only fires when real cost is present', async () => {
  const project = tmpProject();
  const run = activeRun(project, { maxBudgetUsd: 1 });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });

  // cost present and over → pause
  let h = harness({ outputTokens: 10, costUSD: 2, hasCost: true });
  let watcher = new OrchWatcher();
  let spawner = new OrchSpawner({ watcher, deps: h.deps });
  watcher.watchProject(project);
  await spawner.reconcile(project);
  assert.equal(proto.readRun(project, run.id).status, 'paused');
  spawner.stop(); watcher.dispose();

  // resume; cost figures absent → usd cap cannot fire, run proceeds
  proto.writeRun(project, { ...proto.readRun(project, run.id), status: 'active' });
  h = harness({ outputTokens: 999999, costUSD: 0, hasCost: false });
  watcher = new OrchWatcher();
  spawner = new OrchSpawner({ watcher, deps: h.deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(proto.readRun(project, run.id).status, 'active', 'usd cap inert without cost data');
    assert.equal(h.calls.openTerminal.length, 1);
  } finally { spawner.stop(); watcher.dispose(); }
});

test('no caps configured → budget check is inert', async () => {
  const project = tmpProject();
  const run = activeRun(project, {});
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  const { calls, deps } = harness({ outputTokens: 1e9, costUSD: 1e9, hasCost: true });
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(proto.readRun(project, run.id).status, 'active');
    assert.equal(calls.openTerminal.length, 1);
  } finally { spawner.stop(); watcher.dispose(); }
});

test('validateRun rejects non-positive budget caps', () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, { title: 'b', roles: ROLES });
  assert.equal(proto.validateRun({ ...run, policy: { maxBudgetUsd: -1 } }), 'invalid policy.maxBudgetUsd');
  assert.equal(proto.validateRun({ ...run, policy: { maxOutputTokens: 0 } }), 'invalid policy.maxOutputTokens');
  assert.equal(proto.validateRun({ ...run, policy: { maxBudgetUsd: 5, maxOutputTokens: 1000 } }), null);
});
