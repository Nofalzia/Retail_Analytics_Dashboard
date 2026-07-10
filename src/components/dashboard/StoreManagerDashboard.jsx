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

const SEVERITY_STYLES = {
  Critical: {
    borderColor: ALERT_SURFACE.critical.borderColor,
    badgeBg: ALERT_SURFACE.critical.backgroundColor,
    iconBg: ALERT_SURFACE.critical.backgroundColor,
    textColor: PALETTE.charcoalMuted,
  },
  Warning: {
    borderColor: ALERT_SURFACE.warning.borderColor,
    badgeBg: ALERT_SURFACE.warning.backgroundColor,
    iconBg: ALERT_SURFACE.warning.backgroundColor,
    textColor: PALETTE.charcoalMuted,
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
  const { ALERT_SURFACE, CARD_SURFACE, PALETTE } = useDesignTokens();
  const styles = ALERT_SURFACE[alert.severity];
  const borderAccent = alert.severity === 'Critical' ? '#DC2626' : '#B8863B';

  return (
    <div
      className={`flex gap-4 rounded-xl p-5 transition-all duration-200 ease-out ${
        isAcknowledged ? 'opacity-50' : 'opacity-100'
      }`}
      style={{ ...CARD_SURFACE, borderLeft: `4px solid ${borderAccent}` }}
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: styles.iconBg, color: styles.textColor }}
      >
        <AlertIcon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: styles.badgeBg, color: styles.textColor }}
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
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200/80 transition-all duration-150 ease-out disabled:cursor-default disabled:opacity-70 disabled:hover:bg-stone-100"
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
  const { CARD_SURFACE, PALETTE, PANEL_SURFACE } = useDesignTokens();
  const [acknowledgedIds, setAcknowledgedIds] = useState(() => new Set());
  const openCount = INITIAL_ALERTS.length - acknowledgedIds.size;

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
        {INITIAL_ALERTS.map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onAcknowledge={(id) => setAcknowledgedIds((prev) => new Set(prev).add(id))}
            isAcknowledged={acknowledgedIds.has(alert.id)}
          />
        ))}
      </div>
    </div>
  );
};

const EarthSlider = ({ id, label, value, min, max, step, unit, onChange, accent }) => {
  const percent = ((value - min) / (max - min)) * 100;

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
          className="shrink-0 rounded-full px-3 py-1 text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200/80 transition-all duration-150 ease-out"
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
        <div className="rounded-xl border border-stone-100 bg-white p-4" style={{ backgroundColor: '#FFFFFF', border: '1px solid rgba(120, 113, 104, 0.16)', boxShadow: '0 1px 3px rgba(0,0,0,0.02)' }}>
          <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">
            Projected Net Margin
          </p>
          <p className="mt-1.5 text-3xl font-bold tracking-tight text-stone-900">
            {projection.marginPercent.toFixed(1)}%
          </p>
          <p className="mt-1 flex items-center gap-1 text-xs text-stone-500">
            {isMarginDown && (
              <TrendDownIcon className="h-3.5 w-3.5" style={{ color: EARTH.terracotta }} />
            )}
            baseline {projection.baselineMarginPercent.toFixed(1)}%
          </p>
        </div>
        <div className="rounded-xl border border-stone-100 bg-white p-4" style={{ backgroundColor: '#FFFFFF', border: '1px solid rgba(120, 113, 104, 0.16)', boxShadow: '0 1px 3px rgba(0,0,0,0.02)' }}>
          <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">
            Projected Monthly Profit
          </p>
          <div className="mt-1.5">
            <CurrencyFigure amount={projection.monthlyProfit} />
          </div>
          <p className="mt-1 text-xs font-medium text-stone-500">
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
