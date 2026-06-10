const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');
const { OrchWatcher } = require('../orch-watcher');
const { OrchSpawner } = require('../orch-spawner');

const MASTER = 'm-1111-2222-3333-444444444444';
const ROLES = { master: { profileId: 'opus' }, worker: { profileId: 'deepseek' }, reviewer: { profileId: 'opus' } };
function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gate-')); }

function activeRun(project, policy) {
  const { run } = proto.createRun(project, { title: 'g', roles: ROLES, policy: { isolation: 'none', ...policy } });
  proto.writeRun(project, { ...run, status: 'active', masterSessionId: MASTER });
  return proto.readRun(project, run.id);
}

function harness(runValidation) {
  const active = new Set([MASTER]);
  const calls = { validations: [], sendInput: [] };
  const deps = {
    openTerminal: async () => ({ ok: true }),
    sendInput: (id, t) => { calls.sendInput.push({ id, t }); return true; },
    isSessionActive: (id) => active.has(id),
    isSessionBusy: () => false,
    seedSessionJsonl: () => true,
    ensureTaskWorktree: async () => ({ ok: false }),
    rolePrompt: () => 'p',
    runValidation: async (cmd, cwd) => { calls.validations.push({ cmd, cwd }); return runValidation(cmd, cwd); },
    newSessionId: (() => { let n = 0; return () => `s-${++n}`; })(),
  };
  return { calls, deps };
}

test('phase gate runs when leaves are done and marks the chunk done on pass', async () => {
  const project = tmpProject();
  const run = activeRun(project, { autoSpawnWorkers: false, autoSpawnReviewers: false });
  proto.writeTask(project, run.id, { id: 'C-1', title: 'chunk', kind: 'chunk', status: 'in_progress', validateCmd: 'npm test -- a' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', kind: 'leaf', parent: 'C-1', status: 'done' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', kind: 'leaf', parent: 'C-1', status: 'done' });

  const { calls, deps } = harness(async () => ({ ok: true, code: 0, stdout: 'ok' }));
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.validations.length, 1);
    assert.equal(calls.validations[0].cmd, 'npm test -- a');
    assert.equal(calls.validations[0].cwd, project); // isolation none
    assert.equal(proto.readTask(project, run.id, 'C-1').status, 'done');
    const events = proto.readEvents(project, run.id).map(e => e.type);
    assert.ok(events.includes('gate-running') && events.includes('gate-passed'));
  } finally { spawner.stop(); watcher.dispose(); }
});

test('failing gate blocks the chunk and nudges the master', async () => {
  const project = tmpProject();
  const run = activeRun(project, { autoSpawnWorkers: false });
  proto.writeTask(project, run.id, { id: 'C-1', title: 'chunk', kind: 'chunk', status: 'in_progress', validateCmd: 'npm test' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', kind: 'leaf', parent: 'C-1', status: 'done' });

  const { calls, deps } = harness(async () => ({ ok: false, code: 1, stderr: '2 tests failed' }));
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps, nudgeDebounceMs: 10 });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    const chunk = proto.readTask(project, run.id, 'C-1');
    assert.equal(chunk.status, 'blocked');
    assert.match(chunk.blockedReason, /phase gate failed/);
    assert.match(chunk.gate.detail, /2 tests failed/);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(calls.sendInput.some(c => c.id === MASTER && /gate failed/.test(c.t)));
  } finally { spawner.stop(); watcher.dispose(); }
});

test('no validateCmd → chunk completes on leaves-done without running a gate', async () => {
  const project = tmpProject();
  const run = activeRun(project, { autoSpawnWorkers: false });
  proto.writeTask(project, run.id, { id: 'C-1', title: 'chunk', kind: 'chunk', status: 'in_progress' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', kind: 'leaf', parent: 'C-1', status: 'done' });

  const { calls, deps } = harness(async () => ({ ok: false, code: 1 }));
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.validations.length, 0);
    assert.equal(proto.readTask(project, run.id, 'C-1').status, 'done');
    assert.ok(proto.readEvents(project, run.id).some(e => e.type === 'phase-done'));
  } finally { spawner.stop(); watcher.dispose(); }
});

test('gate does not run until ALL leaves are done', async () => {
  const project = tmpProject();
  const run = activeRun(project, { autoSpawnWorkers: false });
  proto.writeTask(project, run.id, { id: 'C-1', title: 'chunk', kind: 'chunk', status: 'in_progress', validateCmd: 'x' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', kind: 'leaf', parent: 'C-1', status: 'done' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', kind: 'leaf', parent: 'C-1', status: 'in_progress' });

  const { calls, deps } = harness(async () => ({ ok: true, code: 0 }));
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.validations.length, 0);
    assert.equal(proto.readTask(project, run.id, 'C-1').status, 'in_progress');
  } finally { spawner.stop(); watcher.dispose(); }
});

test('policy.validateCmd is the default gate when a chunk has none; gatesEnabled:false skips', async () => {
  const project = tmpProject();
  const run = activeRun(project, { autoSpawnWorkers: false, validateCmd: 'make check', gatesEnabled: false });
  proto.writeTask(project, run.id, { id: 'C-1', title: 'chunk', kind: 'chunk', status: 'in_progress' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', kind: 'leaf', parent: 'C-1', status: 'done' });

  const { calls, deps } = harness(async () => ({ ok: false, code: 1 }));
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    // gates disabled → no validation runs, chunk completes
    assert.equal(calls.validations.length, 0);
    assert.equal(proto.readTask(project, run.id, 'C-1').status, 'done');
  } finally { spawner.stop(); watcher.dispose(); }
});
