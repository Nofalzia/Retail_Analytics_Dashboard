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

// Emitted whenever an authenticated request comes back 401 — the auth provider
// listens for this and returns the user to the login screen (session expiry).
const notifyUnauthorized = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rad:unauthorized'));
  }
};

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
    if (res.status === 401) notifyUnauthorized();
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

  /** POST /api/alerts/run-detection — triggers Phase 3 detection engine */
  runDetection: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/api/alerts/run-detection${qs ? `?${qs}` : ''}`, { method: 'POST' });
  },

  /**
   * POST /api/upload — multipart file ingest (CSV/XLSX).
   * Uses XMLHttpRequest instead of fetch because fetch cannot report upload
   * byte progress. onProgress(percent) fires with real progress (0-100);
   * pipeline progress is tracked by polling getUploadStatus(jobId).
   */
  uploadFile: (storeId, file, onProgress) => {
    const token = getToken();
    const form  = new FormData();
    form.append('storeId', storeId);
    form.append('file', file);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/upload`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      // Real upload progress (unavailable on fetch). Safely a no-op where the
      // browser lacks XMLHttpRequestUploadEvents — callers should poll the job.
      if (onProgress && xhr.upload) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e && e.length > 0 && e.total > 0) {
            onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
          }
        });
      }

      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON body */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
        const err = new Error(body.message || 'Upload failed');
        err.status = xhr.status;
        err.data   = body;
        if (xhr.status === 401) notifyUnauthorized();
        reject(err);
      };
      xhr.onerror = () => {
        const err = new Error('Upload request failed');
        err.status = 0;
        err.data   = null;
        reject(err);
      };

      xhr.send(form);
    });
  },

  /** GET /api/upload/:jobId/status — poll an ingestion job's progress */
  getUploadStatus: (jobId) =>
    apiFetch(`/api/upload/${encodeURIComponent(jobId)}/status`),

  /** PATCH /api/alerts/:id/ack — acknowledge an alert (manager/owner only) */
  acknowledgeAlert: (id) =>
    apiFetch(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'PATCH' }),

  /** PATCH /api/alerts/:id/dismiss — dismiss an alert (manager/owner only) */
  dismissAlert: (id) =>
    apiFetch(`/api/alerts/${encodeURIComponent(id)}/dismiss`, { method: 'PATCH' }),

  /** GET /health — used by login screen to verify server is reachable */
  health: () => apiFetch('/health'),
};
