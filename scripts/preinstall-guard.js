#!/usr/bin/env node
// Enforces reproducible installs for Switchboard corp builds.
// Blocks `npm install` unless SWITCHBOARD_ALLOW_NPM_INSTALL=1 is set.
// `npm ci` is always allowed and is the intended install path.

const cmd = process.env.npm_command || '';
const allow = process.env.SWITCHBOARD_ALLOW_NPM_INSTALL === '1';

if (cmd === 'install' && !allow) {
  console.error('');
  console.error('  Switchboard: direct `npm install` is blocked to keep the lockfile');
  console.error('  pinned. Use one of:');
  console.error('    - `npm ci`                       (reproducible install, matches lockfile)');
  console.error('    - `SWITCHBOARD_ALLOW_NPM_INSTALL=1 npm install <pkg>`  (to add a dep)');
  console.error('');
  process.exit(1);
}
