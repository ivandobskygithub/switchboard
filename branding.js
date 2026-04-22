// Single source of truth for user-visible branding strings.
// Override at build time with SWITCHBOARD_BRANDING=/path/to/branding.json
// (must be an absolute path on disk) to produce a differently-branded build
// without touching code.
const fs = require('fs');
const path = require('path');

const DEFAULT = require('./branding.json');

function loadBranding() {
  const override = process.env.SWITCHBOARD_BRANDING;
  if (override) {
    try {
      const resolved = path.resolve(override);
      const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      return { ...DEFAULT, ...data, publish: { ...DEFAULT.publish, ...(data.publish || {}) } };
    } catch (e) {
      console.error('[branding] failed to load SWITCHBOARD_BRANDING override, using defaults:', e.message);
    }
  }
  return DEFAULT;
}

module.exports = loadBranding();
