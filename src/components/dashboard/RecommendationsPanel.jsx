import React, { useEffect, useMemo, useState } from 'react';
import { EmptyState, formatLocalCurrency } from '../layout/DashboardShell';
import { useDesignTokens } from '../../context/ThemeContext';
import { api } from '../../api/client.js';
import ApiErrorNotice, { LoadingState } from '../ApiErrorNotice';
import { INITIAL_ALERTS, STRUGGLING_ALERTS } from './StoreManagerDashboard';
import { PRODUCTS, STRUGGLING_PRODUCTS, getUrgencyTier } from './StockoutPrediction';

/**
 * RecommendationsPanel — plain-language actions for the store manager.
 *
 * dataMode === 'live'       → real, rule-based recommendations from
 *                             GET /api/recommendations (server already sorted
 *                             by priority DESC). Never falls back to mocks.
 * dataMode === 'struggling' → mock recommendations derived from the struggling
 * dataMode === 'healthy'     →   alert + product sets (unchanged demo behaviour)
 *
 * Every recommendation traces back to a source number the shop owner already
 * recognizes — no unexplained scores.
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
const PRIORITY_RANK = { critical: 0, warning: 1, info: 1, healthy: 2 };

const buildRecommendations = (alerts, products) => {
  const fromAlerts = alerts.map((alert) => ({
    id: `rec-alert-${alert.id}`,
    tier: (alert.severity || 'warning').toLowerCase(),
    action: `Investigate: ${alert.title}`,
    detail: alert.description,
    sourceLabel: alert.metricLabel,
    sourceValue: alert.metricValue,
  }));

  const fromStockouts = products.map((product) => {
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
    (a, b) => (PRIORITY_RANK[a.tier] ?? 99) - (PRIORITY_RANK[b.tier] ?? 99)
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
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
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

// ── Live recommendation helpers ──────────────────────────────────────────────

// Demo store ID — matches the seed data and the other live panels.
const DEMO_STORE_ID = '00000000-0000-0000-0000-000000000010';

// Human labels for the engine's `rec_type` codes.
const REC_TYPE_LABELS = {
  reorder:      'Reorder',
  low_stock:    'Low stock',
  sales_drop:   'Sales drop',
  demand_surge: 'Demand surge',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Turns an ISO due date into a plain-language deadline label. */
const dueDateLabel = (dueDate) => {
  if (!dueDate) return null;
  const due = new Date(`${String(dueDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / DAY_MS);
  if (days < 0)   return 'Overdue';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
};

// Priority 1 (most urgent) → 10 (least). The pill shifts hue smoothly from
// terracotta through ochre to sage as urgency eases — existing tokens only.
const getPriorityTone = (priority, EARTH) => {
  if (priority <= 3) return { word: 'High',   color: EARTH.terracotta, soft: EARTH.terracottaSoft };
  if (priority <= 6) return { word: 'Medium', color: EARTH.ochre,      soft: EARTH.ochreSoft };
  return             { word: 'Low',    color: EARTH.sage,       soft: EARTH.sageSoft };
};

/** A single live recommendation card. */
const LiveRecommendationCard = ({ rec, onComplete, isPending, error }) => {
  const { CARD_SURFACE, PALETTE, PANEL_SURFACE, EARTH } = useDesignTokens();

  const priority    = Number(rec.priority) || 5;
  const tone        = getPriorityTone(priority, EARTH);
  const due         = dueDateLabel(rec.due_date);
  const atRisk      = Number(rec.revenue_at_risk) > 0 ? formatLocalCurrency(rec.revenue_at_risk) : null;
  const hasQuantity = rec.suggested_quantity != null && Number(rec.suggested_quantity) > 0;
  const recType     = REC_TYPE_LABELS[rec.rec_type] ?? 'Action';

  return (
    <div
      className="flex gap-4 rounded-xl p-5 transition-all duration-200 ease-out"
      style={{
        ...CARD_SURFACE,
        borderLeft: `4px solid ${tone.color}`,
        opacity: isPending ? 0.6 : 1,
      }}
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: tone.soft, color: tone.color }}
      >
        <ArrowRightIcon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors duration-300"
            style={{ backgroundColor: tone.soft, color: tone.color }}
          >
            {tone.word} · {priority}
          </span>
          <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: PALETTE.charcoalMuted }}>
            {recType}
          </span>
          {due && (
            <span className="text-[11px]" style={{ color: PALETTE.charcoalMuted }}>
              · {due}
            </span>
          )}
        </div>

        <h3 className="mt-2 text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
          {rec.title}
        </h3>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: PALETTE.charcoalMuted }}>
          {rec.body}
        </p>

        {(hasQuantity || atRisk) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {hasQuantity && (
              <span
                className="rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: PANEL_SURFACE.backgroundColor, color: PALETTE.charcoalMuted }}
              >
                Order about {Math.round(Number(rec.suggested_quantity))} units
              </span>
            )}
            {atRisk && (
              <span
                className="rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: PANEL_SURFACE.backgroundColor, color: PALETTE.charcoalMuted }}
              >
                {atRisk.prefix} {atRisk.value} at risk
              </span>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
          <p
            className="text-xs"
            aria-live="polite"
            style={{ color: error ? EARTH.terracotta : PALETTE.charcoalMuted }}
          >
            {error || (rec.product_name ? `For ${rec.product_name}` : '')}
          </p>
          <button
            type="button"
            onClick={() => onComplete(rec.id)}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ease-out disabled:cursor-default disabled:opacity-70"
            style={{ backgroundColor: PANEL_SURFACE.backgroundColor, color: PALETTE.charcoalMuted }}
            onMouseEnter={(e) => {
              if (!isPending) e.currentTarget.style.backgroundColor = PALETTE.bottleGreenSoft;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = PANEL_SURFACE.backgroundColor;
            }}
          >
            <CheckIcon className="h-3.5 w-3.5" />
            {isPending ? 'Working…' : 'Mark done'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Non-live "done" persistence ───────────────────────────────────────────────
// Marking a mock recommendation done should stick, so we keep the ids in
// localStorage under one key per data mode: a tab switch or a refresh no longer
// resurrects them. Live mode persists server-side instead (PATCH …/complete).
const MOCK_DONE_KEY_PREFIX = 'rad_mock_recs_done';

const readMockDoneIds = (mode) => {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(`${MOCK_DONE_KEY_PREFIX}:${mode}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    /* Missing, unreadable or corrupt entry — treat as nothing done yet. */
    return new Set();
  }
};

const writeMockDoneIds = (mode, ids) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${MOCK_DONE_KEY_PREFIX}:${mode}`, JSON.stringify([...ids]));
  } catch {
    /* Storage blocked or full — the mark simply won't survive a reload. */
  }
};

const RecommendationsPanel = ({ hasData = true, dataMode = 'live' }) => {
  const { PALETTE } = useDesignTokens();
  const isLive = dataMode === 'live';

  // ── Mock (non-live) state — "done" marks persist per data mode ──
  const [doneIds, setDoneIds] = useState(() => readMockDoneIds(dataMode));

  // ── Live state ──
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(isLive);
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [actionErrors, setActionErrors] = useState(() => new Map());

  // Fetch on mount and whenever the data mode changes. Live mode never falls
  // back to mocks: a failure shows the error notice, an empty success shows the
  // calm all-clear state, a pending request shows the loading placeholder.
  useEffect(() => {
    if (!isLive) return undefined;
    setLoading(true);
    setLoadError(false);
    api.getRecommendations({ storeId: DEMO_STORE_ID })
      .then(({ recommendations: apiRecs }) => {
        setItems(Array.isArray(apiRecs) ? apiRecs : []);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
    return undefined;
  }, [isLive, dataMode, retryTick]);

  // Re-read the active mode's saved marks when the demo mode changes (for
  // example on the way back from live), so each mode keeps its own done list.
  useEffect(() => {
    if (!isLive) setDoneIds(readMockDoneIds(dataMode));
  }, [isLive, dataMode]);

  // Mock lists that match the active data mode.
  const activeAlerts   = dataMode === 'struggling' ? STRUGGLING_ALERTS  : INITIAL_ALERTS;
  const activeProducts = dataMode === 'struggling' ? STRUGGLING_PRODUCTS : PRODUCTS;

  const mockRecs = useMemo(
    () => buildRecommendations(activeAlerts, activeProducts),
    [activeAlerts, activeProducts]
  );
  // Count against the current list (not the raw set size) so a stale persisted
  // id can never push the open count below zero.
  const openCount = mockRecs.filter((rec) => !doneIds.has(rec.id)).length;

  const complete = async (id) => {
    setPendingIds((prev) => new Set(prev).add(id));
    setActionErrors((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });

    try {
      await api.completeRecommendation(id);
      // Optimistic removal: drop the card locally instead of re-fetching the
      // list. A refresh confirms it is gone server-side.
      setItems((prev) => prev.filter((rec) => rec.id !== id));
    } catch (err) {
      // Failure: keep the card and show a calm inline message.
      setActionErrors((prev) => {
        const next = new Map(prev);
        next.set(
          id,
          err.status === 403
            ? 'Only managers and owners can do this.'
            : "Couldn't complete this recommendation. Please try again.",
        );
        return next;
      });
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Non-live "Mark done": record it locally and persist it, so navigating away
  // or refreshing no longer brings the recommendation back.
  const handleMockAcknowledge = (id) => {
    const next = new Set(doneIds);
    next.add(id);
    setDoneIds(next);
    writeMockDoneIds(dataMode, next);
  };

  if (!hasData) {
    return (
      <EmptyState
        title="No recommendations yet"
        description="Once alerts and stock levels start coming in, we'll surface prioritized, plain-language actions here."
      />
    );
  }

  // ── Live mode: real data only — never mocks ──
  if (isLive) {
    if (loadError) {
      return <ApiErrorNotice onRetry={() => setRetryTick((t) => t + 1)} />;
    }
    if (loading) {
      return <LoadingState label="Loading recommendations…" />;
    }
    if (items.length === 0) {
      return (
        <EmptyState
          title="Nothing needs your attention right now"
          description="Your stock levels and sales trends look steady. New actions will appear here the moment something needs a look."
        />
      );
    }

    const totalAtRisk = items.reduce((sum, rec) => sum + (Number(rec.revenue_at_risk) || 0), 0);
    const atRiskLabel = totalAtRisk > 0 ? formatLocalCurrency(totalAtRisk) : null;

    return (
      <div>
        <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
              Recommendations
            </h2>
            <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
              Plain-language actions, prioritized from your alerts and stock levels.
            </p>
          </div>
          <span className="shrink-0 text-xs" style={{ color: PALETTE.charcoalMuted }}>
            {items.length} {items.length === 1 ? 'action' : 'actions'} waiting
            {atRiskLabel && <> · {atRiskLabel.prefix} {atRiskLabel.value} at risk</>}
          </span>
        </div>
        <div className="space-y-3">
          {items.map((rec) => (
            <LiveRecommendationCard
              key={rec.id}
              rec={rec}
              onComplete={complete}
              isPending={pendingIds.has(rec.id)}
              error={actionErrors.get(rec.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  // ── Mock modes (struggling / healthy) — original behaviour, unchanged ──
  return (
    <div>
      {/* Header — stacks on mobile, side-by-side on sm+ */}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
            Recommendations
          </h2>
          <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
            Plain-language actions, prioritized from your alerts and stock levels.
          </p>
        </div>
        <span className="shrink-0 text-xs" style={{ color: PALETTE.charcoalMuted }}>
          {openCount} open
        </span>
      </div>
      <div className="space-y-3">
        {mockRecs.map((rec) => (
          <RecommendationCard
            key={rec.id}
            recommendation={rec}
            onAcknowledge={handleMockAcknowledge}
            isAcknowledged={doneIds.has(rec.id)}
          />
        ))}
      </div>
    </div>
  );
};

export default RecommendationsPanel;