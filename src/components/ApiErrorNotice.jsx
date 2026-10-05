/**
 * src/components/ApiErrorNotice.jsx
 * ──────────────────────────────────────────────────────────────────────────────
 * Shared feedback surfaces for live data views.
 *
 * ApiErrorNotice — calm, warm error card shown when a live API call fails.
 *   Rendered INSTEAD of mock data so the UI never passes fake numbers off as
 *   real while the backend is unreachable. Uses the ALERT_SURFACE warning
 *   (ochre) tokens with a bottle-green Retry action.
 *
 * LoadingState — minimal in-flight placeholder shown while a live fetch is
 *   pending, so we never flash an empty state (or mock data) during a request.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { useDesignTokens } from '../context/ThemeContext';

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const AlertTriangleIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M12 4 21 19.5H3L12 4Z" />
    <circle cx="12" cy="14" r="2.75" />
  </svg>
);

export default function ApiErrorNotice({
  onRetry,
  message = "We couldn't reach your store data. Please try again.",
}) {
  const { ALERT_SURFACE, CARD_SURFACE, PALETTE } = useDesignTokens();
  const alertSurface = ALERT_SURFACE.warning;

  return (
    <div
      className="flex min-h-[240px] items-center justify-center rounded-xl p-8 text-center sm:p-10"
      style={{
        ...CARD_SURFACE,
        borderLeft: `4px solid ${alertSurface.borderColor}`,
      }}
    >
      <div className="max-w-md">
        <span
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl"
          style={{
            backgroundColor: alertSurface.backgroundColor,
            color: alertSurface.borderColor,
          }}
        >
          <AlertTriangleIcon className="h-6 w-6" />
        </span>
        <p className="mt-5 text-sm leading-relaxed" style={{ color: PALETTE.charcoal }}>
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors duration-150"
          style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = PALETTE.bottleGreenHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = PALETTE.bottleGreen;
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

/** Minimal in-flight placeholder — avoids flashing empty states during loads. */
export function LoadingState({ label = 'Loading store data…' }) {
  const { CARD_SURFACE, PALETTE } = useDesignTokens();

  return (
    <div
      className="flex min-h-[240px] items-center justify-center rounded-xl p-8"
      style={CARD_SURFACE}
    >
      <p className="text-sm" style={{ color: PALETTE.charcoalMuted }}>
        <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        {label}
      </p>
    </div>
  );
}