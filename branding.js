// Runtime branding loader.
//
// Resolution order:
//   1. $SWITCHBOARD_BRANDING — absolute path to a branding.json file
//      (skins/<name>/branding.json, or anywhere out-of-tree)
//   2. $SWITCHBOARD_SKIN — a skin name under skins/<name>/
//   3. skins/switchboard/branding.json (the default)
//
// Used by main.js and mcp-bridge.js for window title, MCP IDE name,
// temp-file prefix. Build-time config generation is a separate concern
// handled by scripts/apply-branding.js.

const fs = require('fs');
const path = require('path');

const INLINE_DEFAULT = {
  productName: 'Switchboard',
  appId: 'local.switchboard',
  windowTitle: 'Switchboard',
  mcpIdeName: 'Switchboard',
  tmpFilePrefix: 'switchboard',
};

// Returns { brandingFile, skinDir }. brandingFile may be null if nothing
// was found — caller falls back to inline defaults.
function resolveSkinDir() {
  const explicit = process.env.SWITCHBOARD_BRANDING;
  if (explicit) {
    const abs = path.resolve(explicit);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) return { brandingFile: abs, skinDir: path.dirname(abs) };
      const brandingFile = path.join(abs, 'branding.json');
      if (fs.existsSync(brandingFile)) return { brandingFile, skinDir: abs };
    } catch {}
  }
  const skinName = process.env.SWITCHBOARD_SKIN || 'switchboard';
  const skinDir = path.join(__dirname, 'skins', skinName);
  const brandingFile = path.join(skinDir, 'branding.json');
  if (fs.existsSync(brandingFile)) return { brandingFile, skinDir };
  return { brandingFile: null, skinDir: null };
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadBranding() {
  const { brandingFile, skinDir } = resolveSkinDir();
  const branding = (brandingFile && loadJson(brandingFile)) || INLINE_DEFAULT;

  // Strings overlay: optional skins/<name>/strings.json keyed by label id.
  // Strip the _comment key (documentation marker only). A missing file
  // yields an empty object, which the UI treats as "use defaults".
  let strings = {};
  if (skinDir) {
    const s = loadJson(path.join(skinDir, 'strings.json'));
    if (s && typeof s === 'object') {
      strings = { ...s };
      delete strings._comment;
    }
  }
  return { ...INLINE_DEFAULT, ...branding, strings };
}

module.exports = loadBranding();
module.exports._loadBranding = loadBranding; // exposed for tests
