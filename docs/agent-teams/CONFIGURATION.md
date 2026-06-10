# Agent Teams — Configuration reference

Everything is configured in `run.json` (created from the New-run dialog or
`orch:create-run`, then editable on disk) plus the shared
`.switchboard/guidelines.md`. This page is the exhaustive reference.

- [run.json](#runjson)
- [Roles](#roles)
- [Model tiers](#model-tiers)
- [Policy](#policy)
- [Review (multi-lens)](#review-multi-lens)
- [Phase gates](#phase-gates)
- [Budget caps](#budget-caps)
- [Cost telemetry](#cost-telemetry)
- [Task schema](#task-schema)
- [Profiles (how a model is selected)](#profiles-how-a-model-is-selected)
- [guidelines.md](#guidelinesmd)
- [Editing a run by hand](#editing-a-run-by-hand)

---

## run.json

```json
{
  "id": "2026-06-10-add-rate-limiting-a1b2",
  "title": "Add API rate limiting",
  "goal": "Per-IP rate limiting with tests and docs.",
  "status": "active",
  "createdAt": "2026-06-10T12:00:00.000Z",
  "masterSessionId": "<uuid>",
  "integrationBranch": "teams/2026-06-10-add-rate-limiting-a1b2",
  "roles": { "...": "see Roles" },
  "tiers": { "...": "see Model tiers" },
  "policy": { "...": "see Policy" }
}
```

| Field | Meaning |
|---|---|
| `id` | Immutable run id (date-slug-hex). Names the run dir and branch prefixes. |
| `status` | `planning` → `active` → `paused`/`done`/`abandoned`. Only `active` runs spawn. |
| `masterSessionId` | The interactive planner session; nudges are typed here. |
| `integrationBranch` | Branch the master merges approved task branches into. Defaults to `teams/<id>`. |
| `roles` / `tiers` / `policy` | Below. |

---

## Roles

```json
"roles": {
  "master":   { "profileId": "opus" },
  "worker":   { "profileId": "deepseek", "maxConcurrent": 6 },
  "reviewer": { "profileId": "opus", "maxConcurrent": 2 }
}
```

| Key | Default | Meaning |
|---|---|---|
| `profileId` | global default profile | The model profile for this role's sessions. `null` = use Switchboard's default. |
| `maxConcurrent` | worker 4, reviewer 2 | Max simultaneous sessions for the role. Capped at 16. |
| `permissionMode` | `acceptEdits` | Optional. Claude Code permission mode for the role's sessions. |

`worker.maxConcurrent` is the **global ceiling** for all worker tasks; per-tier
caps apply underneath it.

---

## Model tiers

Optional. Maps task complexity → model. Omit entirely to make every task use
the worker/reviewer role default.

```json
"tiers": {
  "trivial":  { "profileId": "qwen-local", "maxConcurrent": 8 },
  "low":      { "profileId": "deepseek",   "maxConcurrent": 6 },
  "medium":   { "profileId": "deepseek",   "maxConcurrent": 4 },
  "high":     { "profileId": "opus",       "maxConcurrent": 1 },
  "critical": { "profileId": "opus", "reviewerProfileId": "opus", "maxConcurrent": 1 }
}
```

Tier names are fixed: `trivial`, `low`, `medium` (default when a task is
untagged), `high`, `critical`. Each entry may set:

| Key | Effect |
|---|---|
| `profileId` | Worker model for tasks of this complexity. |
| `reviewerProfileId` | Reviewer model for tasks of this complexity (else role default). |
| `maxConcurrent` | Cap on simultaneous workers of this complexity (within the global cap). |

**Resolution order** for a task's worker model:
`task.profileId` → `tiers[task.complexity].profileId` → `roles.worker.profileId`.
Reviewer: `task.reviewerProfileId` → `tiers[...].reviewerProfileId` →
`roles.reviewer.profileId`.

### Recommended starting point (cost-optimised)

| Tier | Model | Why |
|---|---|---|
| trivial | local Qwen / Haiku | boilerplate, renames, doc edits — run wide |
| low | DeepSeek V4 Flash | simple, well-specified changes |
| medium | DeepSeek V4 | the bulk of implementation |
| high | Opus | subtle logic, concurrency, security-sensitive |
| critical | Opus (+ Opus review) | anything where a wrong merge is expensive |

---

## Policy

```json
"policy": {
  "autoSpawnWorkers": true,
  "autoSpawnReviewers": true,
  "autoMerge": true,
  "maxAttempts": 3,
  "isolation": "worktree"
}
```

| Key | Default | Meaning |
|---|---|---|
| `autoSpawnWorkers` | `true` | Spawn workers for `ready` tasks automatically. Off → you spawn manually / via the master. |
| `autoSpawnReviewers` | `true` | Spawn reviewers for `needs_review` tasks automatically. |
| `autoMerge` | `true` | The master merges approved tasks (the master prompt honours this; flip off to gate merges on you). |
| `maxAttempts` | `3` | A task that fails to spawn or is rejected this many times is `blocked`. |
| `isolation` | `worktree` | `worktree` = one git worktree per task (recommended; needs a git repo). `none` = shared working dir (only safe at low concurrency or with disjoint files). |
| `gatesEnabled` | `true` | Run phase gates (below). |
| `validateCmd` | `null` | Default phase-gate command (a chunk's own `validateCmd` overrides). |
| `maxBudgetUsd` | `null` | Stop-loss in USD (needs provider cost data — see [Budget caps](#budget-caps)). |
| `maxOutputTokens` | `null` | Stop-loss in output tokens (always works). |

---

## Review (multi-lens)

Each task is reviewed through one or more **lenses**, each a separate reviewer
session (possibly a different model) writing its own verdict file; Switchboard
aggregates them. Lenses:

| Lens | Checks |
|---|---|
| `spec` | spec/PRD/goal conformance — does it do exactly what's required? |
| `functionality` | correctness, edge cases, integration without breaking callers |
| `tests` | tests exist, assert real behaviour, fail on regression |
| `security` | injection, traversal, secrets, unsafe input, authn/authz |
| `style` | matches guidelines.md + surrounding code; naming, duplication, clarity |

```json
"review": {
  "lensesByComplexity": {            // optional — override the cost-aware default
    "trivial":  ["functionality", "style"],
    "critical": ["spec", "functionality", "tests", "security", "style"]
  },
  "lenses": ["spec", "functionality"], // optional flat override (all tasks)
  "quorum": "all",                     // "all" (default) or an integer N
  "enabled": true                      // false → auto-approve (not recommended)
}
```

**Default (no `review` config):** lens depth scales with complexity —
`trivial`: functionality+style · `low`: +tests · `medium`: +spec ·
`high`/`critical`: +security. This keeps cheap tasks cheap and reserves the
full 5-lens gate for hard ones.

**Resolution** for a task's lenses: per-task `lenses` → `review.lensesByComplexity[tier]`
→ `review.lenses` → the cost-aware default. **Quorum**: `all` means every lens
must approve (recommended — a single security blocker stops the merge); an
integer N means at least N of the applied lenses must approve.

Per-task overrides: `task.lenses` (which lenses), `task.profileId` /
`task.reviewerProfileId` (which models).

---

## Phase gates

A deterministic build-stays-green check, run by Switchboard (not just promised
by a prompt). A **chunk** carries a `validateCmd` (or `policy.validateCmd` as
the default). When every leaf of the chunk is `done`, Switchboard runs the
command in the integration worktree via your shell; the chunk becomes `done`
only if it passes (exit 0), else `blocked` with the output — the master then
adds fix tasks and re-opens the chunk. Set `policy.gatesEnabled: false` to
disable. Timeout: 10 minutes per gate.

> **Trust note:** `validateCmd` runs a shell command in your repo. It comes
> from the New-run dialog (you) or `run.json`. Treat it like any command you'd
> run yourself; don't point a run at an untrusted `run.json`.

---

## Budget caps

Stop-loss for unattended runs. When spend crosses a cap, Switchboard
auto-pauses the run and nudges the master.

| Cap | Reliability |
|---|---|
| `policy.maxOutputTokens` | Always works (tokens are always recorded). |
| `policy.maxBudgetUsd` | Only fires when the session transcripts carry real cost figures (provider-dependent); otherwise inert. |

Resume by raising the cap (edit `run.json`) and setting `status` back to
`active`, or finish manually.

---

## Cost telemetry

`orch:get-run` returns a `cost` roll-up — `{ run, byTask, byTier }` — summing
input/output/cache tokens (and cost when present) by each task's session ids.
Shown in the run header (total, vs cap) and on each card (per-task). Tokens are
always real; cost only appears when the provider records it (never estimated).

---

## Task schema

Written by the master/decomposer; Switchboard and the workers update specific
fields. Validated on every read — invalid files surface as a board warning.

| Field | Type | Notes |
|---|---|---|
| `id` | string | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. File must be `<id>.json`. |
| `title` | string | Short imperative. |
| `kind` | `epic`\|`chunk`\|`leaf` | Only `leaf` tasks are dispatched to workers. |
| `parent` | task id | The chunk/epic this rolls up to. |
| `status` | enum | The status machine. Same-state aliases (e.g. `needs_revision`) are auto-canonicalised. |
| `complexity` | enum | `trivial`\|`low`\|`medium`\|`high`\|`critical`. Selects the tier. Default `medium`. |
| `dependsOn` | string[] | Task ids that must be `done` first. Cycles are detected → `blocked`. |
| `filesHint` | string[] | Files the task touches. **Drives the overlap guard** — fill it accurately. |
| `spec` | path | `tasks/<id>.spec.md` — the self-contained brief. |
| `acceptance` | string[] | Criteria the worker self-verifies and the reviewer checks. |
| `profileId` | profile id | Optional explicit worker-model override (beats the tier). |
| `reviewerProfileId` | profile id | Optional explicit reviewer-model override. |
| `lenses` | string[] | Optional per-task review lens override. |
| `validateCmd` | string | Phase gate for a `chunk` (overrides `policy.validateCmd`). |
| `sessionIds` | string[] | Worker session ids (Switchboard-managed). |
| `reviewSessionIds` | string[] | Reviewer session ids. |
| `reviews` | `[{file,verdict}]` | Review history. |
| `attempts` | number | Spawn/rework attempts (vs `maxAttempts`). |
| `summary` | string | The worker's closing summary. |
| `blockedReason` / `failReason` | string | Why a task is blocked/failed (shown on the card + nudged). |

---

## Profiles (how a model is selected)

A **profile** is a named env-var bundle applied at session spawn (managed in
Switchboard's sidebar profiles panel, stored in `profiles.json`). The relevant
vars:

| Var | For |
|---|---|
| `ANTHROPIC_BASE_URL` | Provider endpoint. Empty = Anthropic. DeepSeek: `https://api.deepseek.com/anthropic`. A local Qwen behind an Anthropic-compatible server: its URL. |
| `ANTHROPIC_AUTH_TOKEN` | The key (often a `$REF` to a host env var, so secrets never hit disk). |
| `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` | Pin the model/aliases. |

Presets exist for Anthropic, DeepSeek, GLM, and OpenRouter. To add a **local
Qwen**: make a profile with `ANTHROPIC_BASE_URL` = your server, the model name,
and a token if it needs one — then assign it to the `trivial`/`low` tier.

---

## guidelines.md

`.switchboard/guidelines.md` is read at the start of every worker and reviewer
task. Edit it to encode your house style and review bar (severity definitions,
test policy, security baseline). It is created once from a template and never
overwritten — it's yours.

---

## Editing a run by hand

Because the protocol is just files, you can edit `run.json` or a task file in
any editor (or have the master do it). Switchboard's watcher picks up changes
within a couple of seconds. Two rules:

1. **Write valid JSON** (the board flags invalid files). Keep `<id>.json`
   matching the `id` inside.
2. **Respect the state machine** — set a status only to a legal next state for
   its current one. Switchboard refuses illegal transitions it performs, and
   flags illegal ones it observes.

To stop everything instantly: set `run.json` `"status": "paused"` (or click
Pause). To tear a run down: Abandon it (GUI) or delete its run dir;
`.switchboard/worktrees` are git-ignored and cleaned on finish.
