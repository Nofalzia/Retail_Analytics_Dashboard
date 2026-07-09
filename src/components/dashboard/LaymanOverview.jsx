import React, { useEffect, useMemo, useRef, useState } from 'react';
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

// Register only what this view needs — keeps the Chart.js bundle lean.
Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

/**
 * ============================================================================
 * LaymanOverview  —  Tab 1: Business Owner Overview
 * ----------------------------------------------------------------------------
 * Designed for non-technical retail store owners: a handful of large,
 * unambiguous numbers and one chart, with no jargon and no configuration.
 * Everything a manager/analyst would want (thresholds, anomaly detection,
 * simulations) lives in Tab 2 — this tab stays deliberately shallow.
 *
 * Layout: Bento grid — three metric cards stacked on mobile, side-by-side
 * on sm+, with a full-width performance chart panel underneath.
 *
 * Design system: Warm Euro-Asian Minimalist
 *  - Canvas: bg-stone-50
 *  - Cards: bg-white, border-stone-200, rounded-2xl, generous padding
 *  - Chart palette: sage green / warm sand / terracotta — no digital blues
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Earth-tone palette
// ----------------------------------------------------------------------------
// Centralized so both the Chart.js dataset and the "Days of Inventory Left"
// indicator draw from the exact same set of hex values.

const EARTH = {
  sage: '#7C9473',
  sageSoft: 'rgba(124, 148, 115, 0.14)',
  sand: '#C9A87C',
  sandSoft: 'rgba(201, 168, 124, 0.16)',
  terracotta: '#BE6A4B',
  terracottaSoft: 'rgba(190, 106, 75, 0.16)',
  ink: '#44403c', // stone-700-ish, used for chart text
  grid: '#e7e5e4', // stone-200, used for gridlines
};

// ----------------------------------------------------------------------------
// Icon primitives (hand-rolled, consistent stroke style — no icon packages)
// ----------------------------------------------------------------------------

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
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

// ----------------------------------------------------------------------------
// MetricCard — shared shell for the three bento metric blocks
// ----------------------------------------------------------------------------

const MetricCard = ({ icon, label, children }) => (
  <div className="flex h-full flex-col rounded-2xl border border-stone-200 bg-white p-6 sm:p-7">
    <div className="flex items-center gap-2.5 text-stone-500">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-stone-100 text-stone-600">
        {icon}
      </span>
      <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
    </div>
    <div className="mt-5 flex flex-1 flex-col justify-end">{children}</div>
  </div>
);

// ----------------------------------------------------------------------------
// Total Revenue card
// ----------------------------------------------------------------------------

const TotalRevenueCard = ({ amount, growthPercent }) => {
  const formatted = useMemo(
    () =>
      amount.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }),
    [amount]
  );

  const isPositive = growthPercent >= 0;

  return (
    <MetricCard icon={<RevenueIcon className="h-4.5 w-4.5" />} label="Total Revenue">
      <p className="text-3xl font-semibold tracking-tight text-stone-800 sm:text-4xl">
        {formatted}
      </p>
      <div className="mt-3 flex items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
            isPositive
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}
        >
          <TrendUpIcon className={`h-3 w-3 ${isPositive ? '' : 'rotate-90'}`} />
          {isPositive ? '+' : ''}
          {growthPercent.toFixed(1)}%
        </span>
        <span className="text-xs text-stone-400">vs last month</span>
      </div>
    </MetricCard>
  );
};

// ----------------------------------------------------------------------------
// Total Orders card
// ----------------------------------------------------------------------------

const TotalOrdersCard = ({ count, ordersToday, averagePerDay }) => (
  <MetricCard icon={<OrdersIcon className="h-4.5 w-4.5" />} label="Total Orders">
    <p className="text-3xl font-semibold tracking-tight text-stone-800 sm:text-4xl">
      {count.toLocaleString()}
    </p>
    <p className="mt-3 text-xs text-stone-500">
      <span className="font-medium text-stone-700">{ordersToday} orders</span> today &middot;{' '}
      {averagePerDay}/day average
    </p>
  </MetricCard>
);

// ----------------------------------------------------------------------------
// Days of Inventory Left card
// ----------------------------------------------------------------------------
// Urgency thresholds:
//   >= 14 days  -> sage green   (healthy)
//   7–13 days   -> warm sand    (watch)
//   < 7 days    -> terracotta   (act now)
// The fill width and color both transition smoothly so small day-to-day
// changes never feel like a jarring flip between states.

const INVENTORY_CAP_DAYS = 30; // bar reads "full" at or above this many days

const getInventoryUrgency = (daysLeft) => {
  if (daysLeft >= 14) {
    return { tone: 'Healthy', color: EARTH.sage, soft: EARTH.sageSoft };
  }
  if (daysLeft >= 7) {
    return { tone: 'Watch', color: EARTH.sand, soft: EARTH.sandSoft };
  }
  return { tone: 'Act now', color: EARTH.terracotta, soft: EARTH.terracottaSoft };
};

const DaysOfInventoryCard = ({ daysLeft }) => {
  const { tone, color, soft } = getInventoryUrgency(daysLeft);
  const fillPercent = Math.max(4, Math.min(100, (daysLeft / INVENTORY_CAP_DAYS) * 100));

  return (
    <MetricCard icon={<InventoryIcon className="h-4.5 w-4.5" />} label="Days of Inventory Left">
      <div className="flex items-baseline justify-between">
        <p className="text-3xl font-semibold tracking-tight text-stone-800 sm:text-4xl">
          {daysLeft}
          <span className="ml-1 text-base font-medium text-stone-400">days</span>
        </p>
        <span
          className="rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-500"
          style={{ backgroundColor: soft, color }}
        >
          {tone}
        </span>
      </div>

      {/* Color-shifting progress pill */}
      <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-stone-100">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${fillPercent}%`, backgroundColor: color }}
        />
      </div>
      <p className="mt-2.5 text-xs text-stone-400">
        Based on current sell-through rate across all stocked products.
      </p>
    </MetricCard>
  );
};

// ----------------------------------------------------------------------------
// PerformanceChart — Chart.js line chart, earth-toned throughout
// ----------------------------------------------------------------------------

const CHART_LABELS = [
  'Jun 26', 'Jun 27', 'Jun 28', 'Jun 29', 'Jun 30',
  'Jul 1', 'Jul 2', 'Jul 3', 'Jul 4', 'Jul 5', 'Jul 6', 'Jul 7', 'Jul 8', 'Jul 9',
];

const CHART_REVENUE = [
  2140, 2380, 2260, 2510, 2890, 2640, 2410,
  2760, 3020, 2950, 3180, 3340, 3260, 3510,
];

const PerformanceChart = () => {
  const canvasRef = useRef(null);
  const chartInstanceRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');

    // Soft vertical fill from sage green into transparent — keeps the area
    // under the line warm and quiet rather than a flat digital block.
    const gradient = ctx.createLinearGradient(0, 0, 0, 260);
    gradient.addColorStop(0, 'rgba(124, 148, 115, 0.28)');
    gradient.addColorStop(1, 'rgba(124, 148, 115, 0.02)');

    chartInstanceRef.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels: CHART_LABELS,
        datasets: [
          {
            label: 'Daily Revenue',
            data: CHART_REVENUE,
            borderColor: EARTH.sage,
            backgroundColor: gradient,
            pointBackgroundColor: EARTH.sand,
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1.5,
            pointRadius: 3,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: EARTH.terracotta,
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
            backgroundColor: '#292524', // stone-800
            titleColor: '#fafaf9',
            bodyColor: '#e7e5e4',
            borderColor: EARTH.sand,
            borderWidth: 1,
            padding: 10,
            cornerRadius: 10,
            displayColors: false,
            callbacks: {
              label: (item) => `$${item.parsed.y.toLocaleString()}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: EARTH.grid },
            ticks: { color: EARTH.ink, font: { size: 11 } },
          },
          y: {
            grid: { color: EARTH.grid },
            border: { display: false },
            ticks: {
              color: EARTH.ink,
              font: { size: 11 },
              callback: (value) => `$${value / 1000}k`,
            },
          },
        },
      },
    });

    return () => {
      chartInstanceRef.current?.destroy();
    };
  }, []);

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 sm:p-8">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-stone-800">Revenue, Last 14 Days</h2>
          <p className="mt-1 text-xs text-stone-500">
            A quiet look at how sales have been trending — no configuration needed.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-stone-400">
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

// ----------------------------------------------------------------------------
// LaymanOverview — top-level export
// ----------------------------------------------------------------------------

const LaymanOverview = () => {
  // In production these values arrive from the /api/overview endpoint (or
  // similar) — kept as local state here so the view is runnable standalone.
  const [metrics] = useState({
    totalRevenue: 42180,
    revenueGrowthPercent: 12.4,
    totalOrders: 1284,
    ordersToday: 47,
    averageOrdersPerDay: 92,
    daysOfInventoryLeft: 9,
  });

  return (
    <div className="space-y-6">
      {/* Bento row — three metric cards, stacked on mobile, side-by-side on sm+ */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <TotalRevenueCard
          amount={metrics.totalRevenue}
          growthPercent={metrics.revenueGrowthPercent}
        />
        <TotalOrdersCard
          count={metrics.totalOrders}
          ordersToday={metrics.ordersToday}
          averagePerDay={metrics.averageOrdersPerDay}
        />
        <DaysOfInventoryCard daysLeft={metrics.daysOfInventoryLeft} />
      </div>

      {/* Full-width performance chart panel */}
      <PerformanceChart />
    </div>
  );
};

export default LaymanOverview;