// LIVE smoke test — exercises the Agent Teams protocol with REAL `claude`
// sessions on a cheap model. This is the trust test: it validates that the
// /sb-work and /sb-review command prompts actually steer a small model
// through the file protocol (implement → commit → needs_review → review →
// verdict) with zero human involvement.
//
// Opt-in only: set SB_LIVE_SMOKE=1 (spends real tokens on the logged-in
// claude account; model defaults to haiku, override with SB_LIVE_MODEL,
// e.g. SB_LIVE_MODEL=haiku or a DeepSeek model via your profile env).
// Side effects on the real machine: installs the sb-* agent pack into
// ~/.claude/commands (exactly what Switchboard does at startup) and leaves
// two small session transcripts in ~/.claude/projects.
//
// Run:  $env:SB_LIVE_SMOKE='1'; node --test test/live-smoke.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const proto = require('../orch-protocol');
const wt = require('../worktree-manager');
const tpl = require('../orch-templates');
const bootstrap = require('../orch-bootstrap');
const { shq } = require('../claude-cmd');
const { resolveShell, shellArgs } = require('../shell-profiles');
const { OrchWatcher } = require('../orch-watcher');
const { OrchSpawner } = require('../orch-spawner');

const ENABLED = process.env.SB_LIVE_SMOKE === '1';
const MODEL = process.env.SB_LIVE_MODEL || 'haiku';
const ARTIFACTS = path.join(__dirname, 'artifacts');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-live-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'live@test']);
  git(['config', 'user.name', 'live-smoke']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# live smoke target\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.switchboard/\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  return dir;
}

test('LIVE: a real small-model worker and reviewer drive one task through the protocol',
  { timeout: 10 * 60_000, skip: ENABLED ? false : 'set SB_LIVE_SMOKE=1 to run (spends real tokens)' },
  async () => {
    // The global agent pack is what makes /sb-work resolve inside worktrees.
    const installed = bootstrap.ensureClaudeAssets({ log: console });
    assert.equal(installed.ok, true);

    const project = makeRepo();
    tpl.ensureGuidelines(project);
    tpl.ensureOrchGitignore(project);
    tpl.installCommands(project);

    const created = proto.createRun(project, {
      title: 'live smoke',
      goal: 'trivial file creation',
      roles: {
        master: { profileId: null },
        worker: { profileId: null, maxConcurrent: 1 },
        reviewer: { profileId: null, maxConcurrent: 1 },
      },
    });
    assert.equal(created.ok, true);
    const run = { ...created.run, status: 'active', masterSessionId: null };
    proto.writeRun(project, run);

    fs.writeFileSync(path.join(created.dir, 'plan.md'),
      '# Live smoke plan\n\nOne chunk, one task: create hello.txt.\n');
    fs.writeFileSync(path.join(created.dir, 'tasks', 'T-1.spec.md'), [
      '# T-1 — create hello.txt',
      '',
      'Create a file named `hello.txt` in the root of this worktree containing exactly:',
      '',
      '```',
      'hello from agent teams',
      '```',
      '',
      '## Acceptance criteria',
      '- `hello.txt` exists at the worktree root with exactly that single line.',
      '- The change is committed on the current branch.',
      '',
      '## Validation command',
      '`cat hello.txt`',
    ].join('\n'));
    proto.writeTask(project, run.id, {
      id: 'T-1', title: 'Create hello.txt', status: 'ready', kind: 'leaf',
      spec: 'tasks/T-1.spec.md',
      acceptance: ['hello.txt exists with the exact content', 'change is committed'],
    });

    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const logFile = path.join(ARTIFACTS, 'live-smoke.log');
    fs.writeFileSync(logFile, `live smoke @ ${new Date().toISOString()} model=${MODEL}\n`);

    const shell = resolveShell('auto');
    const active = new Set();
    const procs = [];
    const spawned = []; // {sessionId, cwd} — for transcript cleanup
    const deps = {
      openTerminal: async (sessionId, cwd, _isNew, opts) => {
        const cmd = `claude -p ${shq(opts.initialPrompt)} --session-id ${shq(sessionId)}` +
          ` --permission-mode acceptEdits --model ${shq(MODEL)}` +
          ` --allowed-tools 'Bash,Read,Write,Edit,Glob,Grep'` +
          (opts.addDirs ? ` --add-dir ${shq(opts.addDirs)}` : '') +
          (opts.appendSystemPrompt ? ` --append-system-prompt ${shq(opts.appendSystemPrompt)}` : '');
        fs.appendFileSync(logFile, `\n--- spawn ${sessionId} in ${cwd}\n${cmd}\n`);
        try {
          const child = spawn(shell.path, shellArgs(shell.path, cmd, shell.args || []), {
            cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' },
          });
          procs.push(child);
          active.add(sessionId);
          spawned.push({ sessionId, cwd });
          child.stdout.on('data', d => fs.appendFileSync(logFile, d));
          child.stderr.on('data', d => fs.appendFileSync(logFile, d));
          child.on('exit', (code) => {
            active.delete(sessionId);
            fs.appendFileSync(logFile, `\n--- exit ${sessionId}: ${code}\n`);
          });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
      sendInput: () => true,
      isSessionActive: (id) => active.has(id),
      isSessionBusy: () => false,
      seedSessionJsonl: () => false, // headless --session-id needs no seed
      ensureTaskWorktree: wt.ensureTaskWorktree,
      rolePrompt: tpl.rolePrompt,
    };

    const watcher = new OrchWatcher();
    const spawner = new OrchSpawner({ watcher, deps, staleGraceMs: 5 * 60_000 });
    try {
      spawner.start();
      watcher.watchProject(project);

      const deadline = Date.now() + 9 * 60_000;
      let task;
      while (Date.now() < deadline) {
        task = proto.readTask(project, run.id, 'T-1');
        if ((task.reviews || []).length >= 1) break;
        await new Promise(r => setTimeout(r, 2000));
      }
      task = proto.readTask(project, run.id, 'T-1');
      const events = proto.readEvents(project, run.id, 500);
      fs.appendFileSync(logFile, `\n--- final task: ${JSON.stringify(task, null, 2)}\n`);

      // The worker really implemented and committed in its worktree.
      assert.ok(task.worktree, 'worker got a worktree');
      const hello = path.join(task.worktree, 'hello.txt');
      assert.ok(fs.existsSync(hello), `worker must create hello.txt (see ${logFile})`);
      assert.match(fs.readFileSync(hello, 'utf8'), /hello from agent teams/);
      const gitLog = execFileSync('git', ['log', '--oneline'], { cwd: task.worktree }).toString();
      assert.ok(gitLog.split('\n').filter(Boolean).length >= 2, 'worker must commit its change');

      // The protocol round-trip happened: worker → needs_review → reviewer verdict.
      assert.ok(events.some(e => e.type === 'worker-spawned'));
      assert.ok(events.some(e => e.type === 'reviewer-spawned'));
      assert.equal((task.reviews || []).length >= 1, true, 'reviewer must record a verdict');
      const reviewFile = path.join(proto.runDir(project, run.id), task.reviews[0].file);
      assert.ok(fs.existsSync(reviewFile), 'review markdown written');
      assert.ok(['approved', 'changes_requested'].includes(task.reviews[0].verdict),
        `verdict must be approved or changes_requested (got ${task.reviews[0].verdict})`);
    } finally {
      spawner.stop();
      watcher.dispose();
      for (const p of procs) { try { p.kill(); } catch {} }
      // Don't leave throwaway temp-dir "projects" cluttering the user's
      // Switchboard sidebar: remove the transcripts these test sessions
      // wrote under ~/.claude/projects.
      for (const { sessionId, cwd } of spawned) {
        try {
          const folder = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
          fs.rmSync(path.join(folder, sessionId + '.jsonl'), { force: true });
          if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
        } catch {}
      }
    }
  });
