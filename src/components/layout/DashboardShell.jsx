import React, { useState, useEffect } from 'react';

/**
 * ============================================================================
 * DashboardShell
 * ----------------------------------------------------------------------------
 * Foundational layout shell for the multi-tenant Retail Analytics Dashboard.
 *
 * Responsibilities:
 *  - Renders a permanently docked sidebar on desktop (lg breakpoint and up).
 *  - Renders a slide-out drawer + hamburger trigger on mobile/tablet.
 *  - Displays a context-aware greeting panel with a live date/time readout.
 *  - Provides a content window that renders whatever view is passed in as
 *    `children` (e.g. the Overview tab or Deep Analytics tab).
 *
 * Design system: Warm Euro-Asian Minimalist
 *  - Background: bg-stone-50 (soft off-white/cream)
 *  - Panels: bg-white / bg-stone-100 with border-stone-200
 *  - Typography: text-stone-800 (headings), text-stone-500 (secondary)
 *  - No external icon or component libraries — icons are hand-rolled inline
 *    SVGs using a consistent minimalist stroke style.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Icon primitives
// ----------------------------------------------------------------------------
// Kept intentionally lightweight and stroke-based (1.5px) to match the calm,
// paper-like aesthetic of the rest of the interface. Centralizing them here
// means swapping the icon style later only requires editing this block.

const iconStrokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const OverviewIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...iconStrokeProps}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </svg>
);

const AnalyticsIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...iconStrokeProps}>
    <path d="M4 19V5" />
    <path d="M4 19h16" />
    <path d="M8 15v-4" />
    <path d="M12.5 15V7" />
    <path d="M17 15v-6.5" />
  </svg>
);

const IngestionIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...iconStrokeProps}>
    <path d="M12 4v11" />
    <path d="M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 17.5v1.5A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
  </svg>
);

const HamburgerIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...iconStrokeProps}>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
  </svg>
);

const CloseIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...iconStrokeProps}>
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </svg>
);

const StoreMarkIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...iconStrokeProps}>
    <path d="M4 9.5 5.2 4.5h13.6L20 9.5" />
    <path d="M4.5 9.5v9.5A1 1 0 0 0 5.5 20h13a1 1 0 0 0 1-1V9.5" />
    <path d="M9.5 20v-5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V20" />
  </svg>
);

// ----------------------------------------------------------------------------
// Navigation configuration
// ----------------------------------------------------------------------------
// Centralized so the sidebar and the mobile drawer stay in sync automatically.
// `id` is a generic slug — consumers (parent router / tab state) decide what
// each id actually renders, keeping this shell business-agnostic.

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', Icon: OverviewIcon },
  { id: 'deep-analytics', label: 'Deep Analytics', Icon: AnalyticsIcon },
  { id: 'data-ingestion', label: 'Data Ingestion Hub', Icon: IngestionIcon },
];

/**
 * NavLink — a single sidebar/drawer navigation entry.
 */
const NavLink = ({ item, isActive, onSelect }) => {
  const { label, Icon } = item;

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={`
        group flex w-full items-center gap-3 rounded-xl px-4 py-2.5
        text-sm font-medium transition-colors duration-150
        ${
          isActive
            ? 'bg-stone-800 text-stone-50 shadow-sm'
            : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800'
        }
      `}
    >
      <Icon
        className={`h-4.5 w-4.5 shrink-0 ${
          isActive ? 'text-stone-50' : 'text-stone-400 group-hover:text-stone-600'
        }`}
      />
      <span className="truncate">{label}</span>
    </button>
  );
};

/**
 * SidebarContent — shared markup rendered both inside the permanent desktop
 * sidebar and inside the mobile slide-out drawer, so the two never drift
 * out of sync.
 */
const SidebarContent = ({ activeView, onSelect, onRequestClose }) => (
  <div className="flex h-full flex-col">
    {/* Brand mark */}
    <div className="flex items-center gap-3 px-6 py-6">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-stone-800 text-stone-50">
        <StoreMarkIcon className="h-4.5 w-4.5" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-stone-800">Retail Analytics</p>
        <p className="text-xs text-stone-400">Store Intelligence</p>
      </div>

      {/* Close control only visible inside the mobile drawer */}
      {onRequestClose && (
        <button
          type="button"
          onClick={onRequestClose}
          aria-label="Close navigation menu"
          className="ml-auto rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 lg:hidden"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      )}
    </div>

    <div className="mx-6 h-px bg-stone-200" />

    {/* Navigation */}
    <nav className="flex-1 space-y-1 px-4 py-6" aria-label="Primary">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.id}
          item={item}
          isActive={activeView === item.id}
          onSelect={onSelect}
        />
      ))}
    </nav>

    {/* Footer / tenant reminder */}
    <div className="px-6 py-6">
      <div className="rounded-xl border border-stone-200 bg-stone-100 px-4 py-3">
        <p className="text-xs leading-relaxed text-stone-500">
          Data shown is scoped to your connected store. Switch stores from
          account settings.
        </p>
      </div>
    </div>
  </div>
);

/**
 * GreetingPanel — context-aware header shown above the content window.
 * Time is kept live via a lightweight interval so the readout stays fresh
 * without requiring a page refresh.
 */
const GreetingPanel = ({ onOpenDrawer }) => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000); // refresh every 30s
    return () => clearInterval(timer);
  }, []);

  const formattedDate = now.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const formattedTime = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="mb-6 flex items-start gap-4 rounded-2xl border border-stone-200 bg-white px-5 py-5 sm:px-8 sm:py-6">
      {/* Mobile-only hamburger trigger lives inside the greeting panel so it
          stays visible regardless of scroll position within the content area. */}
      <button
        type="button"
        onClick={onOpenDrawer}
        aria-label="Open navigation menu"
        className="mt-1 shrink-0 rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 lg:hidden"
      >
        <HamburgerIcon className="h-5 w-5" />
      </button>

      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-stone-800 sm:text-xl">
          Assalam-o-Alaikum, Manager.
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          Here is your store&apos;s health today.
        </p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-stone-400">
          {formattedDate} &middot; {formattedTime}
        </p>
      </div>
    </div>
  );
};

/**
 * DashboardShell — top-level layout export.
 *
 * Props:
 *  - children: React.ReactNode — the active view (Overview / Deep Analytics /
 *    Data Ingestion Hub) rendered inside the content window.
 *  - activeView: string — id of the currently selected nav item, used to
 *    highlight the matching NavLink. Defaults to 'overview'.
 *  - onNavigate: (id: string) => void — callback fired when a nav item is
 *    selected, letting the parent own routing/tab state.
 */
const DashboardShell = ({ children, activeView = 'overview', onNavigate = () => {} }) => {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Close the mobile drawer automatically whenever the active view changes,
  // so selecting a link doesn't leave the drawer covering the new content.
  useEffect(() => {
    setIsDrawerOpen(false);
  }, [activeView]);

  const handleSelect = (id) => {
    onNavigate(id);
  };

  return (
    <div className="min-h-screen bg-stone-50">
      {/* ------------------------------------------------------------------
          Desktop sidebar — permanently docked at the lg breakpoint and up.
      ------------------------------------------------------------------- */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-stone-200 lg:bg-white">
        <SidebarContent activeView={activeView} onSelect={handleSelect} />
      </aside>

      {/* ------------------------------------------------------------------
          Mobile drawer — slide-out panel + backdrop, hidden on lg+.
      ------------------------------------------------------------------- */}
      <div
        className={`fixed inset-0 z-40 lg:hidden ${
          isDrawerOpen ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
        aria-hidden={!isDrawerOpen}
      >
        {/* Backdrop */}
        <div
          onClick={() => setIsDrawerOpen(false)}
          className={`absolute inset-0 bg-stone-900/30 transition-opacity duration-300 ${
            isDrawerOpen ? 'opacity-100' : 'opacity-0'
          }`}
        />

        {/* Sliding panel */}
        <div
          className={`absolute inset-y-0 left-0 w-72 max-w-[80vw] transform bg-white shadow-xl transition-transform duration-300 ease-out ${
            isDrawerOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <SidebarContent
            activeView={activeView}
            onSelect={handleSelect}
            onRequestClose={() => setIsDrawerOpen(false)}
          />
        </div>
      </div>

      {/* ------------------------------------------------------------------
          Main workspace — offset for the docked sidebar on lg+, scaled
          padding on smaller viewports per the responsiveness spec.
      ------------------------------------------------------------------- */}
      <main className="p-4 sm:p-6 lg:ml-64 lg:p-8">
        <div className="mx-auto max-w-6xl">
          <GreetingPanel onOpenDrawer={() => setIsDrawerOpen(true)} />

          {/* Content window — renders whatever view is currently active. */}
          <div className="rounded-2xl border border-stone-200 bg-white p-4 sm:p-6 lg:p-8">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
};

export default DashboardShell;