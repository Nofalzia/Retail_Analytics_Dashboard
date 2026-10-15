/**
 * src/components/cashier/CashierWorkspace.jsx
 * ──────────────────────────────────────────────────────────────────────────────
 * The whole screen a data-entry account sees — no dashboards, no switchers.
 *
 * The API refuses dashboard reads for this role (T11a), so nothing here offers a
 * way to reach them: one sidebar item, one job. The wording is deliberately plain
 * English with a Roman Urdu line under it, and every figure on the summary card
 * comes from the real job roll-up (GET /api/upload/:jobId/summary).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React, { useRef, useState } from 'react';
import { useTheme, useDesignTokens } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { formatLocalCurrency } from '../layout/DashboardShell';
import { useSalesUpload } from '../../hooks/useSalesUpload.js';
import { describeDateRange, downloadTemplate } from '../../utils/salesUpload.js';

/** The three things a cashier has to do, each with its Roman Urdu line. */
const STEPS = [
  {
    id: 1,
    english: "Get today's sales file from your till (CSV or Excel).",
    urdu: 'Till se aaj ki sales ki file nikaalein (CSV ya Excel).',
  },
  {
    id: 2,
    english: 'Drop the file in the box below.',
    urdu: 'File ko neeche diye gaye box mein daalein.',
  },
  {
    id: 3,
    english: 'Wait for the green tick.',
    urdu: 'Hara nishaan (green tick) aane ka intezar karein.',
  },
];

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const UploadIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps} aria-hidden="true">
    <path d="M12 4v11" />
    <path d="M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 17.5v1.5A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
  </svg>
);

const TickIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.4 10.8 15.2 16 9.6" />
  </svg>
);

const StoreMarkIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps} aria-hidden="true">
    <path d="M4 9.5 5.2 4.5h13.6L20 9.5" />
    <path d="M4.5 9.5v9.5A1 1 0 0 0 5.5 20h13a1 1 0 0 0 1-1V9.5" />
    <path d="M9.5 20v-5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V20" />
  </svg>
);

// ----------------------------------------------------------------------------
// Step list — number, plain English line, Roman Urdu line
// ----------------------------------------------------------------------------

const StepRow = ({ step }) => {
  const { PALETTE } = useDesignTokens();

  return (
    <li className="flex items-start gap-3">
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
      >
        {step.id}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium" style={{ color: PALETTE.charcoal }}>
          {step.english}
        </p>
        <p className="mt-0.5 text-sm" style={{ color: PALETTE.charcoalMuted }}>
          {step.urdu}
        </p>
      </div>
    </li>
  );
};

// ----------------------------------------------------------------------------
// The one drop zone: a big button, an example file, no checklists or rings.
// ----------------------------------------------------------------------------

const UploadBox = ({ onPick }) => {
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) onPick(file);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className="flex flex-col items-center justify-center rounded-2xl px-6 py-12 text-center"
      style={
        isDragging
          ? { border: `2px dashed ${PALETTE.bottleGreen}`, backgroundColor: PALETTE.bottleGreenSoft }
          : { ...CARD_SURFACE, backgroundColor: theme.surface }
      }
    >
      <span
        className="flex h-14 w-14 items-center justify-center rounded-2xl"
        style={{ backgroundColor: PALETTE.bottleGreenSoft, color: PALETTE.bottleGreen }}
      >
        <UploadIcon className="h-7 w-7" />
      </span>
      <p className="mt-4 text-sm font-medium" style={{ color: PALETTE.charcoal }}>
        CSV or Excel file
      </p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-5 rounded-xl px-7 py-3.5 text-sm font-semibold transition-colors duration-150"
        style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = PALETTE.bottleGreenHover; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = PALETTE.bottleGreen; }}
      >
        Choose file
      </button>
      <button
        type="button"
        onClick={downloadTemplate}
        className="mt-3 text-xs font-medium underline"
        style={{ color: PALETTE.charcoalMuted }}
      >
        Download an example file
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onPick(file);
        }}
      />
    </div>
  );
};

// ----------------------------------------------------------------------------
// In-flight and finished states — friendly wording only, no codes
// ----------------------------------------------------------------------------

const ProgressCard = ({ rowsProcessed, totalRows }) => {
  const { CARD_SURFACE, PALETTE } = useDesignTokens();
  const percent = totalRows ? Math.min(100, Math.round((rowsProcessed / totalRows) * 100)) : 0;

  return (
    <div className="rounded-2xl p-8 text-center" style={CARD_SURFACE} role="status">
      <p className="text-base font-medium" style={{ color: PALETTE.charcoal }}>
        {totalRows ? `Reading your file… ${rowsProcessed} of ${totalRows} rows` : 'Reading your file…'}
      </p>
      <p className="mt-1 text-sm" style={{ color: PALETTE.charcoalMuted }}>
        Please keep this page open.
      </p>
      <div
        className="mt-5 h-1.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: PALETTE.sand }}
      >
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${percent}%`, backgroundColor: PALETTE.bottleGreen }}
        />
      </div>
    </div>
  );
};

const MessageCard = ({ message, onRetry }) => {
  const { CARD_SURFACE, PALETTE } = useDesignTokens();

  return (
    <div className="rounded-2xl p-8 text-center" style={CARD_SURFACE} role="alert">
      <p className="text-base font-medium" style={{ color: PALETTE.charcoal }}>
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 rounded-xl px-6 py-3 text-sm font-semibold transition-colors duration-150"
        style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = PALETTE.bottleGreenHover; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = PALETTE.bottleGreen; }}
      >
        Try again
      </button>
    </div>
  );
};

const Stat = ({ label, value }) => {
  const { INSET_SURFACE, PALETTE } = useDesignTokens();

  return (
    <div className="rounded-xl px-4 py-3" style={INSET_SURFACE}>
      <dt className="text-xs" style={{ color: PALETTE.charcoalMuted }}>{label}</dt>
      <dd className="mt-1 text-base font-semibold" style={{ color: PALETTE.charcoal }}>{value}</dd>
    </div>
  );
};

const SummaryCard = ({ summary, onUploadAnother, onSwitchUser }) => {
  const { CARD_SURFACE, EARTH, PALETTE } = useDesignTokens();
  const { prefix, value } = formatLocalCurrency(summary?.revenue ?? 0);
  const listed = Array.isArray(summary?.topItems) ? summary.topItems : [];
  const topItems = listed.slice(0, 3);
  const dateRange = summary ? describeDateRange(summary.dateFrom, summary.dateTo) : null;

  return (
    <div className="rounded-2xl p-8" style={CARD_SURFACE}>
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: EARTH.sageSoft, color: EARTH.sage }}
        >
          <TickIcon className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold" style={{ color: PALETTE.charcoal }}>
            All done — thank you!
          </h2>
          <p className="text-sm" style={{ color: PALETTE.charcoalMuted }}>
            Shukriya! Aaj ki sales record ho gayi.
          </p>
        </div>
      </div>

      {summary ? (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-4">
            <Stat label="Dates covered" value={dateRange ?? 'Not in the file'} />
            <Stat label="Items" value={(summary.itemsCount ?? 0).toLocaleString('en-PK')} />
            <Stat label="Units sold" value={(summary.unitsSold ?? 0).toLocaleString('en-PK')} />
            <Stat label="Total sales" value={`${prefix} ${value}`} />
          </dl>

          {topItems.length > 0 && (
            <div className="mt-6">
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: PALETTE.charcoalMuted }}>
                Top 3 sellers
              </p>
              <ul className="mt-2 space-y-1.5">
                {topItems.map((item) => (
                  <li key={item.name} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate" style={{ color: PALETTE.charcoal }}>{item.name}</span>
                    <span style={{ color: PALETTE.charcoalMuted }}>
                      {Number(item.units).toLocaleString('en-PK')} units
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="mt-6 text-sm" style={{ color: PALETTE.charcoalMuted }}>
          Your file was saved. We could not load the full details this time.
        </p>
      )}

      <p className="mt-6 text-sm" style={{ color: PALETTE.charcoal }}>
        Your manager can now see the results.
      </p>
      <p className="mt-0.5 text-sm" style={{ color: PALETTE.charcoalMuted }}>
        Aapke manager ab nateeje dekh saktay hain.
      </p>

      <div className="mt-7 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onUploadAnother}
          className="rounded-xl px-5 py-3 text-sm font-semibold transition-colors duration-150"
          style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = PALETTE.bottleGreenHover; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = PALETTE.bottleGreen; }}
        >
          Upload another file
        </button>
        <button
          type="button"
          onClick={onSwitchUser}
          className="rounded-xl px-5 py-3 text-sm font-medium transition-colors duration-150"
          style={{
            backgroundColor: 'transparent',
            border:          `1px solid ${PALETTE.sandBorder}`,
            color:           PALETTE.charcoal,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = PALETTE.sand; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
        >
          Switch to Manager view
        </button>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// The shell: one nav item, one screen. No role, preview-state or store switcher
// — the API would refuse those views for this role anyway (T11a).
// ----------------------------------------------------------------------------

export default function CashierWorkspace() {
  const { isDark, theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();
  const { tenant, logout } = useAuth();
  const upload = useSalesUpload();

  const isBusy = upload.phase === 'uploading' || upload.phase === 'processing';

  return (
    <div className="min-h-screen" style={{ backgroundColor: theme.background, color: PALETTE.charcoal }}>
      <aside
        className="flex flex-col lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:w-64"
        style={{
          backgroundColor: theme.surface,
          borderRight:    `1px solid ${theme.sandBorder}`,
          borderBottom:   `1px solid ${theme.sandBorder}`,
          boxShadow: isDark
            ? '4px 0 24px rgba(0, 0, 0, 0.3)'
            : '4px 0 24px rgba(36, 31, 26, 0.03)',
        }}
      >
        <div className="flex items-center gap-3 px-6 py-6">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg"
            style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
          >
            <StoreMarkIcon className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
              {tenant?.name ?? 'Retail Analytics'}
            </p>
            <p className="truncate text-xs" style={{ color: PALETTE.charcoalMuted }}>
              {tenant ? 'Retail Analytics' : 'Store Intelligence'}
            </p>
          </div>
        </div>

        <div className="mx-6 h-px" style={{ backgroundColor: theme.sandBorder }} />

        <nav className="flex-1 space-y-1 px-4 py-6" aria-label="Primary">
          <button
            type="button"
            aria-current="page"
            className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium"
            style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
          >
            <UploadIcon className="h-4.5 w-4.5 shrink-0" />
            <span className="truncate">Upload today's sales</span>
          </button>
        </nav>

        <div className="px-6 py-6">
          <button
            type="button"
            onClick={logout}
            className="rounded-lg px-1 py-1 text-left text-xs font-medium transition-colors duration-150"
            style={{ color: PALETTE.charcoalMuted }}
            onMouseEnter={(e) => { e.currentTarget.style.color = PALETTE.charcoal; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = PALETTE.charcoalMuted; }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="lg:ml-64">
        <header
          className="sticky top-0 z-20 px-4 py-4 sm:px-6 lg:px-8"
          style={{
            backgroundColor: theme.background,
            borderBottom:    `1px solid ${theme.sandBorder}`,
          }}
        >
          <h1 className="text-base font-semibold sm:text-lg" style={{ color: theme.charcoal }}>
            Assalam-o-Alaikum. Let's record today's sales.
          </h1>
        </header>

        <main className="p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-2xl space-y-6">
            <ol className="space-y-4 rounded-2xl p-6" style={CARD_SURFACE} aria-label="How to upload">
              {STEPS.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ol>

            {upload.phase === 'done' ? (
              <SummaryCard
                summary={upload.summary}
                onUploadAnother={upload.reset}
                onSwitchUser={logout}
              />
            ) : upload.phase === 'error' ? (
              <MessageCard message={upload.error} onRetry={upload.reset} />
            ) : isBusy ? (
              <ProgressCard rowsProcessed={upload.rowsProcessed} totalRows={upload.totalRows} />
            ) : (
              <UploadBox onPick={upload.start} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
