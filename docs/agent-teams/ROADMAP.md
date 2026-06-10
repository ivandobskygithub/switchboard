# Agent Teams — Gap analysis & roadmap

An honest assessment of what's missing or worth strengthening, roughly in
priority order. Each item notes **impact**, **effort**, and a **sketch** so it's
actionable. Nothing here blocks the current feature — it works end to end — but
this is where to invest next.

## Tier 1 — highest leverage

### 1. Cost & token telemetry per run
**Impact: high. Effort: medium.** You're optimising for cost but can't yet *see*
it. Every session's JSONL records `usage` (tokens) and Claude Code can emit
cost. Roll this up per task / tier / run and show it in the run header and on
cards ("T-103 · $0.04 · 12k tok"), plus a per-tier spend bar so you can tell
whether your tiering is actually saving money.
*Sketch:* a worker that parses each session's JSONL `usage` (Switchboard already
indexes these files), aggregates by the task's `sessionIds`, and surfaces via a
new `orch:get-run` field. Optionally wire `CLAUDE_CODE_ENABLE_TELEMETRY`/OTEL
for live metrics.

### 2. Budget caps (stop-loss)
**Impact: high. Effort: low–medium.** A runaway loop on a paid model is the main
cost risk in unattended runs. Add `run.policy.maxBudgetUsd` (whole run) and/or
per-tier budgets; when exceeded, auto-pause the run and nudge you. Headless
`claude -p` supports `--max-budget-usd`; for interactive sessions, derive spend
from telemetry (item 1) and pause when crossed.

### 3. Deterministic validation gates
**Impact: high. Effort: medium.** Today the chunk validation gate (lint/tests
before `done`) is *prompt-trusted* — the master is told to run it. Make it
engine-enforced: `run.policy.validateCmd` (or per-chunk), run via `execFile` in
the integration worktree on `merging`, driving `merging→done|failed` directly.
This is the single biggest "trust it to not break the build" upgrade.

### 4. Multi-lens / quorum review for critical work
**Impact: high (quality). Effort: medium.** One reviewer is a single point of
failure for correctness. For `critical` (and optionally `high`) tasks, run
N independent reviewers with distinct lenses and require a quorum to approve.
Recipe and code sketch in [EXTENDING.md](EXTENDING.md#recipe-multi-lens-parallel-review).

## Tier 2 — robustness & scale

### 5. Stale-base worktree detection on rework
**Impact: medium. Effort: medium.** If the master rebases the integration branch
while a task is out for rework, the *reused* task worktree sits on a stale base
→ a silent wrong-base merge is possible (the merge step would usually surface a
conflict, so it's not silent data loss). Detect it: on worktree reuse, check the
task branch is a descendant of the current integration branch; if not, emit a
`stale-base` event and either auto-rebase (when clean) or block for the master.

### 6. Centralise the status machine
**Impact: medium (maintainability). Effort: low–medium.** Status knowledge lives
in four places (`orch-protocol.TASK_TRANSITIONS`, `orch-ipc.TASK_ACTIONS`,
`orchestration-view` columns/labels, CSS). Adding a status means editing all
four — drift risk. Derive the GUI's columns/labels/actions from a single
exported descriptor in `orch-protocol.js`.

### 7. Incremental snapshots for very large runs
**Impact: medium (scale). Effort: medium.** The watcher rescans *all* tasks on
each fs event and the GUI rebuilds the board on each update. Fine to ~150 tasks;
past that, switch to per-file diffing in the watcher and keyed DOM reconciliation
(morphdom is already a dependency) on the board.

### 8. Run templates / presets
**Impact: medium (UX). Effort: low.** Save a role+tier+policy configuration as a
named template ("cheap local build", "max-rigor paid build") so starting a run
is one click. Just persist the dialog's config blob and offer it in the dialog.

## Tier 3 — capability expansion

### 9. Cross-task / cross-run dependencies & scheduling
**Impact: medium. Effort: medium.** `dependsOn` is within a run; there's no
"run B starts when run A's integration branch lands" or calendar scheduling.
Switchboard already has a scheduler (`schedule-runner.js`) — bridge it.

### 10. Human-in-the-loop checkpoints
**Impact: medium. Effort: low.** A task/chunk flag `requiresApproval: true` that
parks it in a "Needs you" column and won't merge until you click — for the parts
you don't want fully autonomous. The override buttons already exist; this just
adds an explicit gate state.

### 11. Richer worktree/merge visualisation
**Impact: low–medium. Effort: medium.** Show the actual branch diff per task in
the file-panel (the diff component already exists for MCP), and a merge-order
view of the integration branch. Today you click into the terminal or read the
review.

### 12. Notifications
**Impact: low–medium. Effort: low.** Desktop/push notification when a run
finishes, blocks, or needs you — so you can truly walk away. Switchboard already
flashes the taskbar on attention OSC; extend to run-level events.

### 13. Non-Claude workers / tools as roles
**Impact: medium (flexibility). Effort: medium.** A role that runs a different
CLI (codex, aider, a custom script) instead of `claude`, for genuine
cross-model diversity in review. Recipe in
[EXTENDING.md](EXTENDING.md#recipe-add-a-new-role); needs a per-role command
builder in the spawn path.

### 14. Replan / fork a run
**Impact: low. Effort: medium.** First-class "the plan was wrong — revise it and
re-decompose affected chunks" flow, and forking a run to try an alternative
approach. The master can already edit `plan.md` and tasks; this would make it a
guided GUI action with history.

---

## Explicitly *not* planned (and why)

- **A stateful MCP orchestration server.** Files are the source of truth on
  purpose — it's what makes crashes and compaction survivable. An MCP server
  could later be an *additive read/command API* over the same files, but never
  the state owner.
- **Headless-only workers.** Visible PTY sessions are a deliberate choice so you
  can watch and intervene. The protocol doesn't care how a session was spawned,
  so a headless mode could be added later without touching it.
- **Embedding the orchestration brain in Switchboard.** The master agent
  decides; Switchboard executes and visualises. Keeping that boundary is what
  keeps the app simple and the agents swappable.
