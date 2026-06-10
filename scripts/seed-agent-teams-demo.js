#!/usr/bin/env node
// seed-agent-teams-demo.js — write a realistic, non-running Agent Teams demo
// run into a project's .switchboard/ so the Teams tab shows a fully populated
// board (every column, complexity tiers, reviews, a timeline) without
// spawning any sessions or spending tokens.
//
// Usage:
//   node scripts/seed-agent-teams-demo.js [projectPath]
//
// projectPath defaults to the current working directory. The demo run is
// created with auto-spawn DISABLED and status "active", so Switchboard
// renders it live but never launches a worker. Delete it any time by
// removing the printed run directory, or from the GUI (Abandon).
//
// Safe to re-run: each invocation creates a fresh run id.

const path = require('path');
const fs = require('fs');
const proto = require('../orch-protocol');
const tpl = require('../orch-templates');

function uuid() {
  // Stable-ish fake session ids for the demo (no crypto dependency on shape).
  return 'demo' + Math.random().toString(16).slice(2, 10).padEnd(8, '0')
    + '-0000-4000-8000-000000000000';
}

function main() {
  const projectPath = path.resolve(process.argv[2] || process.cwd());
  if (!fs.existsSync(projectPath)) {
    console.error(`Project path does not exist: ${projectPath}`);
    process.exit(1);
  }

  // Install the agent pack + guidelines so the demo project is complete.
  tpl.ensureGuidelines(projectPath);
  tpl.ensureOrchGitignore(projectPath);

  const created = proto.createRun(projectPath, {
    title: 'Demo: add API rate limiting',
    goal: 'Add per-IP rate limiting to the public API, with tests and docs.',
    roles: {
      master: { profileId: 'anthropic-opus' },
      worker: { profileId: 'deepseek', maxConcurrent: 6 },
      reviewer: { profileId: 'anthropic-opus', maxConcurrent: 2 },
    },
    tiers: {
      trivial: { profileId: 'qwen-local', maxConcurrent: 8 },
      low: { profileId: 'deepseek', maxConcurrent: 6 },
      medium: { profileId: 'deepseek', maxConcurrent: 4 },
      high: { profileId: 'anthropic-opus', maxConcurrent: 1 },
      critical: { profileId: 'anthropic-opus', reviewerProfileId: 'anthropic-opus', maxConcurrent: 1 },
    },
    // Demo only: don't let a running Switchboard try to spawn real sessions.
    policy: { autoSpawnWorkers: false, autoSpawnReviewers: false, autoMerge: false,
      validateCmd: 'npm test', maxBudgetUsd: 5 },
  });
  if (!created.ok) {
    console.error(`Failed to create demo run: ${created.error}`);
    process.exit(1);
  }
  const { run, dir } = created;
  const runId = run.id;
  proto.writeRun(projectPath, { ...run, status: 'active', masterSessionId: uuid() });

  fs.writeFileSync(path.join(dir, 'plan.md'), [
    `# Plan — ${run.title}`,
    '',
    '## Goal',
    'Add per-IP rate limiting to the public API. Requests over the limit get a',
    '429 with a Retry-After header. Configurable window and ceiling.',
    '',
    '## Architecture',
    '- A small token-bucket limiter module (pure, unit-testable).',
    '- Express middleware that applies it keyed by client IP.',
    '- Wire the middleware into the public router only.',
    '',
    '## Layered delivery (each chunk keeps the app working)',
    '1. **C-01 Limiter core** — the bucket + its tests. No wiring yet.',
    '2. **C-02 Middleware + integration** — depends on C-01; adds the seam and docs.',
    '',
    '## Validation gates',
    '- C-01: `npm test -- limiter`',
    '- C-02: `npm test` + a manual 429 smoke',
    '',
    '## Risk register',
    '- Clock source for the window (use a monotonic clock).',
    '- Proxy IP spoofing — trust only the configured proxy header.',
  ].join('\n'));

  // A spec for one task, so the "Spec" button has something to show.
  fs.writeFileSync(path.join(dir, 'tasks', 'T-101.spec.md'), [
    '# T-101 — token-bucket limiter core',
    '',
    'Implement `src/ratelimit/bucket.js` exporting `createBucket({ capacity, refillPerSec })`',
    'with `tryRemove(key, now)` → boolean. Pure, no I/O, monotonic `now` passed in.',
    '',
    '## Acceptance criteria',
    '- Allows up to `capacity` in a window, then denies until refill.',
    '- `test/ratelimit/bucket.test.js` covers burst, refill, and per-key isolation.',
    '',
    '## Validation',
    '`npm test -- bucket`',
  ].join('\n'));

  // A review file for the changes-requested task.
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviews', 'T-103-1.md'), [
    '# Review 1 of T-103 — middleware',
    '',
    'Verdict: **changes_requested**',
    '',
    '## Blockers',
    '- `src/ratelimit/middleware.js:24` trusts `X-Forwarded-For` unconditionally —',
    '  spoofable. Only trust it when the request came from the configured proxy.',
    '',
    '## Should-fix',
    '- No test for the 429 Retry-After header value.',
  ].join('\n'));

  // Tasks spanning every board column + a spread of complexity tiers.
  const tasks = [
    { id: 'C-01', title: 'Limiter core', kind: 'chunk', status: 'done', validateCmd: 'npm test -- limiter' },
    { id: 'C-02', title: 'Middleware + integration', kind: 'chunk', status: 'in_progress', dependsOn: ['C-01'], validateCmd: 'npm test' },

    { id: 'T-101', title: 'Token-bucket limiter core', kind: 'leaf', parent: 'C-01', status: 'done',
      complexity: 'high', spec: 'tasks/T-101.spec.md', filesHint: ['src/ratelimit/bucket.js', 'test/ratelimit/bucket.test.js'],
      attempts: 1, sessionIds: [uuid()], reviews: [{ file: 'reviews/T-101-1.md', verdict: 'approved' }],
      summary: 'Implemented the token bucket with burst + refill tests; all green.' },

    { id: 'T-102', title: 'Limiter config loader', kind: 'leaf', parent: 'C-01', status: 'approved',
      complexity: 'low', filesHint: ['src/ratelimit/config.js'], attempts: 1,
      sessionIds: [uuid()], reviews: [{ file: 'reviews/T-102-1.md', verdict: 'approved' }] },

    { id: 'T-103', title: 'Rate-limit middleware', kind: 'leaf', parent: 'C-02', status: 'changes_requested',
      complexity: 'high', filesHint: ['src/ratelimit/middleware.js'], dependsOn: ['T-101'], attempts: 1,
      sessionIds: [uuid()], reviewRound: 1,
      reviews: [
        { file: 'reviews/T-103-spec-1.md', verdict: 'approved', lens: 'spec', round: 1 },
        { file: 'reviews/T-103-functionality-1.md', verdict: 'approved', lens: 'functionality', round: 1 },
        { file: 'reviews/T-103-security-1.md', verdict: 'changes_requested', lens: 'security', round: 1 },
        { file: 'reviews/T-103-tests-1.md', verdict: 'changes_requested', lens: 'tests', round: 1 },
        { file: 'reviews/T-103-style-1.md', verdict: 'approved', lens: 'style', round: 1 },
      ] },

    { id: 'T-104', title: 'Wire middleware into public router', kind: 'leaf', parent: 'C-02', status: 'reviewing',
      complexity: 'medium', filesHint: ['src/routes/public.js'], dependsOn: ['T-103'], attempts: 1,
      sessionIds: [uuid()], reviewSessionIds: [uuid(), uuid(), uuid()],
      reviewRound: 1, pendingLenses: ['spec', 'functionality', 'tests', 'style'] },

    { id: 'T-105', title: '429 integration test', kind: 'leaf', parent: 'C-02', status: 'in_progress',
      complexity: 'medium', filesHint: ['test/ratelimit/e2e.test.js'], attempts: 1, sessionIds: [uuid()] },

    { id: 'T-106', title: 'Document rate limits in API.md', kind: 'leaf', parent: 'C-02', status: 'ready',
      complexity: 'trivial', filesHint: ['docs/API.md'] },

    { id: 'T-107', title: 'Add metrics counter for 429s', kind: 'leaf', parent: 'C-02', status: 'draft',
      complexity: 'low', filesHint: ['src/metrics.js'] },

    { id: 'T-108', title: 'Distributed limiter via Redis', kind: 'leaf', parent: 'C-02', status: 'blocked',
      complexity: 'critical', filesHint: ['src/ratelimit/redis.js'], attempts: 3,
      blockedReason: 'no Redis in the dev environment — needs infra decision' },
  ];
  for (const t of tasks) {
    const r = proto.writeTask(projectPath, runId, { status: 'draft', ...t });
    if (!r.ok) { console.error(`task ${t.id}: ${r.error}`); process.exit(1); }
  }
  // Make the approved review file referenced above exist.
  fs.writeFileSync(path.join(dir, 'reviews', 'T-101-1.md'), '# Review 1 of T-101\n\nVerdict: **approved**\n\nClean implementation, tests cover burst + refill.\n');
  fs.writeFileSync(path.join(dir, 'reviews', 'T-102-1.md'), '# Review 1 of T-102\n\nVerdict: **approved**\n');

  // A plausible event history for the timeline.
  const ev = (e) => proto.appendEvent(projectPath, runId, e);
  ev({ type: 'run-created', title: run.title, actor: 'switchboard' });
  ev({ type: 'master-spawned', sessionId: 'demo-master' });
  ev({ type: 'worker-spawned', task: 'T-101', sessionId: 'demo' });
  ev({ type: 'reviewer-spawned', task: 'T-101', sessionId: 'demo' });
  ev({ type: 'task-transition', task: 'T-101', from: 'reviewing', to: 'approved', actor: 'reviewer' });
  ev({ type: 'task-transition', task: 'T-101', from: 'merging', to: 'done', actor: 'master' });
  ev({ type: 'worktree-cleaned', task: 'T-101' });
  ev({ type: 'worker-spawned', task: 'T-103', sessionId: 'demo' });
  ev({ type: 'task-transition', task: 'T-103', from: 'reviewing', to: 'changes_requested', actor: 'reviewer' });
  ev({ type: 'master-nudged', lines: ['task T-101 approved by review', 'task T-108 is blocked (no Redis)'] });

  console.log('Seeded Agent Teams demo run:');
  console.log(`  project: ${projectPath}`);
  console.log(`  run:     ${runId}`);
  console.log(`  dir:     ${dir}`);
  console.log('');
  console.log('Open Switchboard → Agent Teams tab to view it. Auto-spawn is OFF,');
  console.log('so nothing will launch. Remove it via the GUI (Abandon) or delete the dir.');
}

main();
