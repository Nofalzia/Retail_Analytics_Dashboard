import React, { useMemo, useState } from 'react';

/**
 * ============================================================================
 * ManagerAnalytics  —  Tab 2: Manager & In-Depth Analytics
 * ----------------------------------------------------------------------------
 * The "under the hood" counterpart to LaymanOverview: rule-based anomaly
 * alerts and a lightweight scenario simulator. Deliberately stays within
 * rule-based statistics and simple arithmetic — no ML models, no external
 * data-science dependencies — per the project's architectural constraints.
 *
 * Composition:
 *   ManagerAnalytics
 *     ├─ AnomalyDetectionPanel   – threshold-triggered alert feed
 *     └─ ScenarioSimulationPanel – interactive sliders + live projections
 *
 * Design system: Warm Euro-Asian Minimalist
 *  - Canvas: bg-stone-50, bento cards on bg-white / border-stone-200
 *  - Alerts use muted ochre (Warning) and terracotta (Critical) tones —
 *    never neon red/orange — so urgency reads without feeling alarmist.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Earth-tone palette (shared with the alert badges and slider accents)
// ----------------------------------------------------------------------------

const EARTH = {
  sage: '#7C9473',
  sand: '#C9A87C',
  ochre: '#B8863B',
  ochreSoft: 'rgba(184, 134, 59, 0.12)',
  terracotta: '#BE6A4B',
  terracottaSoft: 'rgba(190, 106, 75, 0.12)',
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

const AlertIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M12 4 21 19.5H3L12 4Z" />
    <path d="M12 10v4" />
    <path d="M12 16.8v.2" />
  </svg>
);

const CheckIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M5 12.5 9.5 17 19 6.5" />
  </svg>
);

const SlidersIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M5 6h9" />
    <path d="M17 6h2" />
    <circle cx="16" cy="6" r="2" />
    <path d="M5 12h2" />
    <path d="M10 12h9" />
    <circle cx="8" cy="12" r="2" />
    <path d="M5 18h12" />
    <path d="M20 18h-1" />
    <circle cx="18" cy="18" r="2" />
  </svg>
);

const TrendDownIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M4 8 9.5 13.5 13.5 9.5 20 16" />
    <path d="M14.5 16H20v-5.5" />
  </svg>
);

// ----------------------------------------------------------------------------
// AnomalyDetectionPanel
// ----------------------------------------------------------------------------
// Rule-based alerts only: each entry represents a simple statistical
// threshold being crossed (velocity drop, turnover deviation, etc.) rather
// than any learned/ML-driven signal.

const SEVERITY_STYLES = {
  Critical: {
    border: 'border-l-4',
    borderColor: EARTH.terracotta,
    badgeBg: EARTH.terracottaSoft,
    badgeText: EARTH.terracotta,
    iconBg: EARTH.terracottaSoft,
    iconText: EARTH.terracotta,
  },
  Warning: {
    border: 'border-l-4',
    borderColor: EARTH.ochre,
    badgeBg: EARTH.ochreSoft,
    badgeText: EARTH.ochre,
    iconBg: EARTH.ochreSoft,
    iconText: EARTH.ochre,
  },
};

const INITIAL_ALERTS = [
  {
    id: 'alert-1',
    severity: 'Critical',
    title: 'Sudden transaction velocity drop',
    description:
      'A 30% drop in transaction velocity was detected for Product Category "Beverages" over the last 6 hours, compared to the trailing 7-day average.',
    metricLabel: 'Threshold',
    metricValue: '−25% velocity change',
    timestamp: '12 minutes ago',
  },
  {
    id: 'alert-2',
    severity: 'Warning',
    title: 'Inventory turnover below threshold',
    description:
      'Turnover rate for Product Category "Snacks" is running 18% below the configured baseline for this time of month.',
    metricLabel: 'Threshold',
    metricValue: '−15% turnover deviation',
    timestamp: '2 hours ago',
  },
  {
    id: 'alert-3',
    severity: 'Warning',
    title: 'Average basket size trending down',
    description:
      'Average order value has declined for 3 consecutive days, currently 9% below the rolling 30-day mean.',
    metricLabel: 'Threshold',
    metricValue: '3-day consecutive decline',
    timestamp: '5 hours ago',
  },
];

const AlertCard = ({ alert, onAcknowledge, isAcknowledged }) => {
  const styles = SEVERITY_STYLES[alert.severity];

  return (
    <div
      className={`flex gap-4 rounded-xl border border-stone-200 bg-white p-5 ${styles.border} transition-opacity duration-300 ${
        isAcknowledged ? 'opacity-50' : 'opacity-100'
      }`}
      style={{ borderLeftColor: styles.borderColor }}
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: styles.iconBg, color: styles.iconText }}
      >
        <AlertIcon className="h-4.5 w-4.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: styles.badgeBg, color: styles.badgeText }}
          >
            {alert.severity}
          </span>
          <span className="text-xs text-stone-400">{alert.timestamp}</span>
        </div>

        <h3 className="mt-2 text-sm font-semibold text-stone-800">{alert.title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-stone-500">{alert.description}</p>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-stone-400">
            <span className="font-medium text-stone-600">{alert.metricLabel}:</span>{' '}
            {alert.metricValue}
          </p>

          <button
            type="button"
            onClick={() => onAcknowledge(alert.id)}
            disabled={isAcknowledged}
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:cursor-default disabled:opacity-70 disabled:hover:bg-transparent"
          >
            <CheckIcon className="h-3.5 w-3.5" />
            {isAcknowledged ? 'Acknowledged' : 'Acknowledge'}
          </button>
        </div>
      </div>
    </div>
  );
};

const AnomalyDetectionPanel = () => {
  const [acknowledgedIds, setAcknowledgedIds] = useState(() => new Set());

  const handleAcknowledge = (id) => {
    setAcknowledgedIds((prev) => new Set(prev).add(id));
  };

  const openCount = INITIAL_ALERTS.length - acknowledgedIds.size;

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 sm:p-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-stone-800">Threshold Alerts</h2>
          <p className="mt-1 text-xs text-stone-500">
            Rule-based checks against your configured statistical thresholds.
          </p>
        </div>
        <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs font-medium text-stone-600">
          {openCount} open
        </span>
      </div>

      <div className="mt-6 space-y-3">
        {INITIAL_ALERTS.map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onAcknowledge={handleAcknowledge}
            isAcknowledged={acknowledgedIds.has(alert.id)}
          />
        ))}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Earth-toned range slider
// ----------------------------------------------------------------------------
// A single styled <input type="range"> used by both sliders in the
// simulation panel. Thumb/track styling is done with a scoped <style> block
// since Tailwind alone can't reach ::-webkit-slider-thumb / ::-moz-range-thumb.

const EarthSlider = ({ id, label, value, min, max, step, unit, onChange, accent }) => {
  const percent = ((value - min) / (max - min)) * 100;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium text-stone-600">
          {label}
        </label>
        <span className="text-sm font-semibold text-stone-800">
          {value > 0 && unit === '%' ? '+' : ''}
          {value}
          {unit}
        </span>
      </div>

      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="earth-slider mt-3 w-full"
        style={{
          background: `linear-gradient(to right, ${accent} 0%, ${accent} ${percent}%, #e7e5e4 ${percent}%, #e7e5e4 100%)`,
          '--thumb-color': accent,
        }}
      />

      <div className="mt-1.5 flex justify-between text-[11px] text-stone-400">
        <span>
          {min}
          {unit}
        </span>
        <span>
          {max}
          {unit}
        </span>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// ScenarioSimulationPanel
// ----------------------------------------------------------------------------
// Simple, transparent arithmetic — deliberately not a predictive model.
// Two levers (supply chain cost increase, retail price adjustment) shift a
// baseline cost-of-goods percentage, and the resulting margin/profit figures
// recompute on every slider tick via local state.

const BASELINE = {
  monthlyRevenue: 42180,
  cogsPercent: 58, // cost of goods sold as % of revenue, before adjustment
};

const ScenarioSimulationPanel = () => {
  const [supplyCostIncrease, setSupplyCostIncrease] = useState(10); // %
  const [priceAdjustment, setPriceAdjustment] = useState(0); // %

  const projection = useMemo(() => {
    const adjustedCogsPercent = BASELINE.cogsPercent * (1 + supplyCostIncrease / 100);
    const adjustedRevenue = BASELINE.monthlyRevenue * (1 + priceAdjustment / 100);

    // Re-express adjusted COGS as a share of the (now larger/smaller) revenue.
    const effectiveCogsPercent =
      (adjustedCogsPercent * BASELINE.monthlyRevenue) / adjustedRevenue;

    const marginPercent = Math.max(0, 100 - effectiveCogsPercent);
    const monthlyProfit = adjustedRevenue * (marginPercent / 100);

    const baselineMarginPercent = 100 - BASELINE.cogsPercent;
    const baselineProfit = BASELINE.monthlyRevenue * (baselineMarginPercent / 100);
    const profitDelta = monthlyProfit - baselineProfit;

    return {
      marginPercent,
      monthlyProfit,
      baselineMarginPercent,
      baselineProfit,
      profitDelta,
    };
  }, [supplyCostIncrease, priceAdjustment]);

  const isMarginDown = projection.marginPercent < projection.baselineMarginPercent;

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 sm:p-8">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-stone-100 text-stone-600">
          <SlidersIcon className="h-4.5 w-4.5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-stone-800">Scenario Simulation</h2>
          <p className="mt-0.5 text-xs text-stone-500">
            Drag the levers below to see how costs and pricing affect margin.
          </p>
        </div>
      </div>

      {/* Sliders */}
      <div className="mt-6 space-y-6">
        <EarthSlider
          id="supplyCostIncrease"
          label="Supply chain cost increase"
          value={supplyCostIncrease}
          min={0}
          max={50}
          step={1}
          unit="%"
          onChange={setSupplyCostIncrease}
          accent={EARTH.terracotta}
        />
        <EarthSlider
          id="priceAdjustment"
          label="Retail price adjustment"
          value={priceAdjustment}
          min={-20}
          max={20}
          step={1}
          unit="%"
          onChange={setPriceAdjustment}
          accent={EARTH.sage}
        />
      </div>

      <div className="my-6 h-px bg-stone-200" />

      {/* Live projection readout */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl bg-stone-50 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
            Projected Net Margin
          </p>
          <p className="mt-1.5 text-2xl font-semibold text-stone-800">
            {projection.marginPercent.toFixed(1)}%
          </p>
          <p className="mt-1 flex items-center gap-1 text-xs text-stone-500">
            {isMarginDown && <TrendDownIcon className="h-3.5 w-3.5" style={{ color: EARTH.terracotta }} />}
            baseline {projection.baselineMarginPercent.toFixed(1)}%
          </p>
        </div>

        <div className="rounded-xl bg-stone-50 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
            Projected Monthly Profit
          </p>
          <p className="mt-1.5 text-2xl font-semibold text-stone-800">
            {projection.monthlyProfit.toLocaleString(undefined, {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 0,
            })}
          </p>
          <p
            className="mt-1 text-xs font-medium"
            style={{ color: projection.profitDelta >= 0 ? EARTH.sage : EARTH.terracotta }}
          >
            {projection.profitDelta >= 0 ? '+' : ''}
            {projection.profitDelta.toLocaleString(undefined, {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 0,
            })}{' '}
            vs baseline
          </p>
        </div>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-stone-400">
        Simulation uses a simple cost-and-price model against your current
        baseline cost of goods sold — a directional estimate, not a forecast.
      </p>

      {/* Scoped slider thumb styling — Tailwind utilities can't reach
          ::-webkit-slider-thumb / ::-moz-range-thumb directly. */}
      <style>{`
        .earth-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 6px;
          border-radius: 9999px;
          outline: none;
          cursor: pointer;
        }
        .earth-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          height: 18px;
          width: 18px;
          border-radius: 9999px;
          background: var(--thumb-color, ${EARTH.terracotta});
          border: 2px solid #ffffff;
          box-shadow: 0 1px 3px rgba(68, 64, 60, 0.35);
          transition: transform 150ms ease;
        }
        .earth-slider::-webkit-slider-thumb:hover {
          transform: scale(1.1);
        }
        .earth-slider::-moz-range-thumb {
          height: 18px;
          width: 18px;
          border-radius: 9999px;
          background: var(--thumb-color, ${EARTH.terracotta});
          border: 2px solid #ffffff;
          box-shadow: 0 1px 3px rgba(68, 64, 60, 0.35);
          cursor: pointer;
          transition: transform 150ms ease;
        }
        .earth-slider::-moz-range-thumb:hover {
          transform: scale(1.1);
        }
        .earth-slider::-moz-range-track {
          background: transparent;
        }
      `}</style>
    </div>
  );
};

// ----------------------------------------------------------------------------
// ManagerAnalytics — top-level export
// ----------------------------------------------------------------------------

const ManagerAnalytics = () => (
  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
    <AnomalyDetectionPanel />
    <ScenarioSimulationPanel />
  </div>
);

export default ManagerAnalytics;