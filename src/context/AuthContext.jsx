/**
 * src/context/AuthContext.jsx
 * ──────────────────────────────────────────────────────────────────────────────
 * Provides login/logout and token state to the entire app.
 * Token persists in localStorage across page refreshes.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React, { createContext, useContext, useState, useCallback } from 'react';
import { api, getToken, setToken, clearToken } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Initialise from localStorage so refreshing the page keeps you logged in.
  const [token, setTokenState] = useState(() => getToken());
  const [user,  setUser]       = useState(null);

  const login = useCallback(async (email, password, tenantSlug) => {
    const data = await api.login(email, password, tenantSlug);
    setToken(data.token);
    setTokenState(data.token);
    setUser({ role: data.role, tenantId: data.tenantId });
    return data;
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
