// Pure auth helpers for the per-session MCP WebSocket server.
// Extracted from mcp-bridge.js so we can unit-test them without
// spinning up a real ws server.

const crypto = require('crypto');

// MCP clients (the Claude CLI) never send an Origin header. Browsers always
// do. Rejecting any request that carries one mitigates DNS-rebind / browser
// pivot attacks against 127.0.0.1.
function originAllowed(headers) {
  if (!headers) return true;
  // Case-insensitive lookup — the ws library lowercases headers, but be
  // defensive in case this is called from somewhere that doesn't.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'origin' && headers[k]) return false;
  }
  return true;
}

// Constant-time token compare. Returns false on any length mismatch,
// missing value, or non-string input — never throws.
function tokenMatches(provided, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Full handshake check used on every incoming ws connection. Returns
// { ok: true } or { ok: false, code, reason } suitable for ws.close().
function validateHandshake(req, expectedToken) {
  const headers = req && req.headers ? req.headers : {};
  if (!originAllowed(headers)) {
    return { ok: false, code: 4003, reason: 'Origin not allowed' };
  }
  const provided = headers['x-claude-code-ide-authorization'] || '';
  if (!tokenMatches(provided, expectedToken)) {
    return { ok: false, code: 4001, reason: 'Unauthorized' };
  }
  return { ok: true };
}

module.exports = { originAllowed, tokenMatches, validateHandshake };
