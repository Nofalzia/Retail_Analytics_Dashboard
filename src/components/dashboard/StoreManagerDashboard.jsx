import React, { useMemo, useState } from 'react';
import {
  AdminRestrictedAccess,
  formatLocalCurrency,
} from '../layout/DashboardShell';
import { useDesignTokens } from '../../context/ThemeContext';

/**
 * StoreManagerDashboard — Manager & in-depth analytics scaffold.
 * Reads `activeRole` from DashboardShell, gates financial/simulation views
 * for System Administrators, and exposes a baseline slider reset control.
 */

const BASELINE_SLIDER_VALUES = {
  supplyCostIncrease: 0,
  priceAdjustment: 0,
};

const ALERT_DISPLAY_CAP = 5;

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

// All icon primitives now accept an optional `style` prop and forward it —
// previously `style` was silently dropped, so per-instance icon coloring
// (e.g. the terracotta trend-down icon) never actually rendered.
const CheckIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <path d="M5 12.5 9.5 17 19 6.5" />
  </svg>
);

const SlidersIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
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

const TrendDownIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <path d="M4 8 9.5 13.5 13.5 9.5 20 16" />
    <path d="M14.5 16H20v-5.5" />
  </svg>
);

// Severity icons are shape-distinct, not just color-distinct — a triangle
// with a dot (Critical) vs. a plain circle (Warning) reads correctly for
// colorblind users even if the accent hue is hard to tell apart.
const CriticalIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <path d="M12 4 21 19.5H3L12 4Z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="16.8" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

const WarningIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v5" />
  </svg>
);

const CheckAllIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <circle cx="12" cy="12" r="8" />
    <path d="M8.5 12.3 11 14.8 15.5 9.8" />
  </svg>
);

export const INITIAL_ALERTS = [
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

const CurrencyFigure = ({ amount, size = 'md' }) => {
  const { PALETTE } = useDesignTokens();
  const { prefix, value } = formatLocalCurrency(amount);
  const sizeClass = size === 'md' ? 'text-2xl' : 'text-base';

  return (
    <p className={`${sizeClass} tracking-tight`} style={{ color: PALETTE.charcoal }}>
      <span className="mr-1 font-medium opacity-55">{prefix}</span>
      <span className="font-semibold">{value}</span>
    </p>
  );
};

const AlertCard = ({ alert, onAcknowledge, isAcknowledged }) => {
  const { ALERT_SURFACE, CARD_SURFACE, PALETTE, PANEL_SURFACE } = useDesignTokens();
  const styles = ALERT_SURFACE[alert.severity.toLowerCase()];
  const SeverityIcon = alert.severity === 'Critical' ? CriticalIcon : WarningIcon;

  return (
    <div
      className={`flex gap-4 rounded-xl p-5 transition-all duration-200 ease-out ${
        isAcknowledged ? 'opacity-50' : 'opacity-100'
      }`}
      style={{ ...CARD_SURFACE, borderLeft: `4px solid ${styles.borderColor}` }}
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: styles.backgroundColor, color: PALETTE.charcoalMuted }}
      >
        <SeverityIcon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: styles.backgroundColor, color: PALETTE.charcoalMuted }}
          >
            {alert.severity}
          </span>
          <span className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
            {alert.timestamp}
          </span>
        </div>
        <h3 className="mt-2 text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
          {alert.title}
        </h3>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: PALETTE.charcoalMuted }}>
          {alert.description}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
            <span className="font-medium" style={{ color: PALETTE.charcoal }}>
              {alert.metricLabel}:
            </span>{' '}
            {alert.metricValue}
          </p>
          <button
            type="button"
            onClick={() => onAcknowledge(alert.id)}
            disabled={isAcknowledged}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ease-out disabled:cursor-default disabled:opacity-70"
            style={{ backgroundColor: PANEL_SURFACE.backgroundColor, color: PALETTE.charcoalMuted }}
            onMouseEnter={(e) => {
              if (!isAcknowledged) e.currentTarget.style.backgroundColor = PALETTE.bottleGreenSoft;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = PANEL_SURFACE.backgroundColor;
            }}
          >
            <CheckIcon className="h-3.5 w-3.5" />
            {isAcknowledged ? 'Acknowledged' : 'Acknowledge'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Shown once every alert has been acknowledged — previously the panel just
// left dimmed, opacity-50 cards on screen with no sense of closure.
const AllClearState = () => {
  const { PALETTE, theme } = useDesignTokens();
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl px-5 py-8 text-center">
      <span
        className="flex h-10 w-10 items-center justify-center rounded-full"
        style={{ backgroundColor: PALETTE.bottleGreenSoft, color: PALETTE.bottleGreen }}
      >
        <CheckAllIcon className="h-5 w-5" />
      </span>
      <p className="text-sm font-medium" style={{ color: PALETTE.charcoal }}>
        All caught up
      </p>
      <p className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
        No open threshold alerts right now.
      </p>
    </div>
  );
};

const AnomalyDetectionPanel = () => {
  const { CARD_SURFACE, PALETTE, PANEL_SURFACE } = useDesignTokens();
  const [acknowledgedIds, setAcknowledgedIds] = useState(() => new Set());
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const openCount = INITIAL_ALERTS.length - acknowledgedIds.size;

  const visibleAlerts = showAllAlerts
    ? INITIAL_ALERTS
    : INITIAL_ALERTS.slice(0, ALERT_DISPLAY_CAP);
  const hiddenCount = INITIAL_ALERTS.length - visibleAlerts.length;

  return (
    <div className="rounded-xl p-6 sm:p-8 transition-shadow duration-200 ease-out" style={CARD_SURFACE}>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
            Threshold Alerts
          </h2>
          <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
            Rule-based checks against your configured statistical thresholds.
          </p>
        </div>
        <span
          className="rounded-full px-3 py-1 text-xs font-medium"
          style={{ ...PANEL_SURFACE, color: PALETTE.charcoalMuted }}
        >
          {openCount} open
        </span>
      </div>
      <div className="mt-6 space-y-3">
        {openCount === 0 ? (
          <AllClearState />
        ) : (
          <>
            {visibleAlerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onAcknowledge={(id) => setAcknowledgedIds((prev) => new Set(prev).add(id))}
                isAcknowledged={acknowledgedIds.has(alert.id)}
              />
            ))}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAllAlerts(true)}
                className="w-full rounded-full px-3 py-2 text-xs font-medium transition-all duration-150 ease-out"
                style={{ backgroundColor: PANEL_SURFACE.backgroundColor, color: PALETTE.charcoalMuted }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = PALETTE.bottleGreenSoft;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = PANEL_SURFACE.backgroundColor;
                }}
              >
                Show {hiddenCount} more
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const EarthSlider = ({ id, label, value, min, max, step, unit, onChange, accent }) => {
  const percent = ((value - min) / (max - min)) * 100;
  const { PALETTE } = useDesignTokens();

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium" style={{ color: PALETTE.charcoalMuted }}>
          {label}
        </label>
        <span className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
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
        className="earth-slider mt-3 w-full transition duration-100 ease-out"
        style={{
          background: `linear-gradient(to right, ${accent} 0%, ${accent} ${percent}%, ${PALETTE.sand} ${percent}%, ${PALETTE.sand} 100%)`,
          '--thumb-color': accent,
        }}
      />
      <div className="mt-1.5 flex justify-between text-[11px]" style={{ color: PALETTE.charcoalMuted }}>
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

const BASELINE = {
  monthlyRevenue: 4218000,
  cogsPercent: 58,
};

const ScenarioSimulationPanel = () => {
  const { CARD_SURFACE, PALETTE, EARTH, INSET_SURFACE, PANEL_SURFACE } = useDesignTokens();
  const [supplyCostIncrease, setSupplyCostIncrease] = useState(BASELINE_SLIDER_VALUES.supplyCostIncrease);
  const [priceAdjustment, setPriceAdjustment] = useState(BASELINE_SLIDER_VALUES.priceAdjustment);

  const handleResetToBaseline = () => {
    setSupplyCostIncrease(BASELINE_SLIDER_VALUES.supplyCostIncrease);
    setPriceAdjustment(BASELINE_SLIDER_VALUES.priceAdjustment);
  };

  const projection = useMemo(() => {
    const adjustedCogsPercent = BASELINE.cogsPercent * (1 + supplyCostIncrease / 100);
    const adjustedRevenue = BASELINE.monthlyRevenue * (1 + priceAdjustment / 100);
    const effectiveCogsPercent =
      (adjustedCogsPercent * BASELINE.monthlyRevenue) / adjustedRevenue;
    const marginPercent = Math.max(0, 100 - effectiveCogsPercent);
    const monthlyProfit = adjustedRevenue * (marginPercent / 100);
    const baselineMarginPercent = 100 - BASELINE.cogsPercent;
    const baselineProfit = BASELINE.monthlyRevenue * (baselineMarginPercent / 100);

    return {
      marginPercent,
      monthlyProfit,
      baselineMarginPercent,
      profitDelta: monthlyProfit - baselineProfit,
    };
  }, [supplyCostIncrease, priceAdjustment]);

  const isMarginDown = projection.marginPercent < projection.baselineMarginPercent;
  const isMarginWipedOut = projection.marginPercent <= 0;
  const profitDeltaPositive = projection.profitDelta >= 0;

  return (
    <div className="rounded-xl p-6 sm:p-8 transition-shadow duration-200 ease-out" style={CARD_SURFACE}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ ...INSET_SURFACE, color: PALETTE.charcoal }}
          >
            <SlidersIcon className="h-4.5 w-4.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
              Scenario Simulation
            </h2>
            <p className="mt-0.5 text-xs" style={{ color: PALETTE.charcoalMuted }}>
              Drag the levers below to see how costs and pricing affect margin.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleResetToBaseline}
          className="shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ease-out"
          style={{ backgroundColor: PANEL_SURFACE.backgroundColor, color: PALETTE.charcoalMuted }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = PALETTE.bottleGreenSoft;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = PANEL_SURFACE.backgroundColor;
          }}
        >
          Reset to Base Tenant Baseline
        </button>
      </div>

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

      <div className="my-6 h-px" style={{ backgroundColor: PALETTE.sandBorder }} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl p-4" style={INSET_SURFACE}>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: PALETTE.charcoalMuted }}>
            Projected Net Margin
          </p>
          <p className="mt-1.5 text-3xl font-bold tracking-tight" style={{ color: PALETTE.charcoal }}>
            {projection.marginPercent.toFixed(1)}%
          </p>

          {isMarginWipedOut && (
            <p className="mt-2 text-xs font-medium" style={{ color: EARTH.terracotta }}>
              This combination would eliminate your margin entirely — consider a smaller price cut or cost increase.
            </p>
          )}

          <p className="mt-1 flex items-center gap-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
            {isMarginDown && (
              <TrendDownIcon className="h-3.5 w-3.5" style={{ color: EARTH.terracotta }} />
            )}
            baseline {projection.baselineMarginPercent.toFixed(1)}%
          </p>
        </div>
        <div className="rounded-xl p-4" style={INSET_SURFACE}>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: PALETTE.charcoalMuted }}>
            Projected Monthly Profit
          </p>
          <div className="mt-1.5">
            <CurrencyFigure amount={projection.monthlyProfit} />
          </div>
          <p className="mt-1 text-xs font-medium" style={{ color: PALETTE.charcoalMuted }}>
            <span style={{ color: profitDeltaPositive ? EARTH.sage : EARTH.terracotta }}>
              {profitDeltaPositive ? '+' : ''}
              {formatLocalCurrency(projection.profitDelta).prefix}{' '}
              {formatLocalCurrency(Math.abs(projection.profitDelta)).value}
            </span>{' '}
            vs baseline
          </p>
        </div>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed" style={{ color: PALETTE.charcoalMuted }}>
        Simulation uses a simple cost-and-price model against your current baseline cost of goods sold —
        a directional estimate, not a forecast.
      </p>

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
          transition: transform 100ms ease-out;
        }
        .earth-slider::-webkit-slider-thumb:hover { transform: scale(1.1); }
        .earth-slider::-webkit-slider-thumb:active { transform: scale(1.25); }
        .earth-slider::-moz-range-thumb {
          height: 18px;
          width: 18px;
          border-radius: 9999px;
          background: var(--thumb-color, ${EARTH.terracotta});
          border: 2px solid #ffffff;
          box-shadow: 0 1px 3px rgba(68, 64, 60, 0.35);
          cursor: pointer;
          transition: transform 100ms ease-out;
        }
        .earth-slider::-moz-range-thumb:hover { transform: scale(1.1); }
        .earth-slider::-moz-range-thumb:active { transform: scale(1.25); }
        .earth-slider::-moz-range-track { background: transparent; }
      `}</style>
    </div>
  );
};

const StoreManagerDashboard = ({ activeRole = 'Manager' }) => {
  if (activeRole === 'System Administrator') {
    return <AdminRestrictedAccess />;
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
      <AnomalyDetectionPanel />
      <ScenarioSimulationPanel />
    </div>
  );
};

export default StoreManagerDashboard;