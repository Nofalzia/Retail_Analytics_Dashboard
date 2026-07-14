import React, { useMemo, useState } from 'react';
import { EmptyState } from '../layout/DashboardShell';
import { useDesignTokens } from '../../context/ThemeContext';
import { INITIAL_ALERTS } from './StoreManagerDashboard';
import { PRODUCTS, getUrgencyTier } from './StockoutPrediction';

/**
 * RecommendationsPanel — rule-based engine that translates anomalies
 * (StoreManagerDashboard) and low-stock signals (StockoutPrediction) into
 * plain-language actions. Every recommendation traces back to a source
 * number the shop owner already recognizes — no unexplained scores.
 */

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const ArrowRightIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <path d="M4 12h15" />
    <path d="M13 6l6 6-6 6" />
  </svg>
);

const CheckIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <path d="M5 12.5 9.5 17 19 6.5" />
  </svg>
);

// Priority ranking: lower number = surfaced first. Anomaly severity and
// stockout urgency are mapped onto the same 3-tier scale so both sources
// can be sorted into a single list.
const PRIORITY_RANK = { critical: 0, warning: 1, healthy: 2 };

const buildRecommendations = () => {
  const fromAlerts = INITIAL_ALERTS.map((alert) => ({
    id: `rec-alert-${alert.id}`,
    tier: alert.severity.toLowerCase(),
    action: `Investigate: ${alert.title}`,
    detail: alert.description,
    sourceLabel: alert.metricLabel,
    sourceValue: alert.metricValue,
  }));

  const fromStockouts = PRODUCTS.map((product) => {
    const daysRemaining = product.currentStock / product.avgDailySales;
    const tier = getUrgencyTier(daysRemaining);
    return {
      id: `rec-stock-${product.id}`,
      tier,
      action: `Reorder: ${product.name}`,
      detail: `At current sales pace, stock runs out in ${daysRemaining.toFixed(1)} days.`,
      sourceLabel: 'Days of inventory left',
      sourceValue: `${daysRemaining.toFixed(1)} days`,
    };
  }).filter((rec) => rec.tier !== 'healthy'); // healthy stock needs no action

  return [...fromAlerts, ...fromStockouts].sort(
    (a, b) => PRIORITY_RANK[a.tier] - PRIORITY_RANK[b.tier]
  );
};

const RecommendationCard = ({ recommendation, onAcknowledge, isAcknowledged }) => {
  const { ALERT_SURFACE, CARD_SURFACE, PALETTE, PANEL_SURFACE } = useDesignTokens();
  const styles = ALERT_SURFACE[recommendation.tier] ?? ALERT_SURFACE.warning;

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
        <ArrowRightIcon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <span
          className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
          style={{ backgroundColor: styles.backgroundColor, color: PALETTE.charcoalMuted }}
        >
          {recommendation.tier}
        </span>
        <h3 className="mt-2 text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
          {recommendation.action}
        </h3>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: PALETTE.charcoalMuted }}>
          {recommendation.detail}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
            <span className="font-medium" style={{ color: PALETTE.charcoal }}>
              {recommendation.sourceLabel}:
            </span>{' '}
            {recommendation.sourceValue}
          </p>
          <button
            type="button"
            onClick={() => onAcknowledge(recommendation.id)}
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
            {isAcknowledged ? 'Done' : 'Mark done'}
          </button>
        </div>
      </div>
    </div>
  );
};

const RecommendationsPanel = ({ hasData = true }) => {
  const { PALETTE } = useDesignTokens();
  const [doneIds, setDoneIds] = useState(() => new Set());
  const recommendations = useMemo(() => buildRecommendations(), []);
  const openCount = recommendations.length - doneIds.size;

  if (!hasData) {
    return (
      <EmptyState
        title="No recommendations yet"
        description="Once alerts and stock levels start coming in, we'll surface prioritized, plain-language actions here."
      />
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
            Recommendations
          </h2>
          <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
            Plain-language actions, prioritized from your alerts and stock levels.
          </p>
        </div>
        <span className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
          {openCount} open
        </span>
      </div>
      <div className="space-y-3">
        {recommendations.map((rec) => (
          <RecommendationCard
            key={rec.id}
            recommendation={rec}
            onAcknowledge={(id) => setDoneIds((prev) => new Set(prev).add(id))}
            isAcknowledged={doneIds.has(rec.id)}
          />
        ))}
      </div>
    </div>
  );
};

export default RecommendationsPanel;