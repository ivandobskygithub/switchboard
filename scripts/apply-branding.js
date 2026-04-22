#!/usr/bin/env node
// Generates electron-builder-config.json by taking the `build` block from
// package.json and overlaying branding fields from branding.json (or the
// override JSON pointed at by $SWITCHBOARD_BRANDING).
//
// Run automatically as a prebuild step (see package.json scripts.build*).
// The generated file is .gitignored so branded forks just set
// SWITCHBOARD_BRANDING=/path/to/their-branding.json and rebuild.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const brandingPath = process.env.SWITCHBOARD_BRANDING
  ? path.resolve(process.env.SWITCHBOARD_BRANDING)
  : path.join(root, 'branding.json');
const branding = JSON.parse(fs.readFileSync(brandingPath, 'utf8'));

const build = JSON.parse(JSON.stringify(pkg.build || {}));
build.appId = branding.appId;
build.productName = branding.productName;
if (branding.publish) {
  // Replace wholesale so switching providers (github → generic) doesn't
  // leave stale owner/repo fields that confuse electron-builder.
  build.publish = { ...branding.publish };
}

const outPath = path.join(root, 'electron-builder-config.json');
fs.writeFileSync(outPath, JSON.stringify(build, null, 2) + '\n', 'utf8');
console.log(`[apply-branding] wrote ${outPath}`);
console.log(`[apply-branding]   appId        = ${build.appId}`);
console.log(`[apply-branding]   productName  = ${build.productName}`);
console.log(`[apply-branding]   publish.repo = ${build.publish?.repo || '(none)'}`);
