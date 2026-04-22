const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { windowsToWslPath, isWslShell, shellArgs } = require('../shell-profiles');

// ── windowsToWslPath ─────────────────────────────────────────────────

test('windowsToWslPath converts a drive-letter path', () => {
  assert.equal(windowsToWslPath('C:\\Users\\foo'), '/mnt/c/Users/foo');
  assert.equal(windowsToWslPath('D:\\proj\\app'), '/mnt/d/proj/app');
});

test('windowsToWslPath lowercases the drive letter', () => {
  assert.equal(windowsToWslPath('E:\\work'), '/mnt/e/work');
});

test('windowsToWslPath passes through non-drive paths unchanged (after slash normalization)', () => {
  assert.equal(windowsToWslPath('/already/posix'), '/already/posix');
});

test('windowsToWslPath returns falsy input untouched', () => {
  assert.equal(windowsToWslPath(null), null);
  assert.equal(windowsToWslPath(undefined), undefined);
  assert.equal(windowsToWslPath(''), '');
});

// ── isWslShell ───────────────────────────────────────────────────────

test('isWslShell matches both wsl.exe and wsl', () => {
  assert.equal(isWslShell('C:\\Windows\\System32\\wsl.exe'), true);
  assert.equal(isWslShell('wsl.exe'), true);
  assert.equal(isWslShell('/usr/bin/wsl'), true);
  assert.equal(isWslShell('/usr/bin/bash'), false);
  assert.equal(isWslShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), false);
});

test('isWslShell is case-insensitive on the basename', () => {
  assert.equal(isWslShell('WSL.EXE'), true);
  assert.equal(isWslShell('C:\\Windows\\System32\\Wsl.exe'), true);
});

// ── shellArgs ────────────────────────────────────────────────────────

test('shellArgs: bash with command uses -l -i -c', () => {
  assert.deepEqual(shellArgs('/bin/bash', 'echo hi'), ['-l', '-i', '-c', 'echo hi']);
});

test('shellArgs: zsh with command uses -l -i -c', () => {
  assert.deepEqual(shellArgs('/bin/zsh', 'claude'), ['-l', '-i', '-c', 'claude']);
});

test('shellArgs: bash without command uses -l -i', () => {
  assert.deepEqual(shellArgs('/bin/bash', undefined), ['-l', '-i']);
});

test('shellArgs: fish with command uses -l -c', () => {
  assert.deepEqual(shellArgs('/usr/bin/fish', 'echo hi'), ['-l', '-c', 'echo hi']);
});

test('shellArgs: powershell with command uses -NoLogo -Command', () => {
  assert.deepEqual(shellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'Get-ChildItem'), ['-NoLogo', '-Command', 'Get-ChildItem']);
});

test('shellArgs: powershell without command uses -NoLogo -NoExit', () => {
  assert.deepEqual(shellArgs('pwsh.exe', undefined), ['-NoLogo', '-NoExit']);
});

test('shellArgs: cmd-like shell falls back to /C', () => {
  assert.deepEqual(shellArgs('cmd.exe', 'dir'), ['/C', 'dir']);
});

test('shellArgs: WSL wraps the command in -- bash -l -i -c', () => {
  const args = shellArgs('wsl.exe', 'claude', ['-d', 'Ubuntu']);
  assert.deepEqual(args, ['-d', 'Ubuntu', '--', 'bash', '-l', '-i', '-c', 'claude']);
});

test('shellArgs: WSL without cmd opens interactive bash', () => {
  const args = shellArgs('wsl.exe', undefined, ['-d', 'Ubuntu']);
  assert.deepEqual(args, ['-d', 'Ubuntu', '--', 'bash', '-l', '-i']);
});

// ── discoverShellProfiles WSL distro regex (documented in-code) ──────
// The profile list includes wsl:<distro> ids. We validate the distro
// name regex by re-declaring it here so a regex widening requires a
// corresponding test update.

test('WSL distro name regex rejects metacharacters', () => {
  const distroRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const bad = ['', ' ', '$(evil)', 'Ubuntu; rm', '..', '.evil', '`x`', 'a\0b'];
  for (const d of bad) assert.equal(distroRe.test(d), false, `expected reject for ${JSON.stringify(d)}`);
  const good = ['Ubuntu', 'Ubuntu-22.04', 'kali_linux', 'Debian12'];
  for (const d of good) assert.equal(distroRe.test(d), true, `expected accept for ${JSON.stringify(d)}`);
});
