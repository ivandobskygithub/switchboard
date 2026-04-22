#!/usr/bin/env node
// Ad-hoc codesign the built .app bundle so macOS Gatekeeper doesn't
// block an unsigned binary on first launch. Replaces the old inline
//   codesign --sign - --force --deep dist/mac-arm64/Switchboard.app
// which hardcoded the product name.
//
// Uses execFileSync so paths with spaces/quotes are handled safely.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const root = path.join(__dirname, '..');
const branding = require(path.join(root, 'branding'));
const appName = `${branding.productName}.app`;

const distDir = path.join(root, 'dist');
if (!fs.existsSync(distDir)) process.exit(0);

const archDirs = fs.readdirSync(distDir).filter(d => d.startsWith('mac'));
for (const archDir of archDirs) {
  const appPath = path.join(distDir, archDir, appName);
  if (!fs.existsSync(appPath)) continue;
  try {
    execFileSync('codesign', ['--sign', '-', '--force', '--deep', appPath], { stdio: 'inherit', timeout: 120_000 });
    console.log(`[codesign-app] signed ${appPath}`);
  } catch (e) {
    console.error(`[codesign-app] failed for ${appPath}: ${e.message}`);
  }
}
