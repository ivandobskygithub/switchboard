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

function loadBranding() {
  const explicit = process.env.SWITCHBOARD_BRANDING;
  const skin = process.env.SWITCHBOARD_SKIN || 'switchboard';
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  candidates.push(path.join(__dirname, 'skins', skin, 'branding.json'));
  candidates.push(path.join(__dirname, 'skins', 'switchboard', 'branding.json'));

  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
  }
  console.error('[branding] no branding.json found; using inline defaults');
  return {
    productName: 'Switchboard',
    appId: 'local.switchboard',
    windowTitle: 'Switchboard',
    mcpIdeName: 'Switchboard',
    tmpFilePrefix: 'switchboard',
  };
}

module.exports = loadBranding();
