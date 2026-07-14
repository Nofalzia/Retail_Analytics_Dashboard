import React, { useState, useRef, useEffect } from 'react';
import { useTheme, useDesignTokens } from '../../context/ThemeContext';

/**
 * ============================================================================
 * DashboardShell  —  Global layout shell & design tokens with theme support
 * ============================================================================
 */



// Legacy exports for backward compatibility
export const PALETTE = {
  cream: '#FAF7F1',
  sand: '#F3EDE4',
  sandBorder: 'rgba(36, 31, 26, 0.07)',
  charcoal: '#241F1A',
  charcoalMuted: '#57534E',
  bottleGreen: '#1E362D',
  bottleGreenHover: '#294A3D',
  bottleGreenSoft: 'rgba(30, 54, 45, 0.08)',
  bottleGreenSoftStrong: 'rgba(30, 54, 45, 0.14)',
};

/** Shared card containment — ultra-crisp border with sophisticated depth */
export const CARD_SURFACE = {
  backgroundColor: '#FFFFFF',
  border: '1px solid rgba(120, 113, 104, 0.24)',
  boxShadow:
    '0 2px 8px -3px rgba(0,0,0,0.05), 0 8px 24px -4px rgba(0,0,0,0.03)',
};

/** Elevated panel on sand-tinted canvas */
export const PANEL_SURFACE = {
  backgroundColor: PALETTE.sand,
  border: `1px solid rgba(120, 113, 104, 0.18)`,
  boxShadow: '0 4px 20px rgba(36, 31, 26, 0.04)',
};

/** Earth-tone accents — charts, urgency states, slider fills */
export const EARTH = {
  sage: '#7C9473',
  sageSoft: 'rgba(124, 148, 115, 0.14)',
  sand: '#C9A87C',
  sandSoft: 'rgba(201, 168, 124, 0.16)',
  terracotta: '#BE6A4B',
  terracottaSoft: 'rgba(190, 106, 75, 0.10)',
  ochre: '#B8863B',
  ochreSoft: 'rgba(184, 134, 59, 0.10)',
};

/** Ultra-faded chart grid / axis lines — maximizes data-ink ratio */
export const CHART_AXIS = {
  grid: 'rgba(87, 83, 78, 0.08)',
  border: 'rgba(87, 83, 78, 0.08)',
};

/** Nested inset panel within card surfaces */
export const INSET_SURFACE = {
  backgroundColor: PALETTE.sand,
  border: `1px solid ${PALETTE.sandBorder}`,
  boxShadow: '0 2px 8px rgba(36, 31, 26, 0.03)',
};

/** Desaturated alert badge fills — pair with PALETTE.charcoalMuted for label text */
export const ALERT_SURFACE = {
  critical: {
    backgroundColor: 'rgba(190, 106, 75, 0.08)',
    borderColor: EARTH.terracotta,
  },
  warning: {
    backgroundColor: 'rgba(184, 134, 59, 0.08)',
    borderColor: EARTH.ochre,
  },
};

/** Local commercial currency — returns prefix + formatted value for typographic hierarchy */
export const formatLocalCurrency = (amount) => ({
  prefix: 'Rs.',
  value: Math.round(amount).toLocaleString('en-PK'),
});

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

export const ROLES = ['Owner', 'Manager', 'System Administrator'];

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

const SidebarNavLink = ({ item, isActive, onSelect }) => {
  const { label, Icon } = item;
  const { PALETTE } = useDesignTokens();

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className="group flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors duration-150"
      style={
        isActive
          ? { backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }
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

const Sidebar = ({ activeView, onSelect }) => {
  const { theme, isDark } = useTheme();
  const { PALETTE } = useDesignTokens();

  return (
    <aside
      className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:w-64 lg:flex-col"
      style={{
        backgroundColor: theme.surface,
        borderRight: `1px solid ${theme.sandBorder}`,
        boxShadow: isDark
          ? '4px 0 24px rgba(0, 0, 0, 0.3)'
          : '4px 0 24px rgba(36, 31, 26, 0.03)',
      }}
    >
      <div className="flex items-center gap-3 px-6 py-6">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
        >
          <StoreMarkIcon className="h-4.5 w-4.5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
            Retail Analytics
          </p>
          <p className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
            Store Intelligence
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
          />
        ))}
      </nav>

      <div className="px-6 py-6">
        <div
          className="rounded-xl p-4"
          style={{
            backgroundColor: theme.panelBg,
            border: `1px solid ${theme.panelBorder}`,
            boxShadow: isDark
              ? '0 2px 8px rgba(0, 0, 0, 0.2)'
              : '0 2px 8px rgba(36, 31, 26, 0.03)',
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
  const { theme, isDark } = useTheme();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 flex lg:hidden"
      style={{
        backgroundColor: theme.surface === '#FFFFFF' ? 'rgba(255, 255, 255, 0.96)' : 'rgba(36, 34, 32, 0.96)',
        borderTop: `1px solid ${theme.sandBorder}`,
        boxShadow: isDark
          ? '0 -4px 24px rgba(0, 0, 0, 0.4)'
          : '0 -4px 24px rgba(36, 31, 26, 0.04)',
        backdropFilter: 'blur(8px)',
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
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
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
          role="listbox"
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
                role="option"
                aria-selected={isSelected}
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
  { id: 'live', label: 'Demo Data' },
  { id: 'empty', label: 'New Tenant (No Data)' },
];

const DataModeSwitcher = ({ dataMode, onSelect }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();
  const activeLabel = DATA_MODES.find((mode) => mode.id === dataMode)?.label ?? 'Demo Data';

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
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
          style={{ backgroundColor: dataMode === 'empty' ? PALETTE.charcoalMuted : PALETTE.bottleGreen }}
        />
        <span className="hidden sm:inline">{activeLabel}</span>
        <ChevronDownIcon
          className={`h-3.5 w-3.5 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
          style={{ color: PALETTE.charcoalMuted }}
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
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
            Preview data state
          </p>
          {DATA_MODES.map((mode) => {
            const isSelected = mode.id === dataMode;
            return (
              <button
                key={mode.id}
                type="button"
                role="option"
                aria-selected={isSelected}
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
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Top header
// ----------------------------------------------------------------------------

const getGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

const TopHeader = ({ userName, activeRole, onRoleSelect, dataMode, onDataModeSelect }) => {
  const { isDark, theme, toggleTheme } = useTheme();

  return (
    <header
      className="sticky top-0 z-20 flex items-center justify-between px-4 py-4 sm:px-6 lg:px-8"
      style={{
        backgroundColor: theme.background,
        borderBottom: `1px solid ${theme.sandBorder}`,
        boxShadow: isDark
          ? '0 4px 12px rgba(0,0,0,0.3)'
          : '0 2px 12px rgba(36, 31, 26, 0.03)',
      }}
    >
      <div className="min-w-0">
        <h1
          className="truncate text-base font-semibold sm:text-lg"
          style={{ color: theme.charcoal }}
        >
          {getGreeting()}, {userName}.
        </h1>
        <p className="mt-0.5 text-xs" style={{ color: theme.charcoalMuted }}>
          Viewing as <span style={{ color: theme.bottleGreen, fontWeight: 600 }}>{activeRole}</span>
        </p>
      </div>

      <div className="flex items-center gap-3">
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
            e.currentTarget.style.backgroundColor = isDark ? '#3d3935' : '#e8e3da';
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
        <DataModeSwitcher dataMode={dataMode} onSelect={onDataModeSelect} />
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
  userName = 'Ayesha',
  initialView = 'overview',
  initialRole = 'Owner',
  initialDataMode = 'live',
  onNavigate = () => {},
  onRoleChange = () => {},
  onDataModeChange = () => {},
}) => {
  const { theme } = useTheme();
  const [activeView, setActiveView] = useState(initialView);
  const [activeRole, setActiveRole] = useState(initialRole);
  const [dataMode, setDataMode] = useState(initialDataMode);

  const handleNavigate = (id) => {
    setActiveView(id);
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

  const content =
    typeof children === 'function' ? children(activeView, activeRole, dataMode) : children;
  return (
    <div className="min-h-screen" style={{ backgroundColor: theme.background }}>
      <Sidebar activeView={activeView} onSelect={handleNavigate} />

      {/* Main column — offset for the docked sidebar on lg+ */}
      <div className="lg:ml-64">
        <TopHeader
          userName={userName}
          activeRole={activeRole}
          onRoleSelect={handleRoleChange}
          dataMode={dataMode}
          onDataModeSelect={handleDataModeChange}
        />

        <main className="p-4 pb-24 sm:p-6 lg:p-8 lg:pb-8">
          <div className="mx-auto max-w-6xl">{content}</div>
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

export const EmptyState = ({
  icon,
  title = 'Nothing here yet',
  description = 'Once sales data comes in, this view fills in automatically.',
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

export default DashboardShell;