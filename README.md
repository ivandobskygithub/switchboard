# Switchboard

Desktop app for managing local Claude Code CLI sessions. Hardened fork for corp / offline use.

## What it does

- Browse, launch, resume, and fork Claude Code sessions across projects
- Built-in terminal with MCP-based diff/file review panel
- Plans, memory (`CLAUDE.md`), and activity heatmap in one place
- Full-text search across session history

## Status notifications

Switchboard parses OSC escape sequences from each Claude CLI PTY and surfaces state without you needing to look at the terminal:

- **Busy / idle** — spinner-style title updates flip `cli-busy-state` over IPC, which colours the sidebar indicator.
- **Attention needed** — "Claude Code needs your attention", permission-approval prompts, and "wants to enter" dialogs are caught by a regex in `public/app.js` and badge the sidebar entry when that session isn't currently focused.
- **Status bar** — free-form text messages from the main process (`status-update` IPC) appear in the status bar at the bottom of the window.

Nothing in the hardening removed this — `terminal-notification`, `cli-busy-state`, and `status-update` IPC channels all remain.

## Offline / corp posture

This build is intentionally locked down:

- **No auto-updates.** `electron-updater` has been removed. The app never contacts GitHub.
- **No Anthropic usage API.** `claude-auth.js` and the Rate-Limits panel have been removed.
- **CSP** restricts `connect-src` to `'self'` + `ws(s)://127.0.0.1:*`.
- **Renderer** runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- **IPC path access** goes through a whitelist (project dirs + `~/.claude/`) with a deny list for `.credentials.json`, `.ssh`, `.aws/credentials`, `.netrc`, `.gnupg`, `id_rsa/id_ed25519`.
- **Shell commands** to the Claude CLI are built with strict validation + POSIX single-quote escaping (`claude-cmd.js`).
- **MCP WebSocket** binds `127.0.0.1` only; auth token compared in constant time; lockfile `0600`; Origin-header connections rejected.
- **Deps pinned** to exact versions in `package-lock.json`. `npm install` is blocked by a `preinstall` guard — use `npm ci`.

Outbound network:

- **Zero runtime egress** from Switchboard itself (other than `shell.openExternal` on a user-clicked terminal link).
- The child `claude` process makes its own calls; point it at your internal endpoint with `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` in `~/.zshrc`. `window.api.reloadShellEnv()` re-sources rc files without an app restart.

## Build / run

```bash
npm ci          # reproducible install; npm install is blocked
npm start       # bundles codemirror + runs electron
npm test        # node --test
```

Per-platform builds generate `electron-builder-config.json` from `branding.json` first:

```bash
npm run build:mac
npm run build:win
npm run build:linux
```

Output in `dist/`.

## Reskin / rebrand

Skins live under `skins/<name>/` — see [`skins/README.md`](skins/README.md) for the full workflow. Quick version:

```bash
cp -r skins/switchboard skins/<name>
$EDITOR skins/<name>/branding.json        # edit productName, appId, …
# drop in icon.png / icon.icns / icon.ico / dmg-background.png
SWITCHBOARD_SKIN=<name> npm run build:mac
```

`skins/*` other than `skins/switchboard/` is git-ignored, so private skins stay local.

## Env vars

| Var | Purpose |
|-----|---------|
| `ANTHROPIC_BASE_URL` | Private Anthropic gateway for the child `claude` process |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | Token for the child `claude` process |
| `CLAUDE_CONFIG_DIR` | Override `~/.claude` |
| `SWITCHBOARD_SKIN` | Skin name under `skins/<name>/` (default `switchboard`) |
| `SWITCHBOARD_BRANDING` | Absolute path to a skin directory or `branding.json` (overrides `SWITCHBOARD_SKIN`) |
| `SWITCHBOARD_ALLOW_NPM_INSTALL=1` | Bypass the preinstall guard to add a new dep |

## Prereqs

- Node.js 20+, npm 10+
- Native build tools: Xcode CLT (macOS), `build-essential python3` (Linux), VS Build Tools (Windows)

## Layout

```
main.js            Electron main process
preload.js         IPC bridge
db.js              SQLite cache + settings
path-guard.js      IPC file path whitelist
claude-cmd.js      Shell-escaped claude CLI command builder
mcp-bridge.js      Per-session localhost MCP WebSocket server
branding.js        Runtime branding loader
skins/<name>/      Branding assets (default: skins/switchboard/)
public/            Renderer (HTML/CSS/JS)
scripts/           Build helpers (preinstall guard, codesign, branding)
test/              node:test suites
```
