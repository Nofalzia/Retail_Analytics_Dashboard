import React, { useMemo } from 'react';
import { EmptyState } from '../layout/DashboardShell';
import { useDesignTokens } from '../../context/ThemeContext';

/**
 * StockoutPrediction — "Days of Inventory Left" bento grid.
 * Every card traces back to a number the shop owner recognizes (current
 * stock, average daily sales) — no unexplained scores, per product vision.
 * Uses simple depletion-rate math: daysRemaining = currentStock / avgDailySales.
 */

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const BoxIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <path d="M3.5 8 12 4l8.5 4" />
    <path d="M3.5 8v8L12 20l8.5-4V8" />
    <path d="M3.5 8 12 12l8.5-4" />
    <path d="M12 12v8" />
  </svg>
);

// Depletion curve inputs — currentStock and avgDailySales are the two
// numbers a shop owner already recognizes from their own stock room.
export const PRODUCTS = [
  { id: 'sku-1', name: 'Basmati Rice 5kg', category: 'Staples', currentStock: 18, avgDailySales: 6 },
  { id: 'sku-2', name: 'Cooking Oil 1L', category: 'Staples', currentStock: 42, avgDailySales: 5 },
  { id: 'sku-3', name: 'Tea Leaves 400g', category: 'Beverages', currentStock: 9, avgDailySales: 4.5 },
  { id: 'sku-4', name: 'Wheat Flour 10kg', category: 'Staples', currentStock: 65, avgDailySales: 7 },
  { id: 'sku-5', name: 'Soft Drinks 1.5L', category: 'Beverages', currentStock: 24, avgDailySales: 22 },
  { id: 'sku-6', name: 'Detergent Powder 1kg', category: 'Household', currentStock: 30, avgDailySales: 3 },
];

// Urgency thresholds — documented here so the "how did you tune this"
// question (Phase 5 methodology) has a clear, defensible answer.
export const URGENCY = {
  critical: { maxDays: 3, label: 'Reorder now' },
  warning: { maxDays: 7, label: 'Reorder soon' },
  healthy: { maxDays: Infinity, label: 'Healthy' },
};

export const getUrgencyTier = (daysRemaining) => {
  if (daysRemaining <= URGENCY.critical.maxDays) return 'critical';
  if (daysRemaining <= URGENCY.warning.maxDays) return 'warning';
  return 'healthy';
};

const StockoutCard = ({ product }) => {
  const { CARD_SURFACE, INSET_SURFACE, PALETTE, EARTH } = useDesignTokens();

  const daysRemaining = useMemo(
    () => product.currentStock / product.avgDailySales,
    [product.currentStock, product.avgDailySales]
  );
  const tier = getUrgencyTier(daysRemaining);

  const tierColor = {
    critical: EARTH.terracotta,
    warning: EARTH.ochre,
    healthy: EARTH.sage,
  }[tier];

  const tierSoft = {
    critical: EARTH.terracottaSoft,
    warning: EARTH.ochreSoft,
    healthy: EARTH.sageSoft,
  }[tier];

  // Progress bar fills toward 100% as days-remaining shrinks toward 0 —
  // capped at a 14-day horizon so the bar has a meaningful full state.
  const HORIZON_DAYS = 14;
  const fillPercent = Math.max(0, Math.min(100, 100 - (daysRemaining / HORIZON_DAYS) * 100));

  return (
    <div className="rounded-xl p-5 transition-shadow duration-200 ease-out" style={CARD_SURFACE}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: tierSoft, color: tierColor }}
          >
            <BoxIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
              {product.name}
            </h3>
            <p className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
              {product.category}
            </p>
          </div>
        </div>
        <span
          className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
          style={{ backgroundColor: tierSoft, color: tierColor }}
        >
          {URGENCY[tier].label}
        </span>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-bold tracking-tight" style={{ color: PALETTE.charcoal }}>
            {daysRemaining.toFixed(1)}
          </span>
          <span className="text-xs" style={{ color: PALETTE.charcoalMuted }}>
            days of inventory left
          </span>
        </div>

        <div
          className="mt-2.5 h-2 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: INSET_SURFACE.backgroundColor }}
        >
          <div
            className="h-full rounded-full transition-all duration-300 ease-out"
            style={{ width: `${fillPercent}%`, backgroundColor: tierColor }}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs" style={{ color: PALETTE.charcoalMuted }}>
        <span>
          <span className="font-medium" style={{ color: PALETTE.charcoal }}>
            {product.currentStock}
          </span>{' '}
          units in stock
        </span>
        <span>
          <span className="font-medium" style={{ color: PALETTE.charcoal }}>
            {product.avgDailySales}
          </span>{' '}
          sold/day avg
        </span>
      </div>
    </div>
  );
};

const StockoutPrediction = ({ hasData = true }) => {
  const { PALETTE } = useDesignTokens();

  const sortedProducts = useMemo(
    () =>
      [...PRODUCTS].sort(
        (a, b) => a.currentStock / a.avgDailySales - b.currentStock / b.avgDailySales
      ),
    []
  );

  if (!hasData) {
    return (
      <EmptyState
        title="No stock levels to watch yet"
        description="Upload your product and inventory data to start tracking depletion rates and stockout risk."
      />
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
          Stockout Watch
        </h2>
        <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
          Estimated days of inventory left, based on your current stock and average daily sales.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {sortedProducts.map((product) => (
          <StockoutCard key={product.id} product={product} />
        ))}
      </div>
    </div>
  );
};

export default StockoutPrediction;