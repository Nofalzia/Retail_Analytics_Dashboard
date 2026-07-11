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
  formatLocalCurrency,
} from '../layout/DashboardShell';
import { useDesignTokens } from '../../context/ThemeContext';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);

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
  const sizeClass = size === 'lg' ? 'text-4xl sm:text-[3.5rem]' : 'text-3xl';

  return (
    <p className={`${sizeClass} tracking-tight font-bold`} style={{ color: PALETTE.charcoal }}>
      <span className="mr-1.5 text-base font-semibold" style={{ color: PALETTE.charcoalMuted }}>{prefix}</span>
      <span>{value}</span>
    </p>
  );
};

const MetricCard = ({ icon, label, children }) => {
  const { CARD_SURFACE, PALETTE, INSET_SURFACE } = useDesignTokens();

  return (
    <div className="flex h-full flex-col rounded-xl p-6 sm:p-7 transition-shadow duration-200 ease-out" style={CARD_SURFACE}>
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
  const { EARTH, PALETTE } = useDesignTokens();
  const isPositive = growthPercent >= 0;

  return (
    <MetricCard icon={<RevenueIcon className="h-4.5 w-4.5" />} label="Total Revenue">
      <CurrencyFigure amount={amount} />
      <div className="mt-3 flex items-center gap-1.5">
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-150"
          style={{
            backgroundColor: isPositive ? EARTH.sageSoft : EARTH.terracottaSoft,
            color: PALETTE.charcoalMuted,
          }}
        >
          <TrendUpIcon className={`h-3 w-3 ${isPositive ? '' : 'rotate-90'}`} />
          {isPositive ? '+' : ''}
          {growthPercent.toFixed(1)}%
        </span>
        <span className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
          vs last month
        </span>
      </div>
    </MetricCard>
  );
};

const TotalOrdersCard = ({ count, ordersToday, averagePerDay }) => {
  const { PALETTE } = useDesignTokens();

  return (
    <MetricCard icon={<OrdersIcon className="h-4.5 w-4.5" />} label="Total Orders">
      <p className="text-4xl font-bold tracking-tight sm:text-[3.6rem]" style={{ color: PALETTE.charcoal }}>
        {count.toLocaleString('en-PK')}
      </p>
      <p className="mt-3 text-xs tracking-wide uppercase" style={{ color: PALETTE.charcoalMuted }}>
        <span className="font-semibold" style={{ color: PALETTE.charcoal }}>{ordersToday} orders</span> today · {averagePerDay}/day average
      </p>
    </MetricCard>
  );
};

const INVENTORY_CAP_DAYS = 30;

const getInventoryUrgency = (daysLeft, EARTH) => {
  if (daysLeft >= 14) return { tone: 'Healthy', color: EARTH.sage, soft: EARTH.sageSoft };
  if (daysLeft >= 7) return { tone: 'Watch', color: EARTH.sand, soft: EARTH.sandSoft };
  return { tone: 'Act now', color: EARTH.terracotta, soft: EARTH.terracottaSoft };
};

const DaysOfInventoryCard = ({ daysLeft }) => {
  const { EARTH, PALETTE } = useDesignTokens();
  const { tone, color, soft } = getInventoryUrgency(daysLeft, EARTH);
  const fillPercent = Math.max(4, Math.min(100, (daysLeft / INVENTORY_CAP_DAYS) * 100));

  return (
    <MetricCard icon={<InventoryIcon className="h-4.5 w-4.5" />} label="Days of Inventory Left">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-4xl font-bold tracking-tight sm:text-[3.6rem]" style={{ color: PALETTE.charcoal }}>
          {daysLeft}
          <span className="ml-1 text-sm font-semibold" style={{ color: PALETTE.charcoalMuted }}>days</span>
        </p>
        <span
          className="rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wider"
          style={{ backgroundColor: soft, color: PALETTE.charcoalMuted }}
        >
          {tone}
        </span>
      </div>
      <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: PALETTE.sand }}>
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${fillPercent}%`, backgroundColor: color }}
        />
      </div>
      <p className="mt-2.5 text-xs" style={{ color: PALETTE.charcoalMuted }}>
        Based on current sell-through rate across all stocked products.
      </p>
    </MetricCard>
  );
};

const CHART_LABELS = [
  'Jun 26', 'Jun 27', 'Jun 28', 'Jun 29', 'Jun 30',
  'Jul 1', 'Jul 2', 'Jul 3', 'Jul 4', 'Jul 5', 'Jul 6', 'Jul 7', 'Jul 8', 'Jul 9',
];

const CHART_REVENUE = [
  214000, 238000, 226000, 251000, 289000, 264000, 241000,
  276000, 302000, 295000, 318000, 334000, 326000, 351000,
];

const PerformanceChart = () => {
  const { PALETTE, CHART_AXIS, EARTH, CARD_SURFACE } = useDesignTokens();
  const canvasRef = useRef(null);
  const chartInstanceRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d');
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
            pointBorderColor: PALETTE.cardBg || '#ffffff',
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
              callback: (value) => {
                if (value >= 100000) return `Rs. ${(value / 100000).toFixed(1)}L`;
                if (value >= 1000) return `Rs. ${(value / 1000).toFixed(0)}K`;
                return `Rs. ${value}`;
              },
            },
          },
        },
      },
    });

    return () => {
      chartInstanceRef.current?.destroy();
    };
  }, [PALETTE, CHART_AXIS, EARTH]);

  return (
    <div className="rounded-xl p-6 sm:p-8 transition-shadow duration-200 ease-out" style={CARD_SURFACE}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
            Revenue, Last 14 Days
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

const BusinessOwnerDashboard = ({ activeRole = 'Owner' }) => {
  const [metrics] = useState({
    totalRevenue: 4218000,
    revenueGrowthPercent: 12.4,
    totalOrders: 1284,
    ordersToday: 47,
    averageOrdersPerDay: 92,
    daysOfInventoryLeft: 9,
  });

  if (activeRole === 'System Administrator') {
    return <AdminRestrictedAccess />;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <TotalRevenueCard amount={metrics.totalRevenue} growthPercent={metrics.revenueGrowthPercent} />
        <TotalOrdersCard
          count={metrics.totalOrders}
          ordersToday={metrics.ordersToday}
          averagePerDay={metrics.averageOrdersPerDay}
        />
        <DaysOfInventoryCard daysLeft={metrics.daysOfInventoryLeft} />
      </div>
      <PerformanceChart />
    </div>
  );
};

export default BusinessOwnerDashboard;
