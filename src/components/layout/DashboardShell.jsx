import React, { useState, useRef, useEffect } from 'react';
import { useTheme, useDesignTokens } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { DEMO_TENANTS, PRIMARY_DEMO_SLUG } from '../../config/demoTenants';

/**
 * ============================================================================
 * DashboardShell  —  Global layout shell & design tokens with theme support
 * ============================================================================
 */



// Design tokens (PALETTE, CARD_SURFACE, EARTH, SERIES, ACCENTS, RADII, …) live
// in src/context/ThemeContext.jsx and are theme-aware. Components must read
// them through useDesignTokens(); no light-only copies are exported from here.

/** Local commercial currency — returns prefix + formatted value for typographic hierarchy */
export const formatLocalCurrency = (amount) => ({
  prefix: 'Rs.',
  value: Math.round(amount).toLocaleString('en-PK'),
});

/**
 * Short form of the same currency, for chart axis ticks — so an axis label and
 * a card figure never spell the same amount two different ways (it used to
 * print "Rs. 3.5L" on the axis and "Rs. 3,518,000" on the card).
 * @param {number} amount Raw value.
 * @returns {string} e.g. 'Rs. 4.22M', 'Rs. 214K', 'Rs. 950'.
 */
export const formatCompactCurrency = (amount) => {
  const value = Number(amount) || 0;
  if (Math.abs(value) >= 1_000_000) return `Rs. ${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `Rs. ${Math.round(value / 1_000)}K`;
  return `Rs. ${Math.round(value)}`;
};

// ----------------------------------------------------------------------------
// Navigation & role configuration — the single source of truth
// ----------------------------------------------------------------------------

export const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', Icon: (p) => <OverviewIcon {...p} /> },
  { id: 'deep-analytics', label: 'Deep Analytics', Icon: (p) => <AnalyticsIcon {...p} /> },
  { id: 'stockout-prediction', label: 'Stockout Watch', Icon: (p) => <StockoutIcon {...p} /> },
  { id: 'recommendations', label: 'Recommendations', Icon: (p) => <RecommendationsIcon {...p} /> },
  { id: 'data-ingestion', label: 'Data Ingestion', Icon: (p) => <IngestionIcon {...p} /> },
];

// Roles offered by the header preview switcher. 'System Administrator' is
// deliberately absent: it is a backend/platform role that never sees storefront
// financial data, so it is not something a user previews (T9).
export const ROLES = ['Owner', 'Manager'];

// ----------------------------------------------------------------------------
// Tenant helpers — store identity is data, so it only ever arrives as props
// ----------------------------------------------------------------------------

/**
 * True when a tenant accent is a real hex colour worth applying. Anything else
 * (null, '', 'brand-blue') falls back to the shared token palette.
 * @param {unknown} value Candidate accent from the tenant record.
 * @returns {boolean}
 */
const isHexColor = (value) =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());

/**
 * WCAG relative luminance of a hex colour.
 * @param {string} hex '#rgb' or '#rrggbb'.
 * @returns {number} Luminance in 0..1.
 */
const relativeLuminance = (hex) => {
  const digits = hex.trim().replace('#', '');
  const full   = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits;
  const linear = (channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const [r, g, b] = [0, 2, 4].map((i) => linear(parseInt(full.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two luminances (order-independent). */
const contrastRatio = (a, b) => {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Picks the ink that stays legible on an arbitrary tenant accent: it measures
 * both of the theme's ink tokens against the accent and keeps the better one.
 * The old rule returned `cream` for every dark accent, which in dark mode is
 * near-black — so a dark brand colour rendered black-on-black nav pills.
 * @param {string} accent Valid hex colour.
 * @param {Record<string, string>} PALETTE Active design tokens.
 * @returns {string} Ink colour with the higher contrast ratio.
 */
const readableInkOn = (accent, PALETTE) => {
  const accentLuminance = relativeLuminance(accent);
  const onCream     = contrastRatio(accentLuminance, relativeLuminance(PALETTE.cream));
  const onCharcoal  = contrastRatio(accentLuminance, relativeLuminance(PALETTE.charcoal));
  return onCream >= onCharcoal ? PALETTE.cream : PALETTE.charcoal;
};

/**
 * The mocked preview states (Healthy / Struggling / No data) were written
 * against the seeded demo store only, so every other tenant is always live.
 * @param {{slug?: string}|null} tenant Signed-in tenant.
 * @returns {boolean}
 */
const isPrimaryDemoTenant = (tenant) => !tenant || tenant.slug === PRIMARY_DEMO_SLUG;

/**
 * True for the seeded demo stores only. The "Switch store" list is demo
 * tooling, so a real tenant must never see the other tenants' names (or be
 * offered a route into them).
 * @param {{slug?: string}|null} tenant Signed-in tenant.
 * @returns {boolean}
 */
const isDemoTenant = (tenant) =>
  Boolean(tenant?.slug) && DEMO_TENANTS.some((entry) => entry.slug === tenant.slug);

// ----------------------------------------------------------------------------
// View routing — the active view also lives in the URL hash, so a refresh or a
// shared link lands on the same view and the browser Back button works. No
// router dependency: the shell owns five views and history.pushState is enough.
// ----------------------------------------------------------------------------

const VIEW_IDS = NAV_ITEMS.map((item) => item.id);

/**
 * Reads `#/view-id` from the URL.
 * @returns {string|null} A known view id, or null when the hash is absent/unknown.
 */
const readViewFromHash = () => {
  if (typeof window === 'undefined') return null;
  const candidate = window.location.hash.replace(/^#\/?/, '').trim();
  return VIEW_IDS.includes(candidate) ? candidate : null;
};

// ----------------------------------------------------------------------------
// Icon primitives (hand-rolled, consistent 1.5px stroke — no icon packages)
// ----------------------------------------------------------------------------

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

function OverviewIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function AnalyticsIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 15v-4" />
      <path d="M12.5 15V7" />
      <path d="M17 15v-6.5" />
    </svg>
  );
}

function IngestionIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 17.5v1.5A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
    </svg>
  );
}

function StockoutIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <path d="M4 20V10.5L12 5l8 5.5V20" />
      <path d="M9 20v-6h6v6" />
      <path d="M9.5 14.5h5" />
    </svg>
  );
}

function RecommendationsIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <path d="M4 6h13" />
      <path d="M4 12h9" />
      <path d="M4 18h6" />
      <path d="M16 15l3 3 5-5" />
    </svg>
  );
}

function StoreMarkIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <path d="M4 9.5 5.2 4.5h13.6L20 9.5" />
      <path d="M4.5 9.5v9.5A1 1 0 0 0 5.5 20h13a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 20v-5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V20" />
    </svg>
  );
}

function ChevronDownIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <path d="M6 9.5 12 15l6-5.5" />
    </svg>
  );
}

function CheckIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <path d="M5 12.5 9.5 17 19 6.5" />
    </svg>
  );
}

function SunIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v6M12 17v6M23 12h-6M7 12H1M20.485 3.515 16.97 7.03M7.03 16.97 3.515 20.485M20.485 20.485 16.97 16.97M7.03 7.03 3.515 3.515" />
    </svg>
  );
}

function MoonIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

// ----------------------------------------------------------------------------
// Sidebar (desktop, persistent)
// ----------------------------------------------------------------------------

const SidebarNavLink = ({ item, isActive, onSelect, accent = null, accentInk = null }) => {
  const { label, Icon } = item;
  const { PALETTE } = useDesignTokens();

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={isActive ? 'page' : undefined}
      className="group flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors duration-150"
      style={
        isActive
          ? { backgroundColor: accent ?? PALETTE.bottleGreen, color: accentInk ?? PALETTE.cream }
          : { color: PALETTE.charcoalMuted }
      }
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = PALETTE.sand;
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <Icon className="h-4.5 w-4.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
};

const Sidebar = ({ activeView, onSelect, tenant = null }) => {
  const { theme } = useTheme();
  const { PALETTE } = useDesignTokens();
  const { logout } = useAuth();

  // Tenant branding: the accent is applied to the logo mark and the active nav
  // pill only, and only when it is a real hex colour. Everything else keeps the
  // shared token palette.
  const accent    = isHexColor(tenant?.brandAccent) ? tenant.brandAccent.trim() : null;
  const accentInk = accent ? readableInkOn(accent, PALETTE) : PALETTE.cream;

  return (
    <aside
      className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:w-64 lg:flex-col"
      style={{
        backgroundColor: theme.surface,
        borderRight: `1px solid ${theme.sandBorder}`,
        boxShadow: theme.sidebarShadow,
      }}
    >
      <div className="flex items-center gap-3 px-6 py-6">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ backgroundColor: accent ?? PALETTE.bottleGreen, color: accentInk }}
        >
          <StoreMarkIcon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 leading-tight">
          {/* Signed in → the store's own name heads the sidebar, with the
              platform name kept as a small caption beneath it. */}
          <p className="truncate text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
            {tenant?.name ?? 'Retail Analytics'}
          </p>
          <p className="truncate text-xs" style={{ color: PALETTE.charcoalMuted }}>
            {tenant ? 'Retail Analytics' : 'Store Intelligence'}
          </p>
        </div>
      </div>

      <div className="mx-6 h-px" style={{ backgroundColor: theme.sandBorder }} />

      <nav className="flex-1 space-y-1 px-4 py-6" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <SidebarNavLink
            key={item.id}
            item={item}
            isActive={activeView === item.id}
            onSelect={onSelect}
            accent={accent}
            accentInk={accentInk}
          />
        ))}
      </nav>

      <div className="px-6 py-6">
        {/* One control: "Sign out" and "Switch user" were two buttons wired to
            the same handler, which read as a choice that did not exist. */}
        <div className="mb-3">
          <button
            type="button"
            onClick={logout}
            className="rounded-lg px-1 py-1 text-left text-xs font-medium transition-colors duration-150"
            style={{ color: PALETTE.charcoalMuted }}
            onMouseEnter={(e) => { e.currentTarget.style.color = PALETTE.charcoal; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = PALETTE.charcoalMuted; }}
          >
            Sign out
          </button>
        </div>
        <div
          className="rounded-xl p-4"
          style={{
            backgroundColor: theme.panelBg,
            border: `1px solid ${theme.panelBorder}`,
            boxShadow: theme.panelShadow,
          }}
        >
          <p className="text-xs leading-relaxed" style={{ color: PALETTE.charcoalMuted }}>
            Data shown is scoped to your connected store.
          </p>
        </div>
      </div>
    </aside>
  );
};

// ----------------------------------------------------------------------------
// Bottom navigation dock (mobile only)
// ----------------------------------------------------------------------------

const DockNavLink = ({ item, isActive, onSelect }) => {
  const { label, Icon } = item;
  const { PALETTE } = useDesignTokens();

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={isActive ? 'page' : undefined}
      className="flex flex-1 flex-col items-center gap-1 py-2.5"
      style={{ color: isActive ? PALETTE.bottleGreen : PALETTE.charcoalMuted }}
    >
      <span
        className="flex h-8 w-10 items-center justify-center rounded-full transition-colors duration-200"
        style={{ backgroundColor: isActive ? PALETTE.bottleGreenSoft : 'transparent' }}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className={`text-[11px] ${isActive ? 'font-semibold' : 'font-medium'}`}>{label}</span>
    </button>
  );
};

const BottomDock = ({ activeView, onSelect }) => {
  const { theme } = useTheme();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 flex lg:hidden"
      style={{
        backgroundColor: theme.dockBg,
        borderTop: `1px solid ${theme.sandBorder}`,
        boxShadow: theme.headerShadow,
        backdropFilter: 'blur(10px)',
      }}
      aria-label="Primary"
    >
      {NAV_ITEMS.map((item) => (
        <DockNavLink
          key={item.id}
          item={item}
          isActive={activeView === item.id}
          onSelect={onSelect}
        />
      ))}
    </nav>
  );
};

// ----------------------------------------------------------------------------
// Role switcher
// ----------------------------------------------------------------------------

const RoleSwitcher = ({ activeRole, onSelect }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();

  // Close on outside click.
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    // Escape closes the menu without moving focus, so keyboard users are not
    // trapped in a popover that only ever listened for mouse events.
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className="flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors"
        style={{
          ...CARD_SURFACE,
          color: PALETTE.charcoal,
          backgroundColor: isOpen ? PALETTE.sand : theme.surface,
        }}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: PALETTE.bottleGreen }}
        />
        {activeRole}
        <ChevronDownIcon
          className={`h-3.5 w-3.5 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
          style={{ color: PALETTE.charcoalMuted }}
        />
      </button>

      {isOpen && (
        <div
          className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl"
          style={{
            ...CARD_SURFACE,
            backgroundColor: theme.surface,
          }}
        >
          <p
            className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ borderColor: theme.sandBorder, color: PALETTE.charcoalMuted }}
          >
            Preview as
          </p>
          {ROLES.map((role) => {
            const isSelected = role === activeRole;
            return (
              <button
                key={role}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  onSelect(role);
                  setIsOpen(false);
                }}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors"
                style={{
                  color: PALETTE.charcoal,
                  backgroundColor: isSelected ? PALETTE.bottleGreenSoft : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = PALETTE.sand;
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {role}
                {isSelected && (
                  <CheckIcon className="h-4 w-4" style={{ color: PALETTE.bottleGreen }} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Data mode switcher — dev/demo preview toggle for empty-state QA.
// Phase 3 removes this once `hasData` is derived from real API responses.
// ----------------------------------------------------------------------------

const DATA_MODES = [
  { id: 'live', label: 'Healthy Store', shortLabel: 'Healthy' },
  { id: 'struggling', label: 'Struggling Store', shortLabel: 'Struggling' },
  { id: 'empty', label: 'New Tenant (No Data)', shortLabel: 'No data' },
];

const DataModeSwitcher = ({ dataMode, onSelect, tenant = null, onSwitchTenant = () => {} }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE, EARTH } = useDesignTokens();

  // The mocked preview states were written against the seeded demo store only.
  // For every other tenant the switcher reports the live source instead of
  // offering fakes, and still lets you switch back to another store.
  const isPrimaryDemo = isPrimaryDemoTenant(tenant);
  const otherTenants  = isDemoTenant(tenant)
    ? DEMO_TENANTS.filter((entry) => entry.slug !== tenant?.slug)
    : [];
  const activeMode    = DATA_MODES.find((mode) => mode.id === dataMode);
  const activeLabel   = isPrimaryDemo ? (activeMode?.label ?? 'Healthy Store') : 'Live data';
  // Below sm the full label does not fit next to the greeting, and the trigger
  // used to collapse to a bare dot — so the data state was unknowable on a
  // phone. A short label keeps the state readable at every width.
  const shortLabel    = isPrimaryDemo ? (activeMode?.shortLabel ?? 'Healthy') : 'Live';

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    // Escape closes the menu without moving focus, so keyboard users are not
    // trapped in a popover that only ever listened for mouse events.
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className="flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors"
        style={{
          ...CARD_SURFACE,
          color: PALETTE.charcoal,
          backgroundColor: isOpen ? PALETTE.sand : theme.surface,
        }}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor:
              dataMode === 'empty'
                ? PALETTE.charcoalMuted
                : dataMode === 'struggling'
                  ? EARTH.terracotta
                  : PALETTE.bottleGreen,
          }}
        />
        <span className="truncate text-xs sm:hidden">{shortLabel}</span>
        <span className="hidden truncate sm:inline">{activeLabel}</span>
        <ChevronDownIcon
          className={`h-3.5 w-3.5 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
          style={{ color: PALETTE.charcoalMuted }}
        />
      </button>

      {isOpen && (
        <div
          className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl"
          style={{
            ...CARD_SURFACE,
            backgroundColor: theme.surface,
          }}
        >
          <p
            className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ borderColor: theme.sandBorder, color: PALETTE.charcoalMuted }}
          >
            {isPrimaryDemo ? 'Preview data state' : 'Data source'}
          </p>
          {!isPrimaryDemo && (
            /* Non-interactive by design: this store only ever has live data. */
            <div
              className="flex items-center justify-between px-4 py-2.5 text-sm"
              style={{ backgroundColor: PALETTE.bottleGreenSoft, color: PALETTE.charcoalMuted }}
            >
              Live data
              <CheckIcon className="h-4 w-4" style={{ color: PALETTE.bottleGreen }} />
            </div>
          )}
          {isPrimaryDemo && DATA_MODES.map((mode) => {
            const isSelected = mode.id === dataMode;
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  onSelect(mode.id);
                  setIsOpen(false);
                }}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors"
                style={{
                  color: PALETTE.charcoal,
                  backgroundColor: isSelected ? PALETTE.bottleGreenSoft : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = PALETTE.sand;
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {mode.label}
                {isSelected && (
                  <CheckIcon className="h-4 w-4" style={{ color: PALETTE.bottleGreen }} />
                )}
              </button>
            );
          })}

          {/* Switch store — every demo tenant except the one already signed in. */}
          {otherTenants.length > 0 && (
            <>
              <div className="h-px" style={{ backgroundColor: theme.sandBorder }} />
              <p
                className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: PALETTE.charcoalMuted }}
              >
                Switch store
              </p>
              {otherTenants.map((entry) => (
                <button
                  key={entry.slug}
                  type="button"
                  onClick={() => {
                    onSwitchTenant(entry.slug, entry.email);
                    setIsOpen(false);
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm transition-colors"
                  style={{ color: PALETTE.charcoal, backgroundColor: 'transparent' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = PALETTE.sand;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Top header
// ----------------------------------------------------------------------------

/**
 * Greets the active role. Deliberately locale-neutral: the product is
 * multi-tenant, so the shell must not hardcode one region's customary greeting.
 * The role comes from AuthContext (via initialRole) — no display name is
 * invented from the sign-in email (T9).
 * @param {string} activeRole Role currently previewed ('Owner' | 'Manager').
 * @returns {string} e.g. "Welcome back, Owner."
 */
const getGreeting = (activeRole) => `Welcome back, ${activeRole}.`;

const TopHeader = ({
  activeRole,
  onRoleSelect,
  dataMode,
  onDataModeSelect,
  tenant,
  onSwitchTenant,
}) => {
  const { isDark, theme, toggleTheme } = useTheme();

  return (
    <header
      className="sticky top-0 z-20 flex items-center justify-between gap-4 px-4 py-3.5 sm:px-6 lg:px-8"
      style={{
        backgroundColor: theme.background,
        borderBottom: `1px solid ${theme.sandBorder}`,
        boxShadow: theme.headerShadow,
      }}
    >
      <div className="min-w-0">
        <h1
          className="truncate text-base font-semibold sm:text-lg"
          style={{ color: theme.charcoal }}
        >
          {getGreeting(activeRole)}
        </h1>
        <p className="mt-0.5 text-xs" style={{ color: theme.charcoalMuted }}>
          {activeRole === 'Manager'
            ? "Here is what needs attention today."
            : "Here is your store's health today."}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="flex h-9 w-9 items-center justify-center rounded-xl transition-colors"
          style={{
            backgroundColor: theme.panelBg,
            border: `1px solid ${theme.sandBorder}`,
            color: theme.charcoal,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = theme.controlHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = theme.panelBg;
          }}
        >
          {isDark ? (
            <SunIcon className="h-4 w-4" />
          ) : (
            <MoonIcon className="h-4 w-4" />
          )}
        </button>
        <DataModeSwitcher
          dataMode={dataMode}
          onSelect={onDataModeSelect}
          tenant={tenant}
          onSwitchTenant={onSwitchTenant}
        />
        <RoleSwitcher activeRole={activeRole} onSelect={onRoleSelect} />
      </div>
    </header>
  );
};

// ----------------------------------------------------------------------------
// DashboardShell — top-level export
// ----------------------------------------------------------------------------

const DashboardShell = ({
  children,
  initialView = 'overview',
  initialRole = 'Owner',
  initialDataMode = 'live',
  onNavigate = () => {},
  onRoleChange = () => {},
  onDataModeChange = () => {},
}) => {
  const { theme } = useTheme();
  const { tenant, switchTenant } = useAuth();
  // A hash in the URL wins over the prop, so refreshing or opening a shared link
  // keeps the view the user was on.
  const [activeView, setActiveView] = useState(() => readViewFromHash() ?? initialView);
  const [activeRole, setActiveRole] = useState(initialRole);
  const [dataMode, setDataMode] = useState(initialDataMode);

  // Mock preview data only exists for the seeded demo store, so every other
  // tenant is pinned to live mode whatever the switcher was left on.
  const effectiveDataMode = isPrimaryDemoTenant(tenant) ? dataMode : 'live';

  // Back/forward (and a hand-edited hash) re-sync the active view.
  useEffect(() => {
    const onHashChange = () => {
      const next = readViewFromHash();
      if (next) setActiveView(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleNavigate = (id) => {
    setActiveView(id);
    if (readViewFromHash() !== id) {
      // pushState keeps the Back button meaningful and, unlike assigning
      // location.hash, does not fire hashchange — so the state above stays the
      // single source of truth.
      window.history.pushState(null, '', `#/${id}`);
    }
    onNavigate(id);
  };

  const handleRoleChange = (role) => {
    setActiveRole(role);
    onRoleChange(role);
  };

  const handleDataModeChange = (mode) => {
    setDataMode(mode);
    onDataModeChange(mode);
  };

  // The render prop receives handleNavigate as its fourth argument (T12d) so a
  // view can send the user to another one — e.g. the ingestion hub offering
  // "Open Recommendations" once an import's analysis has landed. It is the same
  // setter the sidebar and dock use, so the URL-less view state stays single-
  // sourced here.
  const content =
    typeof children === 'function'
      ? children(activeView, activeRole, effectiveDataMode, handleNavigate)
      : children;
  return (
    <div className="min-h-screen" style={{ backgroundColor: theme.background }}>
      <Sidebar activeView={activeView} onSelect={handleNavigate} tenant={tenant} />

      {/* Main column — offset for the docked sidebar on lg+ */}
      <div className="lg:ml-64">
        <TopHeader
          activeRole={activeRole}
          onRoleSelect={handleRoleChange}
          dataMode={effectiveDataMode}
          onDataModeSelect={handleDataModeChange}
          tenant={tenant}
          onSwitchTenant={switchTenant}
        />

        <main className="p-4 pb-24 sm:p-6 lg:p-8 lg:pb-8">
          <div className="mx-auto max-w-[1400px]">{content}</div>
        </main>
      </div>

      <BottomDock activeView={activeView} onSelect={handleNavigate} />
    </div>
  );
};

// ----------------------------------------------------------------------------
// Role-based access gate — shared by Owner / Manager dashboard scaffolds
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Empty state — shared across Overview, Deep Analytics, Stockout Watch, and
// Recommendations for brand-new tenants with zero ingested data.
// ----------------------------------------------------------------------------

const InboxIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M4 12.5 6.5 5h11l2.5 7.5" />
    <path d="M4 12.5v6a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-6" />
    <path d="M4 12.5h4.5l1 2h5l1-2H20" />
  </svg>
);

/**
 * @param {Object} props
 * @param {React.ReactNode} [props.icon] Illustration for the empty card.
 * @param {string} [props.title]
 * @param {string} [props.description]
 * @param {string|null} [props.hint] Optional footnote that explains *why* the
 *   view is empty. Used by the preview data states, where an intentionally
 *   blank view would otherwise look like a broken import.
 * @param {string} [props.actionLabel]
 * @param {() => void} [props.onAction]
 */
export const EmptyState = ({
  icon,
  title = 'Nothing here yet',
  description = 'Once sales data comes in, this view fills in automatically.',
  hint = null,
  actionLabel,
  onAction,
}) => {
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE, INSET_SURFACE } = useDesignTokens();

  return (
    <div className="flex min-h-[360px] items-center justify-center px-4 py-12">
      <div
        className="max-w-md rounded-2xl px-8 py-12 text-center"
        style={{
          ...CARD_SURFACE,
          backgroundColor: theme.surface,
        }}
      >
        <span
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl"
          style={{ ...INSET_SURFACE, color: PALETTE.charcoalMuted }}
        >
          {icon || <InboxIcon className="h-6 w-6" />}
        </span>
        <h2 className="mt-6 text-lg font-semibold" style={{ color: PALETTE.charcoal }}>
          {title}
        </h2>
        <p className="mt-3 text-sm leading-relaxed" style={{ color: PALETTE.charcoalMuted }}>
          {description}
        </p>
        {hint && (
          <p
            className="mt-4 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed"
            style={{ borderColor: theme.sandBorder, color: PALETTE.charcoalMuted }}
          >
            {hint}
          </p>
        )}
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="mt-6 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors"
            style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = PALETTE.bottleGreenHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = PALETTE.bottleGreen;
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
};

export const AdminRestrictedAccess = () => {
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();

  return (
    <div className="flex min-h-[400px] items-center justify-center px-4 py-12">
      <div
        className="max-w-md rounded-2xl px-8 py-12 text-center"
        style={{
          ...CARD_SURFACE,
          backgroundColor: theme.surface,
        }}
      >
        <span
          className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-semibold"
          style={{ backgroundColor: PALETTE.bottleGreenSoft, color: PALETTE.bottleGreen }}
        >
          !
        </span>
        <h2 className="mt-6 text-lg font-semibold" style={{ color: PALETTE.charcoal }}>
          Restricted Access
        </h2>
        <p className="mt-3 text-sm leading-relaxed" style={{ color: PALETTE.charcoalMuted }}>
          Financial metrics and deep simulation pipelines are hidden for System Administrators.
        </p>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Shared presentation primitives — added so the five views stop hand-rolling
// their own page titles and status pills (which is how the same badge ended up
// with four different inks).
// ----------------------------------------------------------------------------

/**
 * Page title for a view. The sticky header owns the greeting (h1), so a view
 * starts at h2 — previously Overview and Deep Analytics had no title at all.
 */
export const SectionHeading = ({ title, description = null, actions = null }) => {
  const { PALETTE } = useDesignTokens();

  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight" style={{ color: PALETTE.charcoal }}>
          {title}
        </h2>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed" style={{ color: PALETTE.charcoalMuted }}>
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
};

/**
 * Tone-driven status pill. Every tone pairs a soft fill with that tone's *Ink
 * text token, so a badge is never pastel-on-pastel (the old badges used the
 * muted body ink on a tint, which measured ~4.2:1 at 11px).
 * @param {{tone?: 'positive'|'warning'|'danger'|'info'|'neutral', children: React.ReactNode}} props
 */
export const StatusPill = ({ tone = 'neutral', children }) => {
  const { isDark } = useTheme();
  const { ACCENTS, PALETTE } = useDesignTokens();

  const TONE_STYLES = {
    positive: { backgroundColor: ACCENTS.positiveSoft, color: ACCENTS.positiveInk },
    warning:  { backgroundColor: ACCENTS.warningSoft,  color: ACCENTS.warningInk },
    danger:   { backgroundColor: ACCENTS.dangerSoft,   color: ACCENTS.dangerInk },
    info:     { backgroundColor: ACCENTS.violetSoft,   color: isDark ? ACCENTS.violet : PALETTE.charcoal },
    neutral:  { backgroundColor: PALETTE.sand,         color: PALETTE.charcoalMuted },
  };

  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={TONE_STYLES[tone] ?? TONE_STYLES.neutral}
    >
      {children}
    </span>
  );
};

// ----------------------------------------------------------------------------
// Stock urgency — one scale for every "days of inventory left" surface.
// Overview and Stockout Watch used to disagree (10 days was "Healthy" on one
// page and "Watch" on the other, and the bars filled in opposite directions).
// ----------------------------------------------------------------------------

export const STOCK_URGENCY = {
  act:     { maxDays: 3,        label: 'Act now' },
  watch:   { maxDays: 7,        label: 'Watch' },
  healthy: { maxDays: Infinity, label: 'Healthy' },
};

/** Maps an urgency key onto a StatusPill tone. */
export const STOCK_URGENCY_TONE = { act: 'danger', watch: 'warning', healthy: 'positive' };

/**
 * Classifies a days-of-stock figure.
 * @param {number} daysLeft Days of inventory left (may be Infinity).
 * @returns {'act'|'watch'|'healthy'}
 */
export const getStockUrgency = (daysLeft) => {
  if (!Number.isFinite(daysLeft)) return 'healthy';
  if (daysLeft <= STOCK_URGENCY.act.maxDays) return 'act';
  if (daysLeft <= STOCK_URGENCY.watch.maxDays) return 'watch';
  return 'healthy';
};

/**
 * Bar fill for a days-of-stock figure: the fuller the bar, the more urgent.
 * Both inventory surfaces use this so the same number always draws the same bar.
 * @param {number} daysLeft Days of inventory left.
 * @param {number} horizonDays Days at which the bar is empty.
 * @returns {number} 0-100.
 */
export const stockRiskFillPercent = (daysLeft, horizonDays = 14) => {
  if (!Number.isFinite(daysLeft)) return 0;
  return Math.max(0, Math.min(100, 100 - (daysLeft / horizonDays) * 100));
};

export default DashboardShell;