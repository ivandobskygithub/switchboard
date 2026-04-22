// Allowlist for setting keys the renderer can read / write / delete.
// Anything not matching the pattern is rejected, preventing the renderer
// from stomping internal keys if they are added later.

const SETTING_KEY_RE = /^(global|searchTitlesOnly|project:.+)$/;
const MAX_KEY_LENGTH = 4096;

function isAllowedSettingKey(key) {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  // Defence in depth: disallow NUL and control characters even though
  // the current regex wouldn't match them anyway.
  if (/[\x00-\x1f]/.test(key)) return false;
  return SETTING_KEY_RE.test(key);
}

module.exports = { isAllowedSettingKey, SETTING_KEY_RE, MAX_KEY_LENGTH };
