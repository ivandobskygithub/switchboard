# Agent Teams — Extending the workflow

The system is deliberately small and file-driven, which makes it easy to
extend. This page gives concrete recipes — especially for **adding more code
review steps**, which is the most common ask.

- [Mental model for extensions](#mental-model-for-extensions)
- [Recipe: tune the review bar](#recipe-tune-the-review-bar) (no code)
- [Recipe: add a dedicated security review pass](#recipe-add-a-dedicated-security-review-pass)
- [Recipe: multi-lens parallel review](#recipe-multi-lens-parallel-review)
- [Recipe: an adversarial second opinion (Codex-style)](#recipe-an-adversarial-second-opinion-codex-style)
- [Recipe: a pre-merge CI/lint gate](#recipe-a-pre-merge-cilint-gate)
- [Recipe: add a new role](#recipe-add-a-new-role)
- [Recipe: add a status to the machine](#recipe-add-a-status-to-the-machine)
- [Where things live (code map)](#where-things-live-code-map)
- [Testing your extension](#testing-your-extension)

---

## Mental model for extensions

There are three layers you can extend, cheapest first:

1. **Prompts** (`orch-templates.js`) — change *what the agents do* without
   touching the engine. Adding review criteria, a second review pass driven by
   the master, or a new validation step is usually just prompt text. **Start
   here.**
2. **Config** (`run.json` `policy`/`tiers`) — change *how much* and *with what
   model*. New knobs are a field + a read.
3. **Engine** (`orch-spawner.js`, `orch-protocol.js`) — change *the mechanism*:
   new statuses, new automated dispatch, new gates. More power, more care.

Because state is files, most "add a step" requests are layer 1 or 2.

---

## Recipe: tune the review bar

**No code.** Edit `.switchboard/guidelines.md` in the project. The reviewer
reads it every task. Add lenses, tighten severity definitions, require specific
checks (e.g. "every public function has a doc comment", "no `any` in new TS").
The reviewer's verdict (`approved`/`changes_requested`) is driven by this file
plus the task's acceptance criteria.

---

## Recipe: add a dedicated security review pass

Goal: after the normal review approves, run a **second, security-focused**
review before the task can merge.

**Option A — prompt-only (master-driven), no engine change.** In
`orch-templates.js`, extend the `/sb-orchestrate` master prompt: "Before
merging an `approved` task, if it touches auth/input/network code, set it back
to `needs_review` once with a note `security-pass` in events.jsonl, and ensure
the next reviewer applies the security lens." The master already owns the merge
step, so it can gate. Cost: a few lines of prompt; the existing review
machinery does the rest.

**Option B — engine gate (deterministic).** Add a `securityReviewed` boolean to
the task and a spawner step that, for approved tasks lacking it, spawns one
more reviewer with a security `--append-system-prompt` and flips the task back
to `reviewing`. Sketch in `orch-spawner.js`:

```js
// in _reconcileRun, after the reviewer dispatch loop:
if (policy.securityPass) {
  for (const t of tasks.filter(x => x.status === 'approved' && !x.securityReviewed)) {
    // mark it reviewing again, spawn a reviewer whose rolePrompt adds the
    // security lens, and set securityReviewed:true on the next approve.
  }
}
```

Add `securityPass` to `DEFAULT_POLICY`, a `securityReviewed` allowance in
`validateTask`, and a focused prompt. Use Option A unless you need it
guaranteed.

---

## Recipe: multi-lens parallel review

Goal: review each task through several **independent lenses** at once
(correctness, security, performance, tests) and require a majority/all to
approve — the highest-confidence gate.

This is an engine change. The cleanest shape:

1. Add `run.reviewLenses: ["correctness","security","performance"]` to config.
2. In `orch-spawner._dispatchReviewer`, instead of one reviewer, spawn one per
   lens, each with a lens-specific `--append-system-prompt`, each writing
   `reviews/<taskId>-<lens>-<n>.md`.
3. Replace the single `reviewing→approved|changes_requested` transition with an
   aggregation: the task stays `reviewing` until all lenses have written a
   verdict, then a small reducer sets `approved` only if all (or a configured
   quorum) approved, else `changes_requested` with the merged blockers.

Keep the aggregation in Switchboard (deterministic), not in an agent. See the
adversarial-verify pattern: independent skeptics beat one reviewer iterated.
This is the natural "ramp up review rigor for critical tiers" feature — gate it
on `complexity === 'critical'` to keep it cheap.

---

## Recipe: an adversarial second opinion (Codex-style)

Prior art: OpenAI's Codex plugin runs an *adversarial* review that questions
the approach, not just correctness. You can do the same with a **different
provider** as the second reviewer — which Agent Teams already supports via
profiles.

- Set the `critical` tier's `reviewerProfileId` to a different model than the
  worker (e.g. worker DeepSeek, reviewer Opus — or a GPT profile if you add an
  OpenAI-compatible one).
- In `guidelines.md`, add an "adversarial" review section: "Assume the
  implementation is wrong and the approach is questionable. Surface tradeoffs
  and failure modes, not just bugs."

No engine change — it's a profile + a prompt. For a *separate tool* (literal
`codex` CLI) as a reviewer, add a role whose session command runs that tool;
see [add a new role](#recipe-add-a-new-role).

---

## Recipe: a pre-merge CI/lint gate

Goal: a task can't be `done` until lint + the chunk's tests pass on the
integration branch.

This already exists as **prompt policy**: `/sb-orchestrate` instructs the
master to run the chunk's validation command after merging and only then mark
`done`, marking `failed` on a gate failure. To make it **deterministic** instead
of prompt-trusted, add a spawner step that, for a `merging` task, runs the
configured `validateCmd` via `execFile` in the integration worktree and drives
the `merging→done|failed` transition itself. Put the command in
`run.policy.validateCmd` or per-chunk in the chunk task.

---

## Recipe: add a new role

E.g. a `docs` role that writes documentation, or an external `codex` reviewer.

1. **Config**: add the role to `run.roles` (the schema allows any
   `^[a-z][a-z0-9-]{0,31}$` role name with a `{profileId, maxConcurrent}`).
2. **Prompt**: add a `/sb-<role>` command to `orch-templates.js` `COMMANDS` and
   a branch in `rolePrompt()`. Re-run startup install (or it installs on next
   launch).
3. **Dispatch**: decide what triggers it. If it's "after approve, before
   merge", add a status or a boolean flag and a spawner dispatch loop mirroring
   `_dispatchReviewer`. If it's external (runs `codex` not `claude`), give the
   spawn path a different command builder.

A role that runs a non-Claude tool just needs its `openTerminal` call to build
that tool's command instead of `claude` — the rest (worktree, file protocol,
visibility) is unchanged.

---

## Recipe: add a status to the machine

If a recipe needs a genuinely new state (e.g. `security_review`):

1. `orch-protocol.js`: add it to `TASK_TRANSITIONS` with its legal in/out
   edges; add aliases if small models will mistype it.
2. `orch-ipc.js` `TASK_ACTIONS`: add any human action that targets it.
3. `orch-spawner.js`: add the dispatch/cleanup that consumes it, and include it
   in `ACTIVE_WORKER/REVIEWER_STATUSES` or the file-overlap "occupied" set if
   it holds unmerged work.
4. `public/orchestration-view.js`: add it to a board column, `ORCH_STATUS_LABELS`,
   and the status CSS.

The status machine is the one place knowledge is duplicated across layers —
change all four together. (See [ROADMAP.md](ROADMAP.md): centralising this is a
known improvement.)

---

## Where things live (code map)

| You want to change… | Edit |
|---|---|
| What an agent does/says | `orch-templates.js` (commands + `guidelines.md` template + `rolePrompt`) |
| The task/run schema, status machine, resolvers | `orch-protocol.js` |
| When/what gets spawned, gates, recovery | `orch-spawner.js` |
| Run/task IPC + human actions | `orch-ipc.js` + `preload.js` |
| The board / dialog / timeline | `public/orchestration-view.js` (+ `style.css`) |
| Startup asset install | `orch-bootstrap.js` |
| Git worktree ops | `worktree-manager.js` |
| PTY submit-char safety | `submit-chars.js` |

---

## Testing your extension

The suite is `node --test` (no framework). Mirror the existing patterns:

- **Engine logic** — `test/orch-spawner-hardening.test.js` style: a temp
  project, `createRun`, write tasks, inject a fake `deps` (no Electron, no
  real `claude`), call `spawner.reconcile`, assert file transitions + events.
- **Protocol** — `test/orch-protocol.test.js`: pure functions, temp dirs.
- **Real sessions** — `test/live-smoke.test.js` (`SB_LIVE_SMOKE=1`): drives a
  real cheap model end-to-end. Run it after a prompt change to confirm a small
  model still follows the protocol.
- **GUI** — `test/ui-e2e.test.js`: boots Electron against a sandboxed home,
  drives the board over CDP, screenshots it. Extend it when you add UI.

Run `node --test` before committing; keep timing assertions poll-based, not
fixed sleeps.
