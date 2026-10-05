/**
 * src/context/AuthContext.jsx
 * ──────────────────────────────────────────────────────────────────────────────
 * Provides login/logout and token state to the entire app.
 * Token persists in localStorage across page refreshes.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { api, getToken, setToken, clearToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Initialise from localStorage so refreshing the page keeps you logged in.
  const [token, setTokenState] = useState(() => getToken());
  const [user,  setUser]       = useState(null);
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
      setSessionExpired(true);
    };

    window.addEventListener('rad:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rad:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (email, password, tenantSlug) => {
    const data = await api.login(email, password, tenantSlug);
    setToken(data.token);
    setTokenState(data.token);
    setUser({ role: data.role, tenantId: data.tenantId, email });
    setSessionExpired(false);
    busyRef.current = false;
    return data;
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUser(null);
    setSessionExpired(false);
    busyRef.current = false;
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, login, logout, isAuthenticated: !!token, sessionExpired }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
