import React, { useEffect, useRef, useState } from 'react';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
} from 'chart.js';
import {
  AdminRestrictedAccess,
  EmptyState,
  SectionHeading,
  StatusPill,
  formatCompactCurrency,
  formatLocalCurrency,
  getStockUrgency,
  STOCK_URGENCY,
  STOCK_URGENCY_TONE,
  stockRiskFillPercent,
} from '../layout/DashboardShell';
import { useDesignTokens } from '../../context/ThemeContext';
import { api } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext';
import { resolveStoreId } from '../../utils/resolveStoreId.js';
import ApiErrorNotice, { LoadingState } from '../ApiErrorNotice';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

// Window the /api/overview KPI snapshot covers: the server measures 30 days back
// from the store's as-of date (its latest sale date), so the units-sold footer
// can name that window even when the data ends before today.
const KPI_WINDOW_DAYS = 30;

// Beyond a week of staleness the owner should be told the analysis is measured
// from an older date than "now" — once, in the header, not on every card.
const STALE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {string|null} e.g. '12 Oct 2025' (en-PK), or null when unusable. */
function formatAsOfDate(isoDate) {
  if (!isoDate) return null;
  const parsed = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** @returns {number|null} Whole days between the as-of date and today (local). */
function daysSinceAsOf(isoDate) {
  if (!isoDate) return null;
  const parsed = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - parsed) / DAY_MS);
}

/**
 * Muted "Data as of …" line, plus one ochre sentence when the store's latest
 * sales are more than a week old. Renders nothing when the API gave no date
 * (preview data modes), so those states are untouched.
 */
const AsOfDateNotice = ({ asOfDate }) => {
  const { PALETTE, ACCENTS } = useDesignTokens();
  const label = formatAsOfDate(asOfDate);
  if (!label) return null;

  const staleDays = daysSinceAsOf(asOfDate);

  return (
    <div>
      <p className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
        Data as of {label}
      </p>
      {staleDays !== null && staleDays > STALE_AFTER_DAYS && (
        <p className="mt-1 text-xs" style={{ color: ACCENTS.warningInk }}>
          Your latest sales are from {staleDays} days ago, so this analysis is measured from that date.
        </p>
      )}
    </div>
  );
};

/**
 * BusinessOwnerDashboard — Owner-facing overview scaffold.
 * Reads `activeRole` from DashboardShell and gates financial metrics
 * when previewing as System Administrator.
 */

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

/**
 * Turns a token hex into an rgba() string, so a gradient can reuse the exact
 * series colour instead of a hand-written copy that drifts from the palette
 * (the hero chart's fill was a leftover sage from the old warm theme).
 * @param {string} hex '#rgb' or '#rrggbb'.
 * @param {number} alpha 0-1.
 * @returns {string} rgba() colour.
 */
const withAlpha = (hex, alpha) => {
  const digits = hex.trim().replace('#', '');
  const full = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const TrendUpIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M4 16 9.5 10.5 13.5 14.5 20 7" />
    <path d="M14.5 7h5.5v5.5" />
  </svg>
);

const RevenueIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5v9" />
    <path d="M9.5 15c0 1.1 1.1 2 2.5 2s2.5-.7 2.5-1.8-1-1.6-2.5-2-2.5-1-2.5-2S10.6 9.5 12 9.5s2.5.6 2.5 1.6" />
  </svg>
);

const OrdersIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M4 8.5 12 4l8 4.5" />
    <path d="M4 8.5v7L12 20l8-4.5v-7" />
    <path d="M4 8.5 12 13l8-4.5" />
    <path d="M12 13v7" />
  </svg>
);

const InventoryIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <rect x="4" y="7.5" width="16" height="12" rx="1.5" />
    <path d="M4 11.5h16" />
    <path d="M9 7.5V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8v1.7" />
  </svg>
);

const CurrencyFigure = ({ amount, size = 'lg' }) => {
  const { PALETTE } = useDesignTokens();
  const { prefix, value } = formatLocalCurrency(amount);
  // One size for every KPI numeral. The revenue figure used to be set at
  // text-[3.5rem] while its neighbours were text-[3.6rem], so the three cards
  // never lined up on the baseline.
  const sizeClass = size === 'lg' ? 'text-4xl sm:text-[3.6rem]' : 'text-3xl';

  return (
    <p className={`metric-numeral ${sizeClass} font-bold`} style={{ color: PALETTE.charcoal }}>
      <span className="mr-1.5 text-base font-semibold" style={{ color: PALETTE.charcoalMuted }}>{prefix}</span>
      <span>{value}</span>
    </p>
  );
};

const MetricCard = ({ icon, label, children }) => {
  const { CARD_SURFACE, PALETTE, INSET_SURFACE } = useDesignTokens();

  return (
    <div className="flex h-full flex-col rounded-xl p-6 sm:p-7" style={CARD_SURFACE}>
      <div className="flex items-center gap-3" style={{ color: PALETTE.charcoalMuted }}>
        <span
          className="flex h-9 w-9 items-center justify-center rounded-2xl"
          style={{ ...INSET_SURFACE, color: PALETTE.charcoal }}
        >
          {icon}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: PALETTE.charcoalMuted }}>{label}</span>
      </div>
      <div className="mt-6 flex flex-1 flex-col justify-end">{children}</div>
    </div>
  );
};

const TotalRevenueCard = ({ amount, growthPercent }) => {
  const { PALETTE } = useDesignTokens();
  const isPositive = growthPercent >= 0;

  return (
    <MetricCard icon={<RevenueIcon className="h-4.5 w-4.5" />} label="Total Revenue">
      <CurrencyFigure amount={amount} />
      <div className="mt-3 flex items-center gap-1.5">
        <StatusPill tone={isPositive ? 'positive' : 'danger'}>
          <TrendUpIcon className={`mr-1 h-3 w-3 ${isPositive ? '' : 'rotate-90'}`} />
          {isPositive ? '+' : ''}
          {growthPercent.toFixed(1)}%
        </StatusPill>
        {/* "last month" was inaccurate: the window is whatever the trend query
            returned (30 days in live mode), and the two halves are compared. */}
        <span className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
          vs previous period
        </span>
      </div>
    </MetricCard>
  );
};

const UnitsSoldCard = ({ count, windowDays = null }) => {
  const { PALETTE } = useDesignTokens();
  const formatted = count.toLocaleString('en-PK');

  return (
    <MetricCard icon={<OrdersIcon className="h-4.5 w-4.5" />} label="Units sold">
      <p className="metric-numeral text-4xl font-bold sm:text-[3.6rem]" style={{ color: PALETTE.charcoal }}>
        {formatted}
      </p>
      {/* The value is a period total, never a daily figure. Only name a window
          when the number really was aggregated over one (the live overview
          request); the mock datasets expose no window, so they show the total
          on its own rather than claim one. The footer used to repeat the big
          numeral verbatim ("1,284 / 1,284 units in the last 30 days"). */}
      {windowDays != null && (
        <p className="mt-3 text-xs uppercase tracking-wide" style={{ color: PALETTE.charcoalMuted }}>
          Over the last {windowDays} days
        </p>
      )}
    </MetricCard>
  );
};

const DaysOfInventoryCard = ({ daysLeft }) => {
  const { ACCENTS, PALETTE } = useDesignTokens();
  const hasEstimate = typeof daysLeft === 'number' && Number.isFinite(daysLeft);
  const urgency = getStockUrgency(daysLeft);
  // Shared with Stockout Watch: the bar fills as risk rises (fewer days left),
  // so 9 days reads as "partly urgent" on both screens instead of a mostly
  // full green bar here and a mostly full amber bar there.
  const fillPercent = hasEstimate ? Math.max(4, stockRiskFillPercent(daysLeft)) : 0;
  const urgencyFill = {
    act: ACCENTS.danger,
    watch: ACCENTS.warning,
    healthy: ACCENTS.positive,
  }[urgency];

  return (
    <MetricCard icon={<InventoryIcon className="h-4.5 w-4.5" />} label="Days of Inventory Left">
      <div className="flex items-baseline justify-between gap-4">
        <p className="metric-numeral text-4xl font-bold sm:text-[3.6rem]" style={{ color: PALETTE.charcoal }}>
          {hasEstimate ? daysLeft : '—'}
          {hasEstimate && (
            <span className="ml-1 text-sm font-semibold" style={{ color: PALETTE.charcoalMuted }}>days</span>
          )}
        </p>
        <StatusPill tone={hasEstimate ? STOCK_URGENCY_TONE[urgency] : 'neutral'}>
          {hasEstimate ? STOCK_URGENCY[urgency].label : 'Not enough data'}
        </StatusPill>
      </div>
      <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: PALETTE.sand }}>
        {hasEstimate && (
          <div
            className="h-full rounded-full transition-all duration-700 ease-out"
            style={{ width: `${fillPercent}%`, backgroundColor: urgencyFill }}
          />
        )}
      </div>
      <p className="mt-2.5 text-xs" style={{ color: PALETTE.charcoalMuted }}>
        {hasEstimate
          ? 'Based on current sell-through rate across all stocked products.'
          : 'Not enough stock or sales history yet to estimate a depletion date.'}
      </p>
    </MetricCard>
  );
};

const CHART_LABELS = [
  'Jun 26', 'Jun 27', 'Jun 28', 'Jun 29', 'Jun 30',
  'Jul 1', 'Jul 2', 'Jul 3', 'Jul 4', 'Jul 5', 'Jul 6', 'Jul 7', 'Jul 8', 'Jul 9',
];

/** Healthy store — steady upward trend, healthy daily volumes. */
const CHART_REVENUE = [
  214000, 238000, 226000, 251000, 289000, 264000, 241000,
  276000, 302000, 295000, 318000, 334000, 326000, 351000,
];

/**
 * Struggling store — declining revenue with a sharp drop mid-period,
 * simulating a supply disruption or demand collapse.
 */
const CHART_REVENUE_STRUGGLING = [
  148000, 139000, 152000, 131000, 118000, 124000, 106000,
  98000, 87000, 94000, 79000, 68000, 72000, 61000,
];

/** Metric snapshots keyed by data mode. */
const DATASETS = {
  live: {
    totalRevenue: 4218000,
    revenueGrowthPercent: 12.4,
    totalOrders: 1284,
    ordersToday: 47,
    averageOrdersPerDay: 92,
    daysOfInventoryLeft: 9,
    chartRevenue: CHART_REVENUE,
    chartLabels: CHART_LABELS,
  },
  struggling: {
    totalRevenue: 1198000,
    revenueGrowthPercent: -31.6,
    totalOrders: 387,
    ordersToday: 11,
    averageOrdersPerDay: 28,
    daysOfInventoryLeft: 2,
    chartRevenue: CHART_REVENUE_STRUGGLING,
    chartLabels: CHART_LABELS,
  },
};

/** Maps /api/overview response → the metrics shape this component already uses. */
function mapOverviewToMetrics(data) {
  const { kpi = {}, dailyTrend = [] } = data ?? {};
  const safeTrend = Array.isArray(dailyTrend) ? dailyTrend : [];
  const last14 = safeTrend.slice(-14);

  const chartLabels  = last14.map((d) => {
    const dt = new Date(d.date);
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  });
  const chartRevenue = last14.map((d) => parseFloat(d.revenue) || 0);

  // Growth: split trend in half, compare earlier vs later period
  const half       = Math.floor(safeTrend.length / 2);
  const earlySum   = dailyTrend.slice(0, half).reduce((s, d) => s + (parseFloat(d.revenue) || 0), 0);
  const lateSum    = dailyTrend.slice(half).reduce((s, d) => s + (parseFloat(d.revenue) || 0), 0);
  const growthPct  = earlySum > 0 ? +((lateSum - earlySum) / earlySum * 100).toFixed(1) : 0;

  // Order count on the latest day of the window. The server anchors that window
  // to the store's latest sale date, so the final trend point is "today" for
  // this analysis — asking the browser's clock would return 0 for old exports.
  const lastTrendDay = safeTrend.length > 0 ? safeTrend[safeTrend.length - 1].date : null;
  const lastDayData  = lastTrendDay ? safeTrend.find((d) => d.date === lastTrendDay) : null;
  const ordersToday  = lastDayData ? parseInt(lastDayData.transaction_count || 0) : 0;

  const avgPerDay  = dailyTrend.length > 0
    ? Math.round(parseInt(kpi.total_transactions) / safeTrend.length)
    : 0;

  return {
    totalRevenue:         parseFloat(kpi.total_revenue) || 0,
    revenueGrowthPercent: growthPct,
    totalOrders:          parseInt(kpi.total_transactions) || 0,
    // Units sold (T10b-2): the API's unitsSold field when present, then the
    // existing total_units_sold aggregate, and only then the old transaction
    // count. totalOrders stays for the mock preview datasets.
    unitsSold:            parseInt(
      data?.unitsSold ?? kpi.unitsSold ?? kpi.total_units_sold ?? kpi.total_transactions,
    ) || 0,
    ordersToday,
    averageOrdersPerDay:  avgPerDay,
    // NOTE: no daysOfInventoryLeft here. In live mode the inventory card is
    // driven by the /api/stockout-derived median (see main component), and in
    // demo modes by the DATASETS mocks. A missing value renders the explicit
    // "Not enough data" state in DaysOfInventoryCard.
    chartRevenue,
    chartLabels,
  };
}

const PerformanceChart = ({ chartRevenue = CHART_REVENUE, chartLabels = CHART_LABELS }) => {
  const { PALETTE, CHART_AXIS, EARTH, CARD_SURFACE } = useDesignTokens();
  const canvasRef = useRef(null);
  const chartInstanceRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    // Destroy any existing chart instance before creating a new one —
    // this handles dataset switching (healthy → struggling) cleanly.
    chartInstanceRef.current?.destroy();

    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 260);
    gradient.addColorStop(0, withAlpha(EARTH.sage, 0.26));
    gradient.addColorStop(1, withAlpha(EARTH.sage, 0.02));

    chartInstanceRef.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [
          {
            label: 'Daily Revenue',
            data: chartRevenue,
            borderColor: EARTH.sage,
            backgroundColor: gradient,
            pointBackgroundColor: EARTH.sage,
            pointBorderColor: PALETTE.surface,
            pointBorderWidth: 1.5,
            pointRadius: 3,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: EARTH.sage,
            borderWidth: 2.5,
            tension: 0.4,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: PALETTE.charcoal,
            titleColor: PALETTE.cream,
            bodyColor: PALETTE.sand,
            borderColor: CHART_AXIS.border,
            borderWidth: 1,
            padding: 10,
            cornerRadius: 10,
            displayColors: false,
            callbacks: {
              label: (item) => {
                const { prefix, value } = formatLocalCurrency(item.parsed.y);
                return `${prefix} ${value}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: CHART_AXIS.border },
            ticks: { color: PALETTE.charcoalMuted, font: { size: 11 } },
          },
          y: {
            grid: { color: CHART_AXIS.grid },
            border: { display: false },
            ticks: {
              color: PALETTE.charcoalMuted,
              font: { size: 11 },
              // Same formatter the currency cards use, so the axis can never
              // disagree with the KPI numerals about how an amount is written.
              callback: (value) => formatCompactCurrency(value),
            },
          },
        },
      },
    });

    return () => {
      chartInstanceRef.current?.destroy();
    };
  }, [PALETTE, CHART_AXIS, EARTH, chartRevenue, chartLabels]);

  return (
    <div className="rounded-xl p-6 sm:p-8" style={CARD_SURFACE}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
            Revenue, last 14 days
          </h2>
          <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
            A quiet look at how sales have been trending — no configuration needed.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: PALETTE.charcoalMuted }}>
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: EARTH.sage }} />
          Daily revenue
        </div>
      </div>
      <div className="mt-6 h-[260px] w-full">
        <canvas ref={canvasRef} role="img" aria-label="Line chart of daily revenue over the last 14 days" />
      </div>
    </div>
  );
};

const BusinessOwnerDashboard = ({
  activeRole = 'Owner',
  hasData = true,
  dataMode = 'live',
  onOpenView = null,
}) => {
  // Scope every query to the store inside the signed-in account's token. The
  // demo tenant keeps its historic id as a fallback (see resolveStoreId); any
  // other tenant with no store claim resolves to null and is told so below.
  const { user, tenant } = useAuth();
  const storeId = resolveStoreId(user?.storeId, tenant?.slug);
  const isLive = dataMode === 'live';

  // Live mode starts empty — data comes from the API. Non-live demo modes keep
  // the curated mock datasets untouched.
  const [metrics, setMetrics] = useState(isLive ? null : (DATASETS[dataMode] ?? DATASETS.live));
  const [inventoryDays, setInventoryDays] = useState(null);
  // The store's as-of date from the API — the analysis is measured from here.
  const [asOfDate, setAsOfDate] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [hasLiveData, setHasLiveData] = useState(true);
  const [isLoaded, setIsLoaded] = useState(!isLive);
  const [retryTick, setRetryTick] = useState(0);

  // Live mode: fetch real data from the API. On failure show the error notice —
  // NEVER fall back to the mock DATASETS. Empty-but-successful responses render
  // the proper empty state instead of mocks.
  useEffect(() => {
    if (dataMode !== 'live') {
      setMetrics(DATASETS[dataMode] ?? DATASETS.live);
      setInventoryDays(null);
      // Preview modes are curated fixtures with no real sale dates — no notice.
      setAsOfDate(null);
      setLoadError(false);
      setHasLiveData(true);
      setIsLoaded(true);
      return;
    }

    setLoadError(false);
    setHasLiveData(true);
    setIsLoaded(false);
    setMetrics(null);
    setInventoryDays(null);
    setAsOfDate(null);

    // No store on the account: the render path shows the not-linked-to-a-store
    // notice, so there is nothing to fetch.
    if (!storeId) return undefined;

    Promise.all([
      // KPI snapshot + daily trend chart. No date range is sent: the server
      // anchors its 30-day window to the store's latest sale date, so an export
      // that ends weeks ago still fills the chart and the KPIs.
      api.getOverview({ storeId })
        .then((data) => {
          const hasTransactions = (parseInt(data?.kpi?.total_transactions) || 0) > 0;
          setAsOfDate(data?.asOfDate ?? null);
          setHasLiveData(hasTransactions);
          setMetrics(hasTransactions ? mapOverviewToMetrics(data) : null);
        }),

      // Days-of-inventory health — median of each product's stock/velocity
      // projection from the same stockout API that powers Stockout Watch.
      api.getStockout({ storeId, velocityDays: 14 })
        .then((response) => {
          // Same as-of date as the overview (both anchored server-side); used as
          // a fallback in case the overview response predates the field.
          setAsOfDate((prev) => prev ?? response?.asOfDate ?? null);
          const rows = Array.isArray(response?.products) ? response.products : [];
          // Only products that have actually been counted can project a
          // depletion date. When the store has no inventory at all — the API
          // says so via hasInventoryData — the card keeps its "Not enough data"
          // state instead of estimating from zero stock.
          const stocked = rows.filter((p) => p?.last_counted_date != null);
          if (response?.hasInventoryData === false || rows.length === 0 || stocked.length === 0) {
            setInventoryDays(null);
            return;
          }
          const days = stocked
            .map((p) => {
              const velocity = parseFloat(p.avg_daily_velocity);
              const stock    = parseInt(p.quantity_on_hand) || 0;
              return velocity > 0 ? stock / velocity : null;
            })
            .filter((d) => d !== null && Number.isFinite(d))
            .sort((a, b) => a - b);
          if (days.length === 0) {
            setInventoryDays(null);
            return;
          }
          const mid = Math.floor(days.length / 2);
          const median =
            days.length % 2 === 1 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
          setInventoryDays(+median.toFixed(1));
        }),
    ])
      .catch(() => setLoadError(true))
      .finally(() => setIsLoaded(true));
  }, [dataMode, retryTick, storeId]);

  // T12d: an import now runs detection and recommendations itself, then announces
  // it on 'rad:data-refreshed'. Bump the retry counter so this view refetches
  // instead of showing numbers from before the import. Live mode only — the
  // preview fixtures cannot change.
  useEffect(() => {
    if (!isLive) return undefined;
    const onDataRefreshed = () => setRetryTick((tick) => tick + 1);
    window.addEventListener('rad:data-refreshed', onDataRefreshed);
    return () => window.removeEventListener('rad:data-refreshed', onDataRefreshed);
  }, [isLive]);

  if (activeRole === 'System Administrator') {
    return <AdminRestrictedAccess />;
  }

  if (!hasData) {
    return (
      <EmptyState
        title="No sales data yet"
        description="Once your store's sales start coming in, your revenue, orders, and inventory health will show up here automatically."
        actionLabel={onOpenView ? 'Go to Data Ingestion' : undefined}
        onAction={onOpenView ? () => onOpenView('data-ingestion') : undefined}
      />
    );
  }

  // Live mode never renders mocks: error → notice, loading → placeholder,
  // empty-but-successful → proper empty state.
  if (isLive) {
    if (!storeId) {
      return <ApiErrorNotice message="Your account is not linked to a store. Please contact support." />;
    }
    if (loadError) {
      return <ApiErrorNotice onRetry={() => setRetryTick((t) => t + 1)} />;
    }
    if (!isLoaded) {
      return <LoadingState label="Loading store data…" />;
    }
    if (!hasLiveData || metrics === null) {
      return (
        <EmptyState
          title="No sales data yet"
          description="Once your store's sales start coming in, your revenue, orders, and inventory health will show up here automatically."
          actionLabel={onOpenView ? 'Go to Data Ingestion' : undefined}
          onAction={onOpenView ? () => onOpenView('data-ingestion') : undefined}
        />
      );
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Store overview"
        description="Revenue, units sold and inventory runway for this store."
      />
      {/* Where the analysis is measured to (store's latest sale date). */}
      <AsOfDateNotice asOfDate={asOfDate} />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <TotalRevenueCard amount={metrics.totalRevenue} growthPercent={metrics.revenueGrowthPercent} />
        <UnitsSoldCard
          count={metrics.unitsSold ?? metrics.totalOrders}
          windowDays={isLive ? KPI_WINDOW_DAYS : null}
        />
        <DaysOfInventoryCard daysLeft={inventoryDays ?? metrics.daysOfInventoryLeft} />
      </div>
      <PerformanceChart chartRevenue={metrics.chartRevenue} chartLabels={metrics.chartLabels} />
    </div>
  );
};

export default BusinessOwnerDashboard;