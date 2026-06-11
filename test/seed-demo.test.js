// The demo seed must always produce a valid, watcher-readable run — it's the
// first thing a new user sees, and a drift in the protocol schema should
// break this test, not their first impression.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const proto = require('../orch-protocol');
const { scanProject } = require('../orch-watcher');

const SEED = path.join(__dirname, '..', 'scripts', 'seed-agent-teams-demo.js');

test('seed script produces a valid run with tasks in every board column', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-seed-demo-'));
  const out = execFileSync(process.execPath, [SEED, project], { windowsHide: true }).toString();
  assert.match(out, /Seeded Agent Teams demo run/);

  const runIds = proto.listRunIds(project);
  assert.equal(runIds.length, 1);
  const runId = runIds[0];

  // Every task file is schema-valid (no invalid entries).
  const { tasks, invalid } = proto.readTasksDetailed(project, runId);
  assert.deepEqual(invalid, [], 'seed must not write invalid task files');
  assert.ok(tasks.length >= 8);

  // Tiers + complexity round-trip.
  const run = proto.readRun(project, runId);
  assert.ok(run.tiers.trivial && run.tiers.critical);
  assert.equal(proto.resolveProfile(run, tasks.find(t => t.id === 'T-101'), 'worker'), 'anthropic-opus'); // high tier
  assert.equal(proto.resolveProfile(run, tasks.find(t => t.id === 'T-106'), 'worker'), 'qwen-local');     // trivial tier

  // Coverage across the board: done, approved, changes_requested, reviewing,
  // in_progress, ready, draft, blocked all present.
  const statuses = new Set(tasks.map(t => t.status));
  for (const s of ['done', 'approved', 'changes_requested', 'reviewing', 'in_progress', 'ready', 'draft', 'blocked']) {
    assert.ok(statuses.has(s), `demo should include a ${s} task`);
  }

  // Auto-spawn is OFF so a running app won't launch anything.
  assert.equal(run.policy.autoSpawnWorkers, false);
  assert.equal(run.policy.autoSpawnReviewers, false);

  // plan.md, a spec, and review files exist; the watcher can scan it.
  assert.ok(fs.existsSync(path.join(proto.runDir(project, runId), 'plan.md')));
  assert.ok(fs.existsSync(path.join(proto.runDir(project, runId), 'tasks', 'T-101.spec.md')));
  const snap = scanProject(project);
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.runs[0].summary.leaves >= 6, true);

  // Events render a timeline.
  assert.ok(proto.readEvents(project, runId).length >= 8);
});
