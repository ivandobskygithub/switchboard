# Switchboard Agent Teams

Orchestrate a team of Claude Code sessions — a strong "master" model plans and
decomposes work; cheaper/faster (or local) models implement and review it in
parallel — all visible and controllable from Switchboard, fully automated
after planning.

> **New here?** Run `node scripts/seed-agent-teams-demo.js <your-project>` and
> open the **Agent Teams** tab to see a populated board immediately (no tokens
> spent). Then read [How it works](#how-it-works).

- [How it works](#how-it-works)
- [The file protocol](#the-file-protocol)
- [Roles and the model layering](#roles-and-the-model-layering)
- [Complexity tiers (cost control)](#complexity-tiers-cost-control)
- [The run lifecycle, step by step](#the-run-lifecycle-step-by-step)
- [Quick start](#quick-start)
- [How it integrates with Switchboard](#how-it-integrates-with-switchboard)
- [Operating a run](#operating-a-run)
- [Reliability guarantees](#reliability-guarantees)
- [Troubleshooting](#troubleshooting)
- See also: [CONFIGURATION.md](CONFIGURATION.md) · [EXTENDING.md](EXTENDING.md) · [ROADMAP.md](ROADMAP.md)

---

## How it works

Three ideas hold the whole system up:

1. **The file system is the source of truth.** Everything about a run — the
   plan, every task, every review, the event log — lives as files under
   `<project>/.switchboard/runs/<runId>/`. No database, no stateful server.
   Any participant (the master agent, a worker, a reviewer, Switchboard, you)
   can crash, restart, or be compacted and re-derive the entire world from
   disk. This is what makes long autonomous runs trustworthy.

2. **Workers are real, visible Claude Code sessions.** Each worker/reviewer is
   an ordinary Switchboard terminal running `claude` with a per-role model
   profile, isolated in its own git worktree. You can watch any of them, type
   into them, or stop them. Their transcripts appear in Switchboard exactly
   like any other session.

3. **Switchboard is a visualizer + thin executor, never the brain.** Its only
   active jobs are (a) *watch* the run files and render them, and (b) *spawn*
   sessions when a task becomes ready. Every decision — what to build, how to
   break it down, whether to merge — belongs to the master agent (or to you).

```
            plans / decides                         reads / renders
   ┌──────────────────────────┐            ┌──────────────────────────────┐
   │  Master session          │            │  Switchboard                 │
   │  (strong model: Opus/     │  files     │  • orch-watcher (watch runs) │
   │   Fable)                  │◀──────────▶│  • orch-spawner (ready→PTY)  │
   │  /sb-plan /sb-orchestrate │            │  • Teams GUI (board/plan/log)│
   └──────────────────────────┘            └───────────────┬──────────────┘
                  ▲                                         │ spawns
       file edits │ nudges (one line)                       ▼ visible PTY sessions
                  │                          ┌──────────────────────────────┐
   ┌──────────────┴───────────┐             │ Worker / reviewer sessions    │
   │ .switchboard/runs/<id>/  │◀───────────▶│ (deepseek / qwen / opus …)    │
   │ run.json tasks/ reviews/ │  file edits │ each in its own git worktree  │
   │ plan.md events.jsonl     │             │ /sb-work  /sb-review          │
   └──────────────────────────┘             └──────────────────────────────┘
```

The only coupling between any two parts is the files. That is deliberate: it
keeps Switchboard simple, keeps the agents model-agnostic, and makes the whole
thing resilient.

---

## The file protocol

```
<project>/
  .switchboard/
    guidelines.md            # code style + review rubric (shared by all runs)
    .gitignore               # ignores worktrees/
    runs/<runId>/
      run.json               # roles, model tiers, policy, status, integration branch
      plan.md                # the master's plan (markdown)
      tasks/<taskId>.json    # one file per task — the unit of work (schema below)
      tasks/<taskId>.spec.md # self-contained spec a small model can implement from
      reviews/<taskId>-<n>.md# reviewer verdicts
      prompts/<role>.md      # generated role system prompts
      events.jsonl           # append-only audit log (drives the timeline)
    worktrees/<runId>--<taskId>      # a worker's isolated checkout
    worktrees/<runId>--integration   # where the master merges (never your checkout)
```

A **task** is the atom of work. Its JSON (full schema in
[CONFIGURATION.md](CONFIGURATION.md)):

```json
{
  "id": "T-103",
  "title": "Rate-limit middleware",
  "kind": "leaf",                 // epic | chunk | leaf
  "parent": "C-02",
  "status": "changes_requested",  // the state machine, below
  "complexity": "high",           // trivial|low|medium|high|critical → model tier
  "dependsOn": ["T-101"],
  "filesHint": ["src/ratelimit/middleware.js"],
  "spec": "tasks/T-103.spec.md",
  "acceptance": ["429 over limit", "Retry-After header", "tests pass"],
  "sessionIds": ["<worker session uuid>"],
  "reviews": [{ "file": "reviews/T-103-1.md", "verdict": "changes_requested" }]
}
```

**The task status machine** (Switchboard validates every transition it makes,
and flags illegal ones it observes):

```
draft → ready → spawning → in_progress → needs_review → reviewing
   ↑                                                       │
   │                              ┌── approved ────────────┤
   │                              │                        ├── changes_requested ─┐
   └──────── blocked / failed ◀───┴── merging → done       └──────────────────────┘
                                                                    (re-dispatch)
```

Who owns each transition (a convention the prompts enforce, so writes don't
collide): the **master** owns `draft→ready` and the merge path
(`approved→merging→done`); **Switchboard** owns `ready→spawning→in_progress`
and the review dispatch (`needs_review→reviewing`); the **worker** owns
`in_progress→needs_review`; the **reviewer** owns
`reviewing→approved|changes_requested`.

---

## Roles and the model layering

A run defines three roles, each bound to a Switchboard **profile** (a named
bundle of env vars — `ANTHROPIC_BASE_URL`, auth token, model — that selects a
provider/model; manage them with the profiles button in the sidebar):

| Role | What it does | Typical model |
|---|---|---|
| **master** | Plans, decomposes, merges, unblocks. The one interactive session. | Fable / Opus |
| **worker** | Implements one leaf task in a worktree. | DeepSeek / Qwen (local) |
| **reviewer** | Adversarially reviews one task's branch. | Opus (or tiered) |

This already gives you the layering you want: a **state-of-the-art planner**
in charge, **cheaper implementers** doing the bulk, and an **independent
reviewer** gate. Complexity tiers (next section) take it further by varying the
worker model *per task*.

---

## Complexity tiers (cost control)

The planner tags every leaf task with a **complexity**:
`trivial · low · medium · high · critical`. The run's `tiers` map binds each
complexity to a model profile and an optional per-tier concurrency cap. So
cost scales with difficulty:

```json
"tiers": {
  "trivial":  { "profileId": "qwen-local", "maxConcurrent": 8 },
  "low":      { "profileId": "deepseek",   "maxConcurrent": 6 },
  "medium":   { "profileId": "deepseek",   "maxConcurrent": 4 },
  "high":     { "profileId": "opus",       "maxConcurrent": 1 },
  "critical": { "profileId": "opus", "reviewerProfileId": "opus", "maxConcurrent": 1 }
}
```

**Model resolution per task** (most specific wins):
`task.profileId` (explicit pin) → the tier for `task.complexity` → the role
default. So a one-line fix to subtle concurrency code can be tagged `high` and
get Opus, while scaffolding boilerplate runs `trivial` on a local Qwen — many
in parallel.

**Per-tier concurrency = independent ramp control.** The global "max parallel
workers" is the ceiling; each tier may cap itself underneath it. "8 cheap
trivial tasks at once, but only 1 Opus task at a time" is exactly expressible.

You see all of this on the board: each card shows its complexity badge and the
model it resolves to (`trivial → qwen-local`), and the run header shows the
tier roster.

---

## The run lifecycle, step by step

1. **Create a run** (Teams tab → *New run*, or `orch:create-run`). You pick the
   project, the goal, the role profiles, the worker ceiling, the model tiers,
   and the isolation mode. Switchboard scaffolds `.switchboard/`, installs the
   agent pack, creates the integration worktree, and **spawns the master
   session** booted with `/sb-plan`.
2. **Plan** (`/sb-plan`, master). The master studies the codebase, writes
   `plan.md`, and creates top-level **chunk** tasks. It shows you the plan and
   waits for your approval.
3. **Decompose** (`/sb-decompose`, master). Each chunk becomes small **leaf**
   tasks: one concern each, a self-contained spec, explicit acceptance
   criteria, `filesHint`, `complexity`, and dependency edges. Then it sets the
   run `active`.
4. **Implement** (automatic). Switchboard's spawner sees `ready` leaf tasks and
   launches a worker per task — in a fresh worktree, with the tier's model —
   booted with `/sb-work`. Concurrency respects the global cap, per-tier caps,
   dependencies, and **file-overlap** (two tasks touching the same file never
   run at once).
5. **Review** (automatic). A worker that finishes sets its task
   `needs_review`; the spawner launches a **reviewer** session (its own model)
   booted with `/sb-review`. The reviewer writes a verdict file and sets
   `approved` or `changes_requested`. Rejected work is fed back to the worker.
6. **Merge** (master, via nudge). When tasks are `approved`, Switchboard types
   a one-line nudge into the idle master terminal; the master runs
   `/sb-orchestrate`, merges approved branches into the integration branch in
   the **integration worktree**, runs the chunk's validation gate, marks tasks
   `done`, and advances to the next chunk.
7. **Finish.** When every chunk is done and validation passes, the master sets
   the run `done` and tells you how to merge the integration branch into your
   main branch. Switchboard cleans up the run's worktrees.

After step 3, **no human input is required** — but every session is watchable
and every decision is overridable from the board.

---

## Quick start

```bash
# 1. See it populated immediately (no tokens spent):
node scripts/seed-agent-teams-demo.js /path/to/a/git/project
#    → open Switchboard, Agent Teams tab, click the demo run.

# 2. For a real run you need model profiles. In the sidebar profiles panel,
#    create e.g. "opus" (Anthropic), "deepseek" (DeepSeek anthropic endpoint),
#    "qwen-local" (your local OpenAI/Anthropic-compatible endpoint).

# 3. Teams tab → New run → pick project, goal, role profiles, tiers → Create.
#    You land in the master terminal running /sb-plan. Approve the plan and
#    walk away; the board fills in as workers and reviewers run.
```

The agent-pack commands (`/sb-plan`, `/sb-decompose`, `/sb-orchestrate`,
`/sb-work`, `/sb-review`, `/sb-merge`) are installed automatically into
`~/.claude/commands` at Switchboard startup, so they resolve in every session —
including worktree sessions whose checkouts don't contain the project's local
`.claude/commands`.

---

## How it integrates with Switchboard

| Concern | Where | Note |
|---|---|---|
| Spawn a session | `main.js` `openTerminalImpl` | Workers go through the *same* path as user-opened terminals — profiles, MCP, OSC busy-detection all apply. |
| Model/provider | `profiles.js` | Per-session `ANTHROPIC_BASE_URL`/token/model. Tiers select a profile per task. |
| Run state → GUI | `orch-watcher.js` → `orchestration-updated` IPC | Level-triggered; a missed fs event self-heals next pass. |
| Spawn decisions | `orch-spawner.js` | The only "active" orchestration logic; everything else reacts to files. |
| Sidebar sanity | `derive-project-path.js` | Worktree transcripts map back to the parent project; team sessions group under the run slug. |
| Startup install | `orch-bootstrap.js` | Installs the agent pack into `~/.claude` (hash-stamped, idempotent). |

Your existing Switchboard sessions are unaffected: team sessions are normal
sessions that happen to be grouped and badged.

---

## Operating a run

From the **Agent Teams** tab:

- **Board** — kanban across the status machine. Cards link to the live
  worker/reviewer terminal, the spec, and the latest review. Status-specific
  buttons (Approve, Request changes, Retry, Mark ready) let you override —
  these write through the same protocol the agents use, so even your manual
  actions are first-class.
- **Plan** — rendered `plan.md` beside the epic→chunk→leaf task tree.
- **Timeline** — the `events.jsonl` history (spawns, reviews, merges, nudges,
  recoveries, protocol warnings).
- **Pause / Resume** — stops/starts all spawning instantly (sets run status).
- **Master session** — jump into the planner terminal to intervene or re-plan.

---

## Reliability guarantees

Built for long unattended runs (validated with real Haiku/DeepSeek sessions):

- **Crash recovery.** Switchboard killed mid-run? On restart it rescans and a
  *stale-session sweep* recovers any task whose worker/reviewer died without
  finishing (→ `failed`/`needs_review`/`ready`) after a grace period.
- **No double-dispatch.** Status transitions are optimistic — they re-validate
  against disk at write time, so two passes can't both grab the same task.
- **File-overlap safety.** Raising concurrency never puts two workers on the
  same file; overlapping tasks serialize automatically.
- **Agent-drift absorption.** Small models that emit a status typo
  (`needs_revision`) or a non-canonical review shape are auto-corrected; a
  verdict with no review recorded raises a `protocol-warning` and nudges the
  master rather than silently merging.
- **Bounded everything.** `events.jsonl` is read tail-only; dedupe sets are
  pruned; nudge retries to a dead master are capped; finished runs clean up
  their worktrees.
- **No injection.** Agent-written text typed into the master PTY is stripped of
  submit-class control chars; review-file reads are realpath-contained.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "project is not a git repository" on New run | Worktree isolation needs a git repo. `git init` the project, or choose *Shared working dir* isolation. |
| A task is stuck `in_progress` and its terminal closed | The stale sweep recovers it to `failed` after ~90s; check the timeline. The master then re-plans or retries. |
| `/sb-work` "command not found" in a worker | The startup install didn't run. Restart Switchboard, or copy `~/.claude/commands/sb-*.md` (see `orch-bootstrap.js`). |
| Reviewer approved but no review file | You'll see a `protocol-warning` event and a master nudge; Switchboard normalizes near-misses, but verify before merging. |
| Board shows "⚠ N invalid task files" | An agent wrote malformed JSON. Hover the badge for the file + error; the master can fix it. |
| Too many sessions on screen | Lower the global worker cap or per-tier caps; the board still shows all tasks, only running ones attach terminals. |
| Worktrees piling up in `.switchboard/worktrees` | Done tasks and finished runs are auto-cleaned; if a run was force-killed, `git worktree prune` in the project. |

See [CONFIGURATION.md](CONFIGURATION.md) for every knob, [EXTENDING.md](EXTENDING.md)
to add review passes/roles/gates, and [ROADMAP.md](ROADMAP.md) for known gaps.
