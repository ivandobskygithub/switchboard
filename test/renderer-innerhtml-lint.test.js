// Renderer XSS guardrail.
//
// Scans public/*.js for `innerHTML = …` and `insertAdjacentHTML(…, …)`
// assignments. Any line that interpolates a variable must also reference
// one of: escapeHtml, safeSetHtml, safeMarkdown, DOMPurify.
//
// Lines that assign a string literal (no `${…}` and no `+ var`) are fine:
// they are static templates we authored.
//
// This is intentionally conservative — false positives are easy to
// silence by adding the helper call; false negatives (real XSS) are
// what we're trying to prevent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SCAN_FILES = fs.readdirSync(PUBLIC_DIR)
  .filter(f => f.endsWith('.js') && f !== 'codemirror-bundle.js' && f !== 'codemirror-setup.js');

const SAFE_HELPERS = /\b(escapeHtml|safeSetHtml|safeMarkdown|DOMPurify)\b/;
// Calls of innerHTML / insertAdjacentHTML / outerHTML.
const RISK_RE = /\.(innerHTML|outerHTML)\s*=|\.insertAdjacentHTML\s*\(/;
// Has a JS interpolation (`${…}`) or string-concat with an identifier.
const HAS_INTERP_RE = /\$\{[^}]+\}|\+\s*[A-Za-z_$][\w$]*/;

function scanFile(file) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const lines = src.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RISK_RE.test(line)) continue;
    if (!HAS_INTERP_RE.test(line)) continue; // pure literal — safe
    if (SAFE_HELPERS.test(line)) continue;   // mitigation present on the same line
    // A few common false-positives we explicitly allow because the
    // interpolated value is a constant from a small literal set.
    // Add the line content here rather than blanket-suppressing.
    if (/innerHTML\s*=\s*ICONS\./.test(line)) continue;
    if (/innerHTML\s*=\s*spinnerIcon|playIcon|checkIcon|original|COPY_ICON|PREVIEW_ICON|WRAP_ICON|GOTO_LINE_ICON|SAVE_ICON|CLOSE_ICON/.test(line)) continue;
    offenders.push(`${file}:${i + 1}  ${line.trim()}`);
  }
  return offenders;
}

test('no public/*.js innerHTML site interpolates an unsanitised variable', () => {
  const all = [];
  for (const f of SCAN_FILES) all.push(...scanFile(f));
  assert.deepEqual(all, [], 'unsanitised innerHTML interpolations:\n' + all.join('\n'));
});
