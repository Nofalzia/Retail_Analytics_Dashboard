/**
 * src/components/auth/LoginScreen.jsx
 * ──────────────────────────────────────────────────────────────────────────────
 * Login gate shown before the dashboard. Matches the warm Euro-Asian minimalist
 * design system — same palette, same typography, same card surface tokens.
 *
 * Demo credentials (pre-filled):
 *   Email      : owner@demo.com
 *   Password   : Demo@1234
 *   Tenant slug: demo-kiryana
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';

// ── Design tokens (kept local — no DashboardShell dependency at login time) ──

const PALETTE = {
  cream:           '#FAF7F1',
  sand:            '#F3EDE4',
  sandBorder:      'rgba(36, 31, 26, 0.07)',
  charcoal:        '#241F1A',
  charcoalMuted:   '#57534E',
  bottleGreen:     '#1E362D',
  bottleGreenHover:'#294A3D',
  bottleGreenSoft: 'rgba(30, 54, 45, 0.08)',
  terracottaSoft:  'rgba(190, 106, 75, 0.10)',
  terracotta:      '#BE6A4B',
};

const CARD_SURFACE = {
  backgroundColor: '#FFFFFF',
  border:          '1px solid rgba(120, 113, 104, 0.24)',
  boxShadow:       '0 2px 8px -3px rgba(0,0,0,0.05), 0 8px 24px -4px rgba(0,0,0,0.03)',
};

// ── Input field ───────────────────────────────────────────────────────────────

function Field({ label, type = 'text', value, onChange, placeholder, autoComplete }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: PALETTE.charcoalMuted }}
      >
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full rounded-xl px-4 py-3 text-sm outline-none transition-all duration-150"
        style={{
          backgroundColor: PALETTE.sand,
          border:           `1px solid ${PALETTE.sandBorder}`,
          color:            PALETTE.charcoal,
        }}
        onFocus={(e) => {
          e.currentTarget.style.border = `1px solid rgba(30, 54, 45, 0.4)`;
          e.currentTarget.style.boxShadow = `0 0 0 3px rgba(30, 54, 45, 0.06)`;
        }}
        onBlur={(e) => {
          e.currentTarget.style.border = `1px solid ${PALETTE.sandBorder}`;
          e.currentTarget.style.boxShadow = 'none';
        }}
      />
    </div>
  );
}

// ── Store logo mark ───────────────────────────────────────────────────────────

function StoreMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 9.5 5.2 4.5h13.6L20 9.5" />
      <path d="M4.5 9.5v9.5A1 1 0 0 0 5.5 20h13a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 20v-5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V20" />
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function LoginScreen() {
  const { login } = useAuth();

  const [form, setForm] = useState({
    email:      'owner@demo.com',
    password:   'Demo@1234',
    tenantSlug: 'demo-kiryana',
  });
  const [error,   setError]   = useState(null);
  const [loading, setLoading] = useState(false);

  const set = (field) => (value) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await login(form.email.trim(), form.password, form.tenantSlug.trim());
    } catch (err) {
      setError(
        err.status === 401
          ? 'Incorrect email or password. Check your credentials and try again.'
          : err.data?.message || 'Could not connect to the server. Make sure the API is running.',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleLogin();
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center p-4"
      style={{ backgroundColor: PALETTE.cream }}
    >
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="mb-8 flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl"
            style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
          >
            <StoreMark />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
              Retail Analytics
            </p>
            <p className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
              Store Intelligence Platform
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl p-8" style={CARD_SURFACE}>
          <h1 className="text-xl font-semibold" style={{ color: PALETTE.charcoal }}>
            Welcome back
          </h1>
          <p className="mt-1 text-sm" style={{ color: PALETTE.charcoalMuted }}>
            Sign in to your store dashboard.
          </p>

          <div className="mt-8 flex flex-col gap-5" onKeyDown={handleKeyDown}>
            <Field
              label="Email"
              type="email"
              value={form.email}
              onChange={set('email')}
              placeholder="owner@yourstore.com"
              autoComplete="email"
            />
            <Field
              label="Password"
              type="password"
              value={form.password}
              onChange={set('password')}
              placeholder="••••••••"
              autoComplete="current-password"
            />
            <Field
              label="Store Slug"
              value={form.tenantSlug}
              onChange={set('tenantSlug')}
              placeholder="your-store-slug"
              autoComplete="organization"
            />
          </div>

          {/* Error */}
          {error && (
            <div
              className="mt-5 rounded-xl px-4 py-3 text-sm"
              style={{
                backgroundColor: PALETTE.terracottaSoft,
                color: PALETTE.charcoal,
                border: `1px solid rgba(190, 106, 75, 0.20)`,
              }}
            >
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="button"
            onClick={handleLogin}
            disabled={loading}
            className="mt-6 w-full rounded-xl py-3 text-sm font-semibold transition-colors duration-150"
            style={{
              backgroundColor: loading ? PALETTE.charcoalMuted : PALETTE.bottleGreen,
              color: PALETTE.cream,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => {
              if (!loading) e.currentTarget.style.backgroundColor = PALETTE.bottleGreenHover;
            }}
            onMouseLeave={(e) => {
              if (!loading) e.currentTarget.style.backgroundColor = PALETTE.bottleGreen;
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </div>

        {/* Demo hint */}
        <p className="mt-6 text-center text-xs" style={{ color: PALETTE.charcoalMuted }}>
          Demo credentials are pre-filled above.
        </p>
      </div>
    </div>
  );
}
