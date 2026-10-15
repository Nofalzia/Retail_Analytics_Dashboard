/**
 * src/utils/tokenClaims.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Reads the *routing* claims out of the JWT the client already holds.
 *
 * The token is the only auth state that survives a page refresh — the user
 * object lives in React state — so the shell has to know the account's role and
 * store without a round trip. This is a convenience read for routing and display
 * only: the server re-verifies the signature on every request and derives
 * identity from the token itself, so a tampered claim can change what this
 * browser renders and nothing more.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Decodes a JWT payload without verifying it.
 * @param {string|null|undefined} token Raw JWT as stored by api/client.js.
 * @returns {{role: string|null, storeId: string|null, tenantId: string|null}|null}
 *   The claims this app routes on, or null when the token is missing/unreadable.
 */
export function readTokenClaims(token) {
  try {
    const base64 = String(token ?? '').split('.')[1];
    if (!base64) return null;

    // JWT uses base64url; atob wants plain base64 with padding.
    const normalised = base64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    if (!claims || typeof claims !== 'object') return null;

    return {
      role:     typeof claims.role === 'string' ? claims.role : null,
      storeId:  typeof claims.storeId === 'string' ? claims.storeId : null,
      tenantId: typeof claims.tenantId === 'string' ? claims.tenantId : null,
    };
  } catch {
    return null; // Malformed or truncated token — the API remains the judge.
  }
}

export default readTokenClaims;
