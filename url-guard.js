// Safe-URL check for shell.openExternal().
// Accepts only http:// and https:// (never file://, data:, javascript:,
// vscode://, or any registered custom scheme that could be abused on
// Windows to launch arbitrary apps).

const MAX_URL_LENGTH = 2048;

function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false;
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  // Reject anything that looks like a CR/LF / NUL injection.
  if (/[\x00-\x1f]/.test(url)) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Reject credentials in the URL — these get passed through to a browser
  // and can be used for phishing.
  if (parsed.username || parsed.password) return false;
  return true;
}

module.exports = { isSafeExternalUrl, MAX_URL_LENGTH };
