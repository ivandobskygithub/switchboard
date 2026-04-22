#!/usr/bin/env node
// Resolves the active skin, writes electron-builder-config.json, and
// copies the skin's icon / DMG-background assets into build/ so
// electron-builder picks them up.
//
// Skin resolution (first match wins):
//   1. $SWITCHBOARD_BRANDING — absolute path to a skin directory
//      (must contain branding.json; optionally icon.{png,icns,ico},
//      dmg-background.png, dmg-background@2x.png, entitlements.mac.plist)
//   2. $SWITCHBOARD_SKIN — skin name under ./skins/<name>/
//   3. ./skins/switchboard/ (default)
//
// The generated electron-builder-config.json is gitignored so each
// build is reproducible from the active skin.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');

function resolveSkin() {
  const explicit = process.env.SWITCHBOARD_BRANDING;
  if (explicit) {
    const abs = path.resolve(explicit);
    // Accept either a skin directory OR a plain branding.json file.
    const stat = fs.statSync(abs);
    if (stat.isFile()) return { dir: path.dirname(abs), branding: abs };
    return { dir: abs, branding: path.join(abs, 'branding.json') };
  }
  const name = process.env.SWITCHBOARD_SKIN || 'switchboard';
  const dir = path.join(root, 'skins', name);
  return { dir, branding: path.join(dir, 'branding.json') };
}

function copyIfExists(src, dest) {
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      return true;
    }
  } catch {}
  return false;
}

const { dir: skinDir, branding: brandingFile } = resolveSkin();
const branding = JSON.parse(fs.readFileSync(brandingFile, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// ── Copy skin assets into build/ so electron-builder finds them ─────
fs.mkdirSync(buildDir, { recursive: true });
const copiedAssets = [];
for (const name of ['icon.png', 'icon.icns', 'icon.ico', 'dmg-background.png', 'dmg-background@2x.png', 'entitlements.mac.plist']) {
  if (copyIfExists(path.join(skinDir, name), path.join(buildDir, name))) {
    copiedAssets.push(name);
  }
}

// ── Generate electron-builder-config.json ───────────────────────────
const build = JSON.parse(JSON.stringify(pkg.build || {}));
build.appId = branding.appId;
build.productName = branding.productName;
if (branding.publish) {
  build.publish = { ...branding.publish };
} else {
  delete build.publish;
}
if (branding.mac) build.mac = { ...(build.mac || {}), ...branding.mac };
if (branding.win) build.win = { ...(build.win || {}), ...branding.win };
if (branding.linux) build.linux = { ...(build.linux || {}), ...branding.linux };

const outPath = path.join(root, 'electron-builder-config.json');
fs.writeFileSync(outPath, JSON.stringify(build, null, 2) + '\n', 'utf8');

console.log(`[apply-branding] skin directory  = ${skinDir}`);
console.log(`[apply-branding] branding file   = ${brandingFile}`);
console.log(`[apply-branding] appId           = ${build.appId}`);
console.log(`[apply-branding] productName     = ${build.productName}`);
console.log(`[apply-branding] publish         = ${build.publish ? JSON.stringify(build.publish) : '(none)'}`);
console.log(`[apply-branding] copied to build/: ${copiedAssets.join(', ') || '(none — defaults retained)'}`);
console.log(`[apply-branding] wrote ${outPath}`);
