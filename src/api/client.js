/**
 * src/api/client.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Thin API client. Every function reads the JWT from localStorage and attaches
 * it as a Bearer token — so route handlers never need to think about auth.
 *
 * VITE_API_URL defaults to http://localhost:3001 for local dev.
 * Set it to your Railway/Render URL in Vercel's environment variable settings.
 * ──────────────────────────────────────────────────────────────────────────────
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const TOKEN_KEY = 'rad_token';

export const getToken  = ()      => localStorage.getItem(TOKEN_KEY);
export const setToken  = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = ()     => localStorage.removeItem(TOKEN_KEY);

// ── Base fetch wrapper ────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const token = getToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    const err  = new Error(body.message || 'API request failed');
    err.status = res.status;
    err.data   = body;
    throw err;
  }

  return res.json();
}

// ── Public API surface ────────────────────────────────────────────────────────

export const api = {
  /** POST /api/auth/login → { token, role, tenantId } */
  login: (email, password, tenantSlug) =>
    apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, tenantSlug }),
    }),

  /** GET /api/overview — powers BusinessOwnerDashboard */
  getOverview: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/api/overview${qs ? `?${qs}` : ''}`);
  },

  /** GET /api/alerts — powers StoreManagerDashboard anomaly feed */
  getAlerts: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/api/alerts${qs ? `?${qs}` : ''}`);
  },

  /** GET /api/stockout — powers StockoutPrediction */
  getStockout: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/api/stockout${qs ? `?${qs}` : ''}`);
  },

  /** GET /health — used by login screen to verify server is reachable */
  health: () => apiFetch('/health'),
};
