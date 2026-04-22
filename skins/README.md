# Skins

A **skin** is a directory of branding assets. Each skin is self-contained and swappable at build time. The default skin lives at `skins/switchboard/` and is checked in. Any other skin directory is git-ignored by default (see the repo `.gitignore`), so you can keep a private branded skin in this tree without risk of committing it to a public fork.

## Anatomy of a skin

```
skins/<name>/
├── branding.json              required — runtime strings + build metadata
├── icon.png                   optional — 512x512 (Linux, generic)
├── icon.icns                  optional — macOS bundle icon
├── icon.ico                   optional — Windows installer icon
├── dmg-background.png         optional — 660x400 macOS DMG backdrop
├── dmg-background@2x.png      optional — 1320x800 retina version
└── entitlements.mac.plist     optional — overrides the default Mac entitlements
```

Any asset you omit falls through to whatever is already in `build/`. On every `npm run build*` invocation, `scripts/apply-branding.js` copies the skin's assets into `build/` before electron-builder runs.

## branding.json fields

```jsonc
{
  "productName": "Switchboard",        // shown in OS installer / dock / about
  "appId": "ai.doctly.switchboard",    // reverse-DNS bundle ID (macOS / Windows)
  "windowTitle": "Switchboard",        // BrowserWindow title at runtime
  "mcpIdeName": "Switchboard",         // advertised to Claude CLI via MCP handshake
  "tmpFilePrefix": "switchboard",      // os.tmpdir() prefix for scratch files

  // Optional — only set if you actually publish installers somewhere.
  // Omit entirely for purely internal builds.
  "publish": {
    "provider": "generic",
    "url": "https://internal.example.com/switchboard/"
  },

  // Optional — merged into electron-builder's per-platform config.
  // Use this to override hardened-runtime, notarize, target formats, etc.
  "mac":   { "notarize": false, "hardenedRuntime": true },
  "win":   { "target": [{ "target": "nsis", "arch": ["x64", "arm64"] }] },
  "linux": { "target": ["AppImage"] }
}
```

## Creating a new skin

Pick a short lowercase name for your skin (e.g. `internal`). Nothing under `skins/internal/` will be committed — the `.gitignore` only tracks `skins/switchboard/`.

```bash
# 1. Scaffold from the default.
cp -r skins/switchboard skins/internal

# 2. Edit the strings.
#    productName / appId / windowTitle / mcpIdeName / tmpFilePrefix
#    Omit the publish block unless you actually ship installers somewhere.
$EDITOR skins/internal/branding.json

# 3. Drop in your artwork. File sizes / formats must match the defaults.
#    icon.png               — 512x512 PNG
#    icon.icns              — macOS icon bundle (iconutil / png2icons)
#    icon.ico               — Windows icon bundle
#    dmg-background.png     — 660x400
#    dmg-background@2x.png  — 1320x800
cp ~/Design/brand/*.png   skins/internal/
cp ~/Design/brand/icon.icns skins/internal/
cp ~/Design/brand/icon.ico  skins/internal/

# 4. Build with the skin selected. Two equivalent ways:
SWITCHBOARD_SKIN=internal npm run build:mac
# or, pointing at an absolute path (useful if the skin lives outside this repo):
SWITCHBOARD_BRANDING=/Users/you/brand-skin npm run build:mac
```

Output lands in `dist/` under the branded product name.

## Regenerating `icon.icns` / `icon.ico` from a PNG

`scripts/generate-icons.js` uses `png2icons` to produce `.icns` and `.ico` from a single source PNG. Drop your source PNG in the skin dir named `icon-source.png` and run:

```bash
node scripts/generate-icons.js skins/<name>
```

(If that script doesn't currently accept a directory argument, open it and add one — it's ~30 lines.)

## Running an un-packaged skinned app for dev

Runtime strings respect `SWITCHBOARD_SKIN` too, so you can sanity-check without a full build:

```bash
SWITCHBOARD_SKIN=<name> npm start
```

Window title, MCP IDE name, and tmp-file prefix will use the skin's values. Icon changes only take effect in a packaged build.

## Label overrides (strings.json)

Drop `skins/<name>/strings.json` alongside `branding.json` to override UI labels. The file is a flat `{ key: "Label" }` map. Unset keys fall through to the hardcoded default in the renderer.

Example:

```json
{
  "sidebar_sessions": "Conversations",
  "sidebar_plans": "Briefs",
  "add_project_btn_title": "Onboard a repo"
}
```

In the renderer, any label you want to make overridable is wrapped:

```js
const label = (window.api.strings && window.api.strings.sidebar_sessions) || 'Sessions';
```

Most strings are still hardcoded — the scaffolding is in place but wrapping each one is opt-in. Grep the renderer for a string you want to swap, wrap it with the pattern above, then pick any key name and add it to your skin's `strings.json`.

The snapshot is read once during preload via a sync IPC (`branding:getStrings`). Changing `strings.json` requires restarting the app.

## CSS / colour theming

Brand colours, fonts, and CSS currently live in `public/style.css`. Skinning that layer is intentionally out of scope for `branding.json` — it's too invasive to diff-and-merge cleanly. Fork the CSS in your private skin layer and keep it alongside the skin dir, e.g. `skins/<name>/style.css`, then either:

- `cp skins/<name>/style.css public/style.css` before `npm run build*`, or
- extend `scripts/apply-branding.js` with a copy step (a 3-line addition).

## Verifying what the build picked up

After running apply-branding, you'll see lines like:

```
[apply-branding] skin directory  = /Users/you/repo/skins/<name>
[apply-branding] branding file   = /Users/you/repo/skins/<name>/branding.json
[apply-branding] appId           = com.example.switchboard
[apply-branding] productName     = ExampleBoard
[apply-branding] publish         = (none)
[apply-branding] copied to build/: icon.png, icon.icns, icon.ico, dmg-background.png, dmg-background@2x.png
[apply-branding] wrote .../electron-builder-config.json
```

If `copied to build/` is empty, your skin is inheriting all assets from the default — that's fine if intentional, a warning sign otherwise.
