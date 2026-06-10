// orch-spawner.js — turns task state into running sessions.
//
// The spawner is the only "active" part of Switchboard's orchestration: it
// watches the file protocol (via OrchWatcher) and, for runs with status
// "active", it
//   - dispatches `ready` leaf tasks to worker sessions (one worktree each),
//   - dispatches `needs_review` tasks to reviewer sessions,
//   - re-dispatches `changes_requested` tasks back to their worker,
//   - recovers tasks whose sessions died without finishing (stale sweep),
//   - nudges the master session's terminal when there is a decision to make
//     (approved tasks to merge, blocked/failed tasks, run completion).
//
// It makes no decisions about WHAT to build — that's the master agent's job.
// All effects go through injected deps so the whole thing is testable
// without Electron or node-pty:
//
//   openTerminal(sessionId, cwd, isNew, sessionOptions) → Promise<{ok,error?}>
//   sendInput(sessionId, text) → boolean
//   isSessionActive(sessionId) → boolean
//   isSessionBusy(sessionId) → boolean
//   seedSessionJsonl({sessionId, cwd, slug, text}) → boolean
//   ensureTaskWorktree(projectPath, runId, taskId, integrationBranch) → Promise<{ok,path,branch}>
//   rolePrompt(role, run, projectPath, task) → string|null
//   newSessionId() → uuid (defaults to crypto.randomUUID)
//
// Reconciliation is level-triggered and idempotent: every pass re-derives
// what should be running from the current snapshot, so missed events or
// crashes self-heal on the next pass / periodic tick. Status transitions are
// optimistic (orch-protocol re-validates against disk at write time), so two
// concurrent passes can never double-dispatch the same task — the loser of
// the race gets a conflict and skips.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proto = require('./orch-protocol');

const RECONCILE_TICK_MS = 15_000;
const NUDGE_DEBOUNCE_MS = 2_000;
const NUDGE_RETRY_MS = 10_000;
const NUDGE_MAX_QUEUE = 40;
// How long a task may sit in an "active" status with no live session before
// the sweep recovers it. Generous: a session needs time to appear between
// the status write and the PTY registering.
const STALE_GRACE_MS = 90_000;

class OrchSpawner {
  constructor({ watcher, log, deps, staleGraceMs, nudgeRetryMs, nudgeDebounceMs }) {
    this.watcher = watcher;
    this.log = log || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    this.deps = { newSessionId: () => crypto.randomUUID(), ...deps };
    this.staleGraceMs = staleGraceMs ?? STALE_GRACE_MS;
    this.nudgeRetryMs = nudgeRetryMs ?? NUDGE_RETRY_MS;
    this.nudgeDebounceMs = nudgeDebounceMs ?? NUDGE_DEBOUNCE_MS;
    this._reconciling = new Set();   // projectPath currently reconciling
    this._dirty = new Set();         // projectPath needing another pass
    this._nudgeQueues = new Map();   // `${projectPath} ${runId}` → { lines, timer, ... }
    this._staleSince = new Map();    // `${projectPath}|${runId}|${taskId}|${status}` → first-seen ms
    this._protocolWarned = new Set(); // dedupe keys for protocol-warning events
    this._tick = null;
    this._stopped = false;

    this._onState = (projectPath) => { this.reconcile(projectPath); };
    this._onTaskChanged = (projectPath, runId, task, prev) => {
      this._maybeQueueNudge(projectPath, runId, task, prev);
    };
  }

  start() {
    this.watcher.on('state', this._onState);
    this.watcher.on('task-changed', this._onTaskChanged);
    this._tick = setInterval(() => {
      for (const p of this.watcher.watchedProjects()) this.reconcile(p);
    }, RECONCILE_TICK_MS);
    if (this._tick.unref) this._tick.unref();
  }

  stop() {
    this._stopped = true;
    this.watcher.removeListener('state', this._onState);
    this.watcher.removeListener('task-changed', this._onTaskChanged);
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    for (const q of this._nudgeQueues.values()) {
      if (q.timer) clearTimeout(q.timer);
    }
    this._nudgeQueues.clear();
    this._staleSince.clear();
  }

  // --- reconciliation -----------------------------------------------------

  async reconcile(projectPath) {
    if (this._stopped) return;
    if (this._reconciling.has(projectPath)) { this._dirty.add(projectPath); return; }
    this._reconciling.add(projectPath);
    let acted = false;
    try {
      const snapshot = this.watcher.getSnapshot(projectPath);
      if (snapshot) {
        for (const entry of snapshot.runs) {
          try {
            if (await this._reconcileRun(projectPath, entry)) acted = true;
          } catch (err) {
            this.log.error(`[orch] reconcile run ${entry.run.id} failed: ${err.message}`);
          }
        }
      }
    } finally {
      // Only force a rescan when this pass changed something — an idle tick
      // must not turn into a full disk scan every 15s per project.
      if (acted) this.watcher.refresh(projectPath);
      this._reconciling.delete(projectPath);
      if (this._dirty.delete(projectPath)) setImmediate(() => this.reconcile(projectPath));
    }
  }

  async _reconcileRun(projectPath, { run, tasks }) {
    if (run.status !== 'active') return false;
    const policy = { ...proto.DEFAULT_POLICY, ...(run.policy || {}) };
    const byId = new Map(tasks.map(t => [t.id, t]));
    const leaf = (t) => (t.kind || 'leaf') === 'leaf';
    let acted = false;

    acted = this._sweepStaleTasks(projectPath, run, tasks) || acted;
    acted = this._auditProtocol(projectPath, run, tasks) || acted;

    let activeWorkers = tasks.filter(t => proto.ACTIVE_WORKER_STATUSES.has(t.status)).length;
    let activeReviewers = tasks.filter(t => proto.ACTIVE_REVIEWER_STATUSES.has(t.status)).length;
    const workerCap = run.roles.worker?.maxConcurrent ?? 4;
    const reviewerCap = run.roles.reviewer?.maxConcurrent ?? 2;

    // Concurrency is bounded by the role cap AND by file overlap: two tasks
    // whose filesHint intersect must never run at the same time, however
    // high the cap is. Every not-yet-merged task that has started work
    // occupies its files (its branch holds unmerged edits until `done`).
    const occupiedFiles = new Set();
    for (const t of tasks) {
      if (['spawning', 'in_progress', 'needs_review', 'reviewing', 'changes_requested', 'approved', 'merging'].includes(t.status)) {
        for (const f of t.filesHint || []) occupiedFiles.add(proto.normalizeFileHint(f));
      }
    }
    const overlapsOccupied = (t) => (t.filesHint || []).some(f => occupiedFiles.has(proto.normalizeFileHint(f)));
    const occupy = (t) => { for (const f of t.filesHint || []) occupiedFiles.add(proto.normalizeFileHint(f)); };

    if (policy.autoSpawnWorkers) {
      // Rework first — those tasks are closest to completion (their files
      // are already counted as occupied by themselves).
      for (const t of tasks.filter(x => x.status === 'changes_requested' && leaf(x))) {
        if (activeWorkers >= workerCap) break;
        if (await this._dispatchRework(projectPath, run, policy, t)) { activeWorkers++; acted = true; }
      }
      const ready = tasks
        .filter(x => x.status === 'ready' && leaf(x))
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const t of ready) {
        if (!proto.depsSatisfied(t, byId)) continue;
        if (overlapsOccupied(t)) {
          this.log.debug(`[orch] ${run.id}/${t.id} deferred: files overlap an active task`);
          continue;
        }
        if ((t.attempts || 0) >= policy.maxAttempts) {
          const r = proto.transitionTask(projectPath, run.id, t.id, 'ready', 'blocked',
            { blockedReason: `max attempts (${policy.maxAttempts}) exhausted` });
          if (r.ok) {
            acted = true;
            this.log.warn(`[orch] ${run.id}/${t.id} blocked: attempts exhausted`);
          }
          continue;
        }
        if (activeWorkers >= workerCap) break;
        if (await this._dispatchWorker(projectPath, run, policy, t)) {
          activeWorkers++;
          acted = true;
          occupy(t);
        }
      }
    }

    if (policy.autoSpawnReviewers) {
      for (const t of tasks.filter(x => x.status === 'needs_review' && leaf(x))) {
        if (activeReviewers >= reviewerCap) break;
        if (await this._dispatchReviewer(projectPath, run, policy, t)) { activeReviewers++; acted = true; }
      }
    }

    return acted;
  }

  // --- stale-session sweep -------------------------------------------------
  //
  // A worker/reviewer can die without performing its closing transition
  // (claude crash, PTY killed, machine slept through it). Status alone would
  // then claim the task is active forever and its concurrency slot is lost.
  // The sweep notices "active status but no live session", waits a grace
  // period (the condition must persist across passes), then recovers the
  // task to a re-dispatchable state.

  _sweepStaleTasks(projectPath, run, tasks) {
    const RECOVERY = {
      spawning: { to: 'ready', patch: { pendingSessionId: null }, event: 'stale-spawn-recovered' },
      in_progress: { to: 'failed', patch: { failReason: 'worker session ended without completing the task' }, event: 'worker-died' },
      reviewing: { to: 'needs_review', patch: {}, event: 'reviewer-died' },
    };
    let acted = false;
    const liveKeys = new Set();
    for (const task of tasks) {
      const rec = RECOVERY[task.status];
      if (!rec) continue;
      const sid = task.status === 'reviewing'
        ? (task.reviewSessionIds || []).slice(-1)[0]
        : (task.pendingSessionId || (task.sessionIds || []).slice(-1)[0]);
      const key = `${projectPath}|${run.id}|${task.id}|${task.status}`;
      if (sid && this.deps.isSessionActive(sid)) {
        this._staleSince.delete(key);
        continue;
      }
      liveKeys.add(key);
      const first = this._staleSince.get(key);
      if (!first) {
        this._staleSince.set(key, Date.now());
        continue;
      }
      if (Date.now() - first < this.staleGraceMs) continue;
      this._staleSince.delete(key);
      const r = proto.transitionTask(projectPath, run.id, task.id, task.status, rec.to, rec.patch);
      if (r.ok) {
        acted = true;
        proto.appendEvent(projectPath, run.id, { type: rec.event, task: task.id, sessionId: sid || null });
        this.log.warn(`[orch] ${run.id}/${task.id}: no live session in status ${task.status} → ${rec.to}`);
      }
    }
    // Drop bookkeeping for tasks that moved on (status changed / task done).
    for (const key of this._staleSince.keys()) {
      if (key.startsWith(`${projectPath}|${run.id}|`) && !liveKeys.has(key)) {
        this._staleSince.delete(key);
      }
    }
    return acted;
  }

  // --- protocol audit & normalization ---------------------------------------
  //
  // Agents of varying quality write these files; the conventions the
  // prompts demand are also enforced mechanically. Live testing with haiku
  // produced both observed drift modes: a verdict with no review recorded
  // at all, and a verdict recorded in an invented shape (`review` object
  // instead of the `reviews` array, off-pattern file name). Near-misses
  // with real evidence are NORMALIZED into the canonical schema —
  // Switchboard owns the schema, agents only approximate it. Evidence-free
  // verdicts become events + master nudges instead of silent drift.

  _auditProtocol(projectPath, run, tasks) {
    let acted = false;
    for (const task of tasks) {
      if (!['approved', 'changes_requested'].includes(task.status)) continue;
      if ((task.reviews || []).length > 0) continue;

      // Evidence hunt: a rogue `review` object on the task, or a review
      // markdown for this task on disk (any name variant).
      const rogue = (task.review && typeof task.review === 'object' && !Array.isArray(task.review))
        ? task.review : null;
      let reviewFiles = [];
      try {
        reviewFiles = fs.readdirSync(path.join(proto.runDir(projectPath, run.id), 'reviews'))
          .filter(f => f.endsWith('.md') && (f === `${task.id}.md` || f.startsWith(`${task.id}-`)))
          .sort();
      } catch {}

      if (rogue || reviewFiles.length) {
        const verdict = (rogue && ['approved', 'changes_requested'].includes(rogue.verdict))
          ? rogue.verdict : task.status;
        const fresh = proto.readTask(projectPath, run.id, task.id);
        if (!fresh || fresh.status !== task.status || (fresh.reviews || []).length > 0) continue;
        const next = {
          ...fresh,
          reviews: [{
            file: reviewFiles.length ? `reviews/${reviewFiles[reviewFiles.length - 1]}` : null,
            verdict,
            normalized: true,
          }],
        };
        delete next.review;
        if (proto.writeTask(projectPath, run.id, next).ok) {
          acted = true;
          proto.appendEvent(projectPath, run.id, {
            type: 'review-normalized', task: task.id, verdict,
            file: next.reviews[0].file,
            error: 'reviewer wrote a non-canonical verdict shape; coerced into reviews[]',
          });
          this.log.info(`[orch] normalized review verdict for ${run.id}/${task.id} (${verdict})`);
        }
        continue;
      }

      const key = `${projectPath}|${run.id}|${task.id}|${task.status}|no-review`;
      if (this._protocolWarned.has(key)) continue;
      this._protocolWarned.add(key);
      proto.appendEvent(projectPath, run.id, {
        type: 'protocol-warning', task: task.id,
        error: `status ${task.status} recorded without a review entry — verdict is unaudited`,
      });
      this._queueNudgeLine(projectPath, run.id,
        `task ${task.id} is ${task.status} but has NO recorded review — verify before merging`);
      this.log.warn(`[orch] protocol warning: ${run.id}/${task.id} ${task.status} without review entry`);
    }
    return acted;
  }

  // --- dispatch helpers -----------------------------------------------------

  _roleCfg(run, role) { return run.roles[role] || {}; }

  // One resolver for the session options of every dispatch path, so policy
  // decisions (permission mode, protocol access, MCP) can't drift apart.
  _sessionOptions(projectPath, run, task, role, cwd, initialPrompt) {
    const roleCfg = this._roleCfg(run, role);
    return {
      profileId: roleCfg.profileId || undefined,
      permissionMode: roleCfg.permissionMode || 'acceptEdits',
      initialPrompt,
      appendSystemPrompt: this.deps.rolePrompt(role, run, projectPath, task) || undefined,
      mcpEmulation: false,
      // Worktree sessions need access to the protocol files, which live
      // outside the worktree subtree (.switchboard/runs, guidelines.md).
      addDirs: cwd === projectPath ? undefined : proto.orchDir(projectPath),
      orchestration: { runId: run.id, taskId: task.id, role },
    };
  }

  async _prepareCwd(projectPath, run, policy, task) {
    if (policy.isolation === 'none') {
      return { ok: true, cwd: projectPath, worktree: null, branch: null };
    }
    const w = await this.deps.ensureTaskWorktree(projectPath, run.id, task.id, run.integrationBranch);
    if (!w.ok) return { ok: false, error: w.error };
    return { ok: true, cwd: w.path, worktree: w.path, branch: w.branch };
  }

  async _spawnSession(projectPath, run, task, role, cwd, initialPrompt, sessionId) {
    const seeded = this.deps.seedSessionJsonl({
      sessionId,
      cwd,
      slug: run.id,
      text: `**Agent Teams ${role}** — run \`${run.id}\`, task \`${task.id}\`: ${task.title}`,
    });
    const res = await this.deps.openTerminal(sessionId, cwd, !seeded,
      this._sessionOptions(projectPath, run, task, role, cwd, initialPrompt));
    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || 'openTerminal failed' };
    }
    return { ok: true, sessionId };
  }

  // A completing transition can conflict if some other writer moved the task
  // while the session was being spawned. The session is then running without
  // a task that records it — make that loudly visible instead of silent.
  _completeDispatch(projectPath, run, task, from, patch, eventType, sessionId) {
    const done = proto.transitionTask(projectPath, run.id, task.id, from, 'in_progress', patch);
    if (done.ok) {
      proto.appendEvent(projectPath, run.id, { type: eventType, task: task.id, sessionId });
      return true;
    }
    proto.appendEvent(projectPath, run.id, {
      type: 'orphan-session', task: task.id, sessionId,
      error: `session spawned but task left ${from}: ${done.error}`,
    });
    this.log.warn(`[orch] orphan session ${sessionId} for ${run.id}/${task.id}: ${done.error}`);
    return true; // a session IS running — it still occupies a concurrency slot
  }

  async _dispatchWorker(projectPath, run, policy, task) {
    const sessionId = this.deps.newSessionId();
    const tr = proto.transitionTask(projectPath, run.id, task.id, 'ready', 'spawning',
      { attempts: (task.attempts || 0) + 1, role: task.role || 'worker', pendingSessionId: sessionId });
    if (!tr.ok) return false;

    const prep = await this._prepareCwd(projectPath, run, policy, task);
    if (!prep.ok) return this._spawnFailed(projectPath, run, task, `worktree: ${prep.error}`);

    const spawn = await this._spawnSession(projectPath, run, task, task.role || 'worker',
      prep.cwd, `/sb-work ${run.id} ${task.id}`, sessionId);
    if (!spawn.ok) return this._spawnFailed(projectPath, run, task, spawn.error);

    this._completeDispatch(projectPath, run, task, 'spawning', {
      sessionIds: [...(task.sessionIds || []), sessionId],
      pendingSessionId: null,
      worktree: prep.worktree,
      branch: prep.branch,
    }, 'worker-spawned', sessionId);
    this.log.info(`[orch] worker spawned for ${run.id}/${task.id} (${sessionId})`);
    return true;
  }

  async _dispatchRework(projectPath, run, policy, task) {
    const role = task.role || 'worker';
    const freshSessionId = this.deps.newSessionId();
    const tr = proto.transitionTask(projectPath, run.id, task.id, 'changes_requested', 'spawning',
      { attempts: (task.attempts || 0) + 1, pendingSessionId: freshSessionId });
    if (!tr.ok) return false;

    const prep = await this._prepareCwd(projectPath, run, policy, task);
    if (!prep.ok) return this._spawnFailed(projectPath, run, task, `worktree: ${prep.error}`);

    const lastReview = (task.reviews || []).slice(-1)[0];
    const prompt = `/sb-work ${run.id} ${task.id} — the reviewer requested changes` +
      (lastReview?.file ? `; read ${lastReview.file} and address every point` : '');

    // Prefer feeding the rework into the still-alive worker session (its
    // context is intact); a failed PTY write falls through to a resume.
    const lastSession = (task.sessionIds || []).slice(-1)[0];
    if (lastSession && this.deps.isSessionActive(lastSession)) {
      if (this.deps.sendInput(lastSession, prompt + '\r')) {
        this._completeDispatch(projectPath, run, task, 'spawning',
          { pendingSessionId: null }, 'rework-nudged', lastSession);
        return true;
      }
      this.log.warn(`[orch] rework input to ${lastSession} failed; resuming in a fresh terminal`);
    }
    if (lastSession) {
      const res = await this.deps.openTerminal(lastSession, prep.cwd, false,
        this._sessionOptions(projectPath, run, task, role, prep.cwd, prompt));
      if (res && res.ok) {
        this._completeDispatch(projectPath, run, task, 'spawning',
          { pendingSessionId: null }, 'rework-resumed', lastSession);
        return true;
      }
    }
    // No previous session (or resume failed) — dispatch as a fresh worker.
    const spawn = await this._spawnSession(projectPath, run, task, role, prep.cwd, prompt, freshSessionId);
    if (!spawn.ok) return this._spawnFailed(projectPath, run, task, spawn.error);
    this._completeDispatch(projectPath, run, task, 'spawning', {
      sessionIds: [...(task.sessionIds || []), freshSessionId],
      pendingSessionId: null,
    }, 'rework-spawned', freshSessionId);
    return true;
  }

  async _dispatchReviewer(projectPath, run, policy, task) {
    // The review session id goes into the SAME write as the status change,
    // so there is no read-modify-write window racing other writers.
    const sessionId = this.deps.newSessionId();
    const tr = proto.transitionTask(projectPath, run.id, task.id, 'needs_review', 'reviewing',
      { reviewSessionIds: [...(task.reviewSessionIds || []), sessionId] });
    if (!tr.ok) return false;

    const rollback = (error) => {
      proto.transitionTask(projectPath, run.id, task.id, 'reviewing', 'needs_review',
        { reviewSessionIds: task.reviewSessionIds || [] });
      proto.appendEvent(projectPath, run.id, { type: 'review-spawn-failed', task: task.id, error });
      this.log.warn(`[orch] reviewer spawn failed for ${run.id}/${task.id}: ${error}`);
      return false;
    };

    // Reviewers work in the task's worktree (the branch under review).
    const prep = await this._prepareCwd(projectPath, run, policy, task);
    if (!prep.ok) return rollback(prep.error);
    const spawn = await this._spawnSession(projectPath, run, task, 'reviewer', prep.cwd,
      `/sb-review ${run.id} ${task.id}`, sessionId);
    if (!spawn.ok) return rollback(spawn.error);

    proto.appendEvent(projectPath, run.id, {
      type: 'reviewer-spawned', task: task.id, sessionId,
    });
    this.log.info(`[orch] reviewer spawned for ${run.id}/${task.id} (${sessionId})`);
    return true;
  }

  _spawnFailed(projectPath, run, task, error) {
    proto.appendEvent(projectPath, run.id, { type: 'spawn-failed', task: task.id, error });
    this.log.warn(`[orch] spawn failed for ${run.id}/${task.id}: ${error}`);
    // Roll back so the next reconcile pass (or a human) can retry; attempts
    // were already incremented at spawning time, so maxAttempts still bites.
    proto.transitionTask(projectPath, run.id, task.id, 'spawning', 'ready', { pendingSessionId: null });
    return false;
  }

  // --- master nudging -----------------------------------------------------
  //
  // The master agent doesn't poll; when something needs its judgment we type
  // one line into its terminal. Edge-triggered from watcher task deltas,
  // debounced so bursts collapse into a single nudge.

  _maybeQueueNudge(projectPath, runId, task, prev) {
    if (!prev || prev.status === task.status) {
      // Brand-new tasks are the master's own writes — no nudge needed.
      if (prev) return;
    }
    const noteworthy = {
      approved: `task ${task.id} approved by review`,
      blocked: `task ${task.id} is blocked (${task.blockedReason || 'see task file'})`,
      failed: `task ${task.id} failed${task.failReason ? ` (${task.failReason})` : ''}`,
      done: null, // handled below via run-completion check
    };
    let line = noteworthy[task.status];
    if (task.status === 'done') {
      const snap = this.watcher.getSnapshot(projectPath);
      const entry = snap?.runs.find(r => r.run.id === runId);
      if (entry && entry.summary.leaves > 0 && entry.summary.leavesDone === entry.summary.leaves) {
        line = 'all leaf tasks are done';
      }
    }
    if (!line) return;
    this._queueNudgeLine(projectPath, runId, line);
  }

  _queueNudgeLine(projectPath, runId, line) {
    // Nudge lines embed agent-written text (blockedReason, failReason) and
    // are typed into the master's PTY — control characters here would let a
    // rogue/buggy task file inject extra submitted prompts into the master
    // session. Strip them and cap the length.
    line = String(line).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);
    const key = projectPath + ' ' + runId;
    let q = this._nudgeQueues.get(key);
    if (!q) {
      q = { lines: [], timer: null, projectPath, runId };
      this._nudgeQueues.set(key, q);
    }
    if (q.lines.length < NUDGE_MAX_QUEUE && !q.lines.includes(line)) q.lines.push(line);
    if (!q.timer) {
      q.timer = setTimeout(() => { q.timer = null; this._flushNudge(key); }, this.nudgeDebounceMs);
      if (q.timer.unref) q.timer.unref();
    }
  }

  _flushNudge(key) {
    const q = this._nudgeQueues.get(key);
    if (!q || q.lines.length === 0 || this._stopped) return;
    const run = proto.readRun(q.projectPath, q.runId);
    if (!run || ['done', 'abandoned'].includes(run.status)) {
      this._nudgeQueues.delete(key);
      return;
    }
    const master = run.masterSessionId;
    const deliverable = master && this.deps.isSessionActive(master) && !this.deps.isSessionBusy(master);
    if (!deliverable) {
      // Master closed or thinking — retry later; the event log still has everything.
      q.timer = setTimeout(() => { q.timer = null; this._flushNudge(key); }, this.nudgeRetryMs);
      if (q.timer.unref) q.timer.unref();
      return;
    }
    const text = `[switchboard] ${q.lines.join('; ')} — run /sb-orchestrate to continue.`;
    this.deps.sendInput(master, text + '\r');
    proto.appendEvent(q.projectPath, q.runId, { type: 'master-nudged', lines: q.lines });
    this.log.info(`[orch] nudged master of ${q.runId}: ${q.lines.join('; ')}`);
    q.lines = [];
  }
}

module.exports = { OrchSpawner, RECONCILE_TICK_MS, NUDGE_DEBOUNCE_MS, STALE_GRACE_MS };
