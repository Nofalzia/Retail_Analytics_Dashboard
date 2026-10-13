/**
 * src/context/AuthContext.jsx
 * ──────────────────────────────────────────────────────────────────────────────
 * Provides login/logout and token state to the entire app.
 * Token persists in localStorage across page refreshes.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { api, getToken, setToken, clearToken } from '../api/client.js';
import { findDemoTenantBySlug } from '../config/demoTenants.js';

const AuthContext = createContext(null);

/**
 * Hand-off key for the store switcher. The dropdown parks the tenant it wants
 * you to sign into here (sessionStorage, so it dies with the tab); the sign-in
 * screen reads it once, prefills the slug + email, then clears it. Passwords are
 * never written to storage.
 */
export const PENDING_TENANT_KEY = 'rad_pending_tenant';

/**
 * Pure read of the pending-tenant hand-off at provider mount. Module-private:
 * the value reaches the sign-in screen through the context.
 * @returns {{slug: string, email: string}|null} Pending tenant, or null.
 */
function readPendingTenant() {
  try {
    const raw = sessionStorage.getItem(PENDING_TENANT_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw);
    return pending && pending.slug && pending.email ? pending : null;
  } catch {
    return null;  // storage blocked or malformed hand-off — treat as nothing pending
  }
}

/** Drops the hand-off key once the sign-in screen has consumed it. */
function removePendingTenant() {
  try {
    sessionStorage.removeItem(PENDING_TENANT_KEY);
  } catch {
    /* Storage blocked — nothing to clean up. */
  }
}

/**
 * Reads the `storeId` claim out of the token we just stored, so the dashboards
 * can scope their queries to the account's own store (the id is generated per
 * tenant at seed time, so it cannot live in frontend config).
 * This is a convenience lookup, never an authorisation check: the server always
 * re-verifies the signature and derives identity from the token itself.
 * @param {string} token JWT returned by /api/auth/login.
 * @returns {string|null} Store UUID, or null when it cannot be read.
 */
function readStoreIdFromToken(token) {
  try {
    const base64 = String(token).split('.')[1];
    if (!base64) return null;
    const normalised = base64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    return typeof claims.storeId === 'string' ? claims.storeId : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  // Initialise from localStorage so refreshing the page keeps you logged in.
  const [token, setTokenState] = useState(() => getToken());
  const [user,  setUser]       = useState(null);
  // Tenant branding for the signed-in store (name / slug / brandAccent), taken
  // from the login response. React state only — nothing extra in localStorage.
  const [tenant, setTenant]    = useState(null);
  // Store-switcher hand-off: read once at mount, refreshed by switchTenant.
  const [pendingTenant, setPendingTenant] = useState(readPendingTenant);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Refs mirror mutable auth state so the event listener (registered once)
  // never reads a stale closure value.
  const tokenRef  = useRef(token);
  const busyRef   = useRef(false);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // A single global listener: any authenticated API call that returns 401
  // dispatches 'rad:unauthorized' (see api/client.js). We clear auth state and
  // flag the login screen to show the session-expiry notice. The busyRef guard
  // ensures many simultaneous 401s trigger exactly one logout, and only while
  // a token was actually present (a failed login's 401 must NOT fire this).
  useEffect(() => {
    const onUnauthorized = () => {
      if (busyRef.current || !tokenRef.current) return;
      busyRef.current = true;
      clearToken();
      setTokenState(null);
      setUser(null);
      setTenant(null);
      setSessionExpired(true);
    };

    window.addEventListener('rad:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rad:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (email, password, tenantSlug) => {
    const data = await api.login(email, password, tenantSlug);
    setToken(data.token);
    setTokenState(data.token);
    setUser({
      role:     data.role,
      tenantId: data.tenantId,
      email,
      storeId:  data.storeId ?? readStoreIdFromToken(data.token),
    });
    // The API returns the tenant it resolved (name / slug / brandAccent). Builds
    // that only return ids fall back to the local demo directory.
    const resolvedSlug = data?.tenant?.slug ?? tenantSlug;
    const knownTenant  = findDemoTenantBySlug(resolvedSlug);
    setTenant({
      name:        data?.tenant?.name ?? knownTenant?.label ?? resolvedSlug,
      slug:        resolvedSlug,
      brandAccent: data?.tenant?.brandAccent ?? null,
    });
    setSessionExpired(false);
    busyRef.current = false;
    return data;
  }, []);

  const logout = useCallback(() => {
    setTenant(null);
    clearToken();
    setTokenState(null);
    setUser(null);
    setSessionExpired(false);
    busyRef.current = false;
  }, []);

  /**
   * Hand the browser to another demo tenant: remember the pick in sessionStorage
   * (slug + email only) and sign out, so the login screen can prefill it.
   * @param {string} slug  Tenant slug to sign into next.
   * @param {string} email Owner email that exists for that tenant.
   */
  const switchTenant = useCallback((slug, email) => {
    const pending = { slug, email };
    try {
      sessionStorage.setItem(PENDING_TENANT_KEY, JSON.stringify(pending));
    } catch {
      /* Storage blocked — the login screen still receives it from this state. */
    }
    setPendingTenant(pending);
    logout();
  }, [logout]);

  /** Consumed by the sign-in screen once it has prefilled the fields. */
  const clearPendingTenant = useCallback(() => {
    setPendingTenant(null);
    removePendingTenant();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        tenant,
        pendingTenant,
        login,
        logout,
        switchTenant,
        clearPendingTenant,
        isAuthenticated: !!token,
        sessionExpired,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
