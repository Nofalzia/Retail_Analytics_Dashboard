/**
 * src/components/auth/LoginScreen.jsx
 * ──────────────────────────────────────────────────────────────────────────────
 * Login gate shown before the dashboard. Matches the warm Euro-Asian minimalist
 * design system — same palette, same typography, same card surface tokens.
 *
 * Demo credentials (pre-filled):
 *   Email      : owner@demo.com
 *   Password   : Demo@1234 (or VITE_DEMO_PASSWORD when the build sets one)
 *   Tenant slug: from src/config/demoTenants.js (default: demo-kiryana)
 *
 * With VITE_DEMO_MODE=true the card also offers "Quick sign-in" chips: one per
 * demo user of the store named in the slug field (labels + emails come from
 * src/config/demoTenants.js, the password from VITE_DEMO_PASSWORD).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { DEMO_TENANTS, findDemoTenantBySlug, findDemoUsersBySlug } from '../../config/demoTenants.js';

/** Store offered when no switch is pending — also the mock-preview tenant. */
const DEFAULT_TENANT = DEMO_TENANTS[0];

/**
 * Fallback prefill for the seeded demo store, so behaviour is unchanged when the
 * environment variable is not set. The quick sign-in chips never fall back to it:
 * they only ever use VITE_DEMO_PASSWORD.
 */
const LEGACY_DEMO_PASSWORD = 'Demo@1234';
const ENV_DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || '';
const PREFILL_PASSWORD = ENV_DEMO_PASSWORD || LEGACY_DEMO_PASSWORD;

/** Quick sign-in chips are opt-in per build — see .env.example. */
const SHOW_QUICK_SIGN_IN = import.meta.env.VITE_DEMO_MODE === 'true';

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
  bottleGreenSoftStrong: 'rgba(30, 54, 45, 0.14)',
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
  const { login, sessionExpired, pendingTenant, clearPendingTenant } = useAuth();

  // The store switcher parks its pick in sessionStorage and the auth provider
  // hands it to us here: when one is pending we prefill the slug + email and
  // leave the password blank for the user to type. The hand-off is cleared once,
  // in the effect below, so StrictMode's double render changes nothing.
  useEffect(() => clearPendingTenant(), [clearPendingTenant]);

  const [form, setForm] = useState({
    email:      pendingTenant ? pendingTenant.email : DEFAULT_TENANT.email,
    password:   pendingTenant ? '' : PREFILL_PASSWORD,
    tenantSlug: pendingTenant ? pendingTenant.slug : DEFAULT_TENANT.slug,
  });
  const [error,   setError]   = useState(
    sessionExpired ? 'Your session has expired. Please sign in again.' : null,
  );
  const [loading, setLoading] = useState(false);

  // Calm hand-off notice: name the store the switcher picked, if there was one.
  // Snapshotted, because clearing the hand-off turns the context value null on
  // the next render.
  const [pendingLabel] = useState(() =>
    pendingTenant ? (findDemoTenantBySlug(pendingTenant.slug)?.label ?? pendingTenant.slug) : null,
  );

  const set = (field) => (value) => setForm((prev) => ({ ...prev, [field]: value }));

  // Quick sign-in chips describe whichever demo store the slug field currently
  // names. An unknown slug simply offers no chips, and the whole block is hidden
  // unless the build turned demo mode on.
  const demoUsers = useMemo(
    () => (SHOW_QUICK_SIGN_IN ? findDemoUsersBySlug(form.tenantSlug.trim()) : []),
    [form.tenantSlug],
  );

  const submit = async (email, password, tenantSlug) => {
    setError(null);
    setLoading(true);
    try {
      await login(email, password, tenantSlug);
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

  const handleLogin = () => submit(form.email.trim(), form.password, form.tenantSlug.trim());

  /**
   * Quick sign-in chip: fill the store slug and that account's email, add the
   * demo password when the build provides one, and submit. Without
   * VITE_DEMO_PASSWORD only the email is filled — typing the password stays a
   * deliberate act, and no password is ever hardcoded here.
   * @param {import('../../config/demoTenants.js').DemoUser} entry Chip pressed.
   */
  const handleQuickSignIn = (entry) => {
    const tenantSlug = form.tenantSlug.trim() || DEFAULT_TENANT.slug;
    setForm({ email: entry.email, password: ENV_DEMO_PASSWORD, tenantSlug });
    setError(null);
    if (ENV_DEMO_PASSWORD) submit(entry.email, ENV_DEMO_PASSWORD, tenantSlug);
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

          {/* Hand-off notice from the store switcher — states which store the
              pending slug belongs to. Never reveals or prefills a password. */}
          {pendingLabel && (
            <p
              className="mt-5 rounded-xl px-4 py-3 text-sm"
              style={{
                backgroundColor: PALETTE.sand,
                color:            PALETTE.charcoal,
                border:           `1px solid ${PALETTE.sandBorder}`,
              }}
            >
              Sign in to {pendingLabel}.
            </p>
          )}

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

          {/* Quick sign-in — demo builds only. Labels and emails are tenant data
              (src/config/demoTenants.js); the password is never stored in code. */}
          {demoUsers.length > 0 && (
            <div
              className="mt-5 rounded-xl px-4 py-4"
              style={{ backgroundColor: PALETTE.sand, border: `1px solid ${PALETTE.sandBorder}` }}
            >
              <p
                className="text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: PALETTE.charcoalMuted }}
              >
                Quick sign-in
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {demoUsers.map((entry) => (
                  <button
                    key={entry.email}
                    type="button"
                    onClick={() => handleQuickSignIn(entry)}
                    disabled={loading}
                    className="rounded-lg px-3.5 py-2 text-xs font-medium transition-colors duration-150"
                    style={{
                      backgroundColor: PALETTE.bottleGreenSoft,
                      border:           `1px solid ${PALETTE.bottleGreenSoft}`,
                      color:            PALETTE.bottleGreen,
                      cursor:           loading ? 'not-allowed' : 'pointer',
                    }}
                    onMouseEnter={(e) => {
                      if (!loading) e.currentTarget.style.backgroundColor = PALETTE.bottleGreenSoftStrong;
                    }}
                    onMouseLeave={(e) => {
                      if (!loading) e.currentTarget.style.backgroundColor = PALETTE.bottleGreenSoft;
                    }}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              {!ENV_DEMO_PASSWORD && (
                <p className="mt-3 text-[11px]" style={{ color: PALETTE.charcoalMuted }}>
                  Enter the password to continue.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Demo hint */}
        <p className="mt-6 text-center text-xs" style={{ color: PALETTE.charcoalMuted }}>
          {pendingLabel
            ? 'Enter your password for this store to continue.'
            : 'Demo credentials are pre-filled above.'}
        </p>
      </div>
    </div>
  );
}
