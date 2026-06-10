const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');
const cost = require('../orch-cost');

function setupProjects() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cost-proj-'));
  cost.setProjectsDirForTesting(dir);
  return dir;
}

function writeTranscript(projectsDir, cwd, sessionId, turns) {
  const folder = String(cwd).replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
  const d = path.join(projectsDir, folder);
  fs.mkdirSync(d, { recursive: true });
  const lines = turns.map(t => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: t.usage },
    costUSD: t.cost,
  }));
  fs.writeFileSync(path.join(d, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

test('sessionUsage sums tokens and cost from a transcript', () => {
  const projects = setupProjects();
  writeTranscript(projects, '/proj', 'sess-1', [
    { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 }, cost: 0.01 },
    { usage: { input_tokens: 200, output_tokens: 80 }, cost: 0.02 },
  ]);
  const u = cost.sessionUsage('sess-1', ['/proj']);
  assert.equal(u.inputTokens, 300);
  assert.equal(u.outputTokens, 130);
  assert.equal(u.cacheTokens, 20);
  assert.ok(Math.abs(u.costUSD - 0.03) < 1e-9);
  assert.equal(u.hasCost, true);
  assert.equal(u.found, true);
});

test('sessionUsage reports tokens even when cost is absent', () => {
  const projects = setupProjects();
  writeTranscript(projects, '/proj', 'sess-2', [{ usage: { input_tokens: 10, output_tokens: 5 } }]);
  const u = cost.sessionUsage('sess-2', ['/proj']);
  assert.equal(u.outputTokens, 5);
  assert.equal(u.hasCost, false);
  assert.equal(u.costUSD, 0);
});

test('runUsage rolls up per task, per tier, and the run total (incl. master)', () => {
  const projects = setupProjects();
  const project = '/myproj';
  const worktree = '/myproj/.switchboard/worktrees/run--T-1';
  writeTranscript(projects, worktree, 'w-1', [{ usage: { input_tokens: 100, output_tokens: 40 }, cost: 0.05 }]);
  writeTranscript(projects, worktree, 'r-1', [{ usage: { input_tokens: 60, output_tokens: 10 }, cost: 0.02 }]);
  writeTranscript(projects, project, 'master-1', [{ usage: { input_tokens: 500, output_tokens: 200 }, cost: 0.5 }]);

  const run = { masterSessionId: 'master-1' };
  const tasks = [
    { id: 'T-1', complexity: 'high', worktree, sessionIds: ['w-1'], reviewSessionIds: ['r-1'] },
    { id: 'T-2', complexity: 'trivial', sessionIds: [] },
  ];
  const roll = cost.runUsage(project, run, tasks);

  assert.equal(roll.byTask['T-1'].outputTokens, 50); // 40 worker + 10 reviewer
  assert.ok(Math.abs(roll.byTask['T-1'].costUSD - 0.07) < 1e-9);
  assert.equal(roll.byTier.high.outputTokens, 50);
  assert.equal(roll.byTier.trivial.outputTokens, 0);
  // run total includes master (200) + task work (50)
  assert.equal(roll.run.outputTokens, 250);
  assert.ok(Math.abs(roll.run.costUSD - 0.57) < 1e-9);
});

test('runUsage falls back to scanning when worktree folder is unknown', () => {
  const projects = setupProjects();
  // transcript filed under some unrelated folder name
  writeTranscript(projects, '/somewhere/else', 'w-9', [{ usage: { input_tokens: 1, output_tokens: 7 } }]);
  const roll = cost.runUsage('/proj', {}, [{ id: 'T-1', sessionIds: ['w-9'] }]);
  assert.equal(roll.byTask['T-1'].outputTokens, 7, 'found via scan fallback');
});
