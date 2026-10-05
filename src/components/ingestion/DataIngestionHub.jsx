import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDesignTokens, useTheme } from '../../context/ThemeContext';

// Demo-mode simulation banner (only reachable when dataMode !== 'live').
const SUCCESS_BANNER_MESSAGE =
  'Successfully parsed 4,120 SKU records with 0 structural anomalies. The system runway has updated.';

const MOCK_MALFORMED_FILENAME = 'invoice_malformed.csv';

const STAGE_DEFINITIONS = [
  { key: 'schema', label: 'Structural Schema Parsing' },
  { key: 'depletion', label: 'Depletion Curve Calculation' },
  { key: 'checksum', label: 'Integrity Checksum Verification' },
];

// ----------------------------------------------------------------------------
// Live ingestion constants — mirror the backend contract.
// Required headers: same canonical names as REQUIRED_COLUMNS in
// backend/src/utils/validators.js (the backend also accepts aliases, e.g.
// "sale date"). The size cap mirrors MAX_FILE_SIZE_MB in
// backend/src/routes/upload.js (default 25). The store is the seeded demo
// store — the same UUID every dashboard uses.
// ----------------------------------------------------------------------------

const REQUIRED_COLUMNS = ['date', 'sku', 'product_name', 'quantity_sold', 'unit_price', 'unit_cost'];

const REQUIRED_COLUMN_LABELS = {
  date: 'Sale date',
  sku: 'SKU / product code',
  product_name: 'Product name',
  quantity_sold: 'Quantity sold',
  unit_price: 'Unit price',
  unit_cost: 'Unit cost',
};

const TEMPLATE_HEADER = 'date,sku,product_name,quantity_sold,unit_price,unit_cost';
const TEMPLATE_FILENAME = 'retail-import-template.csv';

const MAX_FILE_SIZE_MB = parseInt(import.meta.env.VITE_MAX_FILE_SIZE_MB, 10) || 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.csv', '.xlsx'];
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_DURATION_MS = 120_000;

const DEMO_STORE_ID = '00000000-0000-0000-0000-000000000010';

/** Generates a CSV with the exact required headers, client-side. */
const downloadTemplate = () => {
  const blob = new Blob(
    [`${TEMPLATE_HEADER}\n2026-10-01,SKU-TPLT-001,Sample Product,10,120.00,80.00\n`],
    { type: 'text/csv' },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = TEMPLATE_FILENAME;
  anchor.click();
  URL.revokeObjectURL(url);
};

const strokeProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const DocumentIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5Z" />
    <path d="M14 3.5V8h4" />
    <path d="M9 12.5h6" />
    <path d="M9 15.5h6" />
  </svg>
);

const CheckCircleIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <circle cx="12" cy="12" r="8" />
    <path d="M8.5 12.3 11 14.8 15.5 9.8" />
  </svg>
);

const ClockIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l3 2" />
  </svg>
);

const ArrowRightIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M4.5 12h15" />
    <path d="M13.5 6l6 6-6 6" />
  </svg>
);

const CloseIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M7 7l10 10M17 7 7 17" />
  </svg>
);

const ChecklistIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M5 12.5 9 16.5 19 6.5" />
  </svg>
);

const formatFileSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatTimestamp = (date) =>
  date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

let jobIdCounter = 0;
const nextJobId = () => {
  jobIdCounter += 1;
  return `job-${jobIdCounter}`;
};

const createMockMalformedFile = () => {
  const blob = new Blob(['tenant_id,units,cost\n'], { type: 'text/csv' });
  return new File([blob], MOCK_MALFORMED_FILENAME, { type: 'text/csv', lastModified: Date.now() });
};

const createJob = (file) => ({
  id: nextJobId(),
  fileName: file.name,
  fileSize: file.size,
  startedAt: new Date(),
  stages: STAGE_DEFINITIONS.map((stage) => ({ ...stage, progress: 0 })),
  isMockMalformed: file.name === MOCK_MALFORMED_FILENAME,
  hasError: false,
  errorMessage: null,
});

// ----------------------------------------------------------------------------
// SuccessFeedbackBanner — dismissible inline notice after graduation
// ----------------------------------------------------------------------------

const SuccessFeedbackBanner = ({ message, onDismiss }) => {
  const { theme } = useTheme();
  const { PALETTE } = useDesignTokens();

  return (
    <div
      role="status"
      className="flex items-start justify-between gap-4 rounded-xl px-4 py-3 sm:px-5"
      style={{
        backgroundColor: theme.successSoft,
        border: `1px solid rgba(63, 107, 74, 0.22)`,
        boxShadow: `0 4px 16px ${theme.successSoft}`,
      }}
    >
      <div className="flex items-start gap-3">
        <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0" style={{ color: theme.success }} />
        <p className="text-sm leading-relaxed" style={{ color: PALETTE.charcoal }}>
          {message}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-lg p-1 transition-colors"
        style={{ color: PALETTE.charcoalMuted }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = theme.successSoft;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
};

// ----------------------------------------------------------------------------
// ProgressRing
// ----------------------------------------------------------------------------

const ProgressRing = ({ percent, size = 44, strokeWidth = 4, color, isError = false }) => {
  const { theme } = useTheme();
  const { PALETTE } = useDesignTokens();
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // percent === null renders an indeterminate "working" ring (a pulsing arc,
  // never a fabricated number) — every percentage is derived from real job
  // fields (status, total_rows, rows_processed, rows_failed).
  const isWorking = percent === null;
  const offset = circumference * (1 - (isWorking ? 0.2 : percent / 100));
  const ringColor = isError ? theme.errorRing : (isWorking ? PALETTE.bottleGreen : color);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={isError || isWorking ? 'animate-pulse' : undefined}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={theme.sandBorder}
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={ringColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 400ms ease-out, stroke 200ms ease-out' }}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size * 0.26}
        fontWeight="600"
        fill={isError ? theme.error : PALETTE.charcoal}
      >
        {isWorking ? '…' : Math.round(percent)}
      </text>
    </svg>
  );
};

// ----------------------------------------------------------------------------
// UploadDropzone
// ----------------------------------------------------------------------------

const UploadDropzone = ({ onFiles, onReject, onDownloadTemplate, showLoadSample = false, onLoadSample }) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();

  // Client-side pre-checks that mirror the backend contract in
  // backend/src/routes/upload.js — extension filter + MAX_FILE_SIZE_MB cap.
  const acceptFiles = useCallback((files) => {
    const accepted = [];
    files.forEach((file) => {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        onReject?.(`"${file.name}" is not supported. Only .csv and .xlsx files can be imported.`);
      } else if (file.size > MAX_FILE_SIZE_BYTES) {
        onReject?.(`"${file.name}" is larger than the ${MAX_FILE_SIZE_MB}MB upload limit.`);
      } else {
        accepted.push(file);
      }
    });
    if (accepted.length) onFiles?.(accepted);
  }, [onFiles, onReject]);

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setIsDragging(false);
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length) acceptFiles(files);
    },
    [acceptFiles]
  );

  const handleBrowseChange = (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) acceptFiles(files);
    event.target.value = '';
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className="flex min-h-[200px] flex-col items-center justify-center rounded-xl cursor-pointer transition-colors duration-200"
        style={
          isDragging
            ? {
                border: `2px dashed ${PALETTE.bottleGreen}`,
                backgroundColor: PALETTE.bottleGreenSoft,
              }
            : {
                border: `2px dashed ${theme.sandBorder}`,
                backgroundColor: theme.panelBg,
              }
        }
        onMouseEnter={(e) => {
          if (!isDragging) e.currentTarget.style.backgroundColor = theme.surface;
        }}
        onMouseLeave={(e) => {
          if (!isDragging) e.currentTarget.style.backgroundColor = theme.panelBg;
        }}
      >
        <span
          className="flex h-14 w-14 items-center justify-center rounded-2xl shadow-sm"
          style={{ border: `1px solid ${theme.sandBorder}`, backgroundColor: theme.surface, color: PALETTE.charcoal }}
        >
          <DocumentIcon className="h-7 w-7" />
        </span>
        <p className="mt-3 text-base font-semibold" style={{ color: PALETTE.charcoal }}>
          Drag and drop a file to begin ingestion
        </p>
        <p className="mt-1.5 max-w-xs text-xs" style={{ color: PALETTE.charcoalMuted }}>
          Supports .csv and .xlsx, max {MAX_FILE_SIZE_MB}MB per file.
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-5 rounded-full px-5 py-2 text-xs font-semibold transition-all duration-150"
          style={{
            ...CARD_SURFACE,
            color: PALETTE.charcoal,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = PALETTE.sand;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = theme.surface;
          }}
        >
          Browse files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx"
          multiple
          onChange={handleBrowseChange}
          className="hidden"
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <button
          type="button"
          onClick={onDownloadTemplate}
          className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-left text-xs transition-colors"
          style={{ ...CARD_SURFACE, color: PALETTE.charcoal, backgroundColor: theme.surface }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = PALETTE.sand;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = theme.surface;
          }}
        >
          <span className="flex items-center gap-2.5">
            <DocumentIcon className="h-4 w-4" style={{ color: PALETTE.bottleGreen }} />
            <span>
              <span className="font-medium">{TEMPLATE_FILENAME}</span>
              <span className="ml-2 text-[11px]" style={{ color: PALETTE.charcoalMuted }}>
                — downloads the required column template
              </span>
            </span>
          </span>
          <span className="text-xs font-medium" style={{ color: PALETTE.bottleGreen }}>
            Download template
          </span>
        </button>

        {showLoadSample && (
          <button
            type="button"
            onClick={onLoadSample}
            className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-left text-xs transition-colors"
            style={{ ...CARD_SURFACE, color: PALETTE.charcoal, backgroundColor: theme.surface }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = PALETTE.sand;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = theme.surface;
            }}
          >
            <span className="flex items-center gap-2.5">
              <DocumentIcon className="h-4 w-4" style={{ color: theme.error }} />
              <span>
                <span className="font-medium">{MOCK_MALFORMED_FILENAME}</span>
                <span className="ml-2 text-[11px]" style={{ color: PALETTE.charcoalMuted }}>
                  — validation error simulation
                </span>
              </span>
            </span>
            <span className="text-xs font-medium" style={{ color: PALETTE.bottleGreen }}>
              Load sample
            </span>
          </button>
        )}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// ProcessingQueuePanel
// ----------------------------------------------------------------------------

const ErrorXIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <path d="M7 7l10 10M17 7 7 17" />
  </svg>
);

const ColumnChecklist = ({ state = 'pending', missingColumns = [] }) => {
  const { theme } = useTheme();
  const { PALETTE } = useDesignTokens();

  const toneFor = (column) => {
    if (state === 'fail' && missingColumns.includes(column)) {
      return { ok: false, color: theme.error, bg: theme.errorSoft };
    }
    if (state === 'fail' || state === 'pass') {
      return { ok: true, color: theme.success, bg: theme.successSoft };
    }
    return { ok: null, color: PALETTE.charcoalMuted, bg: theme.surface };
  };

  return (
    <ul className="mt-4 space-y-1.5">
      {REQUIRED_COLUMNS.map((column) => {
        const { ok, color, bg } = toneFor(column);
        return (
          <li
            key={column}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
            style={{ backgroundColor: bg, border: `1px solid ${theme.sandBorder}` }}
          >
            {ok === false ? (
              <ErrorXIcon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
            ) : (
              <ChecklistIcon
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: ok === true ? color : PALETTE.charcoalMuted }}
              />
            )}
            <span style={{ color: PALETTE.charcoalMuted }}>
              {ok === false ? 'Missing column: ' : 'Column: '}
              <span className="font-medium" style={{ color: ok === false ? color : PALETTE.charcoal }}>
                {REQUIRED_COLUMN_LABELS[column] ?? column}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
};

const EmptyQueueState = ({ isLive = true }) => {
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();

  return (
    <div
      className="rounded-xl border border-dashed px-5 py-6"
      style={{
        boxShadow: CARD_SURFACE.boxShadow,
        borderColor: theme.sandBorder,
        backgroundColor: theme.panelBg,
      }}
    >
      <p className="text-center text-xs font-medium" style={{ color: PALETTE.charcoal }}>
        Nothing in the queue right now
      </p>
      <p className="mt-1 text-center text-[11px]" style={{ color: PALETTE.charcoalMuted }}>
        {isLive
          ? 'Upload a CSV or XLSX file to import real sales rows.'
          : 'Upload a file to see the simulated pipeline progress.'}
      </p>
      <ColumnChecklist state="pending" />
    </div>
  );
};

const MockProcessingJobCard = ({ job }) => {
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();

  return (
    <div className="rounded-xl p-4" style={{ ...CARD_SURFACE, backgroundColor: theme.surface }}>
      <div className="flex items-center gap-2">
        <DocumentIcon className="h-4 w-4" style={{ color: PALETTE.charcoalMuted }} />
        <p className="truncate text-sm font-medium" style={{ color: PALETTE.charcoal }}>
          {job.fileName}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {job.stages.map((stage, index) => {
          const isSchemaStage = index === 0;
          const showError = job.hasError && isSchemaStage;

          return (
            <div key={stage.key} className="flex flex-col items-center gap-2">
              <ProgressRing
                percent={stage.progress}
                color={stage.progress >= 100 ? theme.success : PALETTE.bottleGreen}
                isError={showError}
              />
              <p className="text-center text-[10px] leading-tight" style={{ color: PALETTE.charcoalMuted }}>
                {stage.label}
              </p>
            </div>
          );
        })}
      </div>

      {job.hasError && job.errorMessage && (
        <div
          className="mt-4 rounded-lg px-3 py-2.5 text-xs font-medium"
          style={{
            backgroundColor: theme.errorSoft,
            color: theme.error,
            border: `1px solid rgba(185, 28, 28, 0.2)`,
          }}
          role="alert"
        >
          {job.errorMessage}
        </div>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Real-job helpers (live mode)
// ----------------------------------------------------------------------------

const extractMissingColumns = (errorLog) => {
  if (!Array.isArray(errorLog)) return [];
  for (const entry of errorLog) {
    if (entry && entry.type === 'MISSING_COLUMNS' && Array.isArray(entry.columns)) {
      return entry.columns;
    }
  }
  return [];
};

const describeErrors = (errorLog) => {
  if (!Array.isArray(errorLog)) return [];
  const lines = [];
  for (const entry of errorLog) {
    if (!entry) continue;
    if (entry.type === 'MISSING_COLUMNS') {
      const names = (entry.columns || []).map((c) => REQUIRED_COLUMN_LABELS[c] ?? c).join(', ');
      lines.push(`Missing required column(s): ${names}.`);
    } else if (entry.type === 'PIPELINE_ERROR') {
      lines.push(`We couldn't read this file: ${entry.message}`);
    } else if (entry.type === 'TIMEOUT') {
      lines.push(entry.message);
    } else if (entry.row && entry.error) {
      lines.push(`Row ${entry.row}: ${String(entry.error).replace(/^row\s+\d+:\s*/i, '')}`);
    } else if (entry.message) {
      lines.push(entry.message);
    }
  }
  return lines.slice(0, 5);
};

// Three honest stages, all derived from real job fields — status, total_rows,
// rows_processed, rows_failed. A null percent renders the pulsing "working"
// ring; nothing here is fabricated.
const deriveRealStages = (upload) => {
  const missing = extractMissingColumns(upload.errorLog);
  const isFailed = upload.status === 'failed';
  const isSchemaError = isFailed && missing.length > 0;
  const rowsPct = upload.totalRows
    ? Math.round((upload.rowsProcessed / upload.totalRows) * 100)
    : 0;

  return [
    {
      key: 'schema',
      label: 'Schema',
      percent: isSchemaError ? 100 : (upload.status === 'validating' ? null : 100),
      isError: isSchemaError,
    },
    {
      key: 'rows',
      label: upload.totalRows ? `${upload.rowsProcessed}/${upload.totalRows}` : 'Rows',
      percent: upload.status === 'completed' ? 100
        : (upload.status === 'processing' ? rowsPct
        : (isFailed ? 0 : null)),
      isError: false,
    },
    {
      key: 'finalize',
      label: 'Finalize',
      percent: upload.status === 'completed' ? 100 : 0,
      isError: isFailed && !isSchemaError,
    },
  ];
};

const AlertTriangleIcon = ({ className, style }) => (
  <svg viewBox="0 0 24 24" className={className} style={style} {...strokeProps}>
    <path d="M12 4 21 19.5H3L12 4Z" />
    <circle cx="12" cy="14" r="2.75" />
  </svg>
);

const NoticeBanner = ({ message, onDismiss }) => {
  const { ALERT_SURFACE, PALETTE } = useDesignTokens();
  const surface = ALERT_SURFACE.warning;

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-4 rounded-xl px-4 py-3 sm:px-5"
      style={{ backgroundColor: surface.backgroundColor, border: `1px solid ${surface.borderColor}` }}
    >
      <div className="flex items-start gap-3">
        <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" style={{ color: surface.borderColor }} />
        <p className="text-sm leading-relaxed" style={{ color: PALETTE.charcoal }}>
          {message}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-lg p-1 transition-colors"
        style={{ color: PALETTE.charcoalMuted }}
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
};

const RealProcessingJobCard = ({ upload }) => {
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE } = useDesignTokens();
  const stages = deriveRealStages(upload);
  const errors = describeErrors(upload.errorLog);

  return (
    <div className="rounded-xl p-4" style={{ ...CARD_SURFACE, backgroundColor: theme.surface }}>
      <div className="flex items-center gap-2">
        <DocumentIcon className="h-4 w-4" style={{ color: PALETTE.charcoalMuted }} />
        <p className="truncate text-sm font-medium" style={{ color: PALETTE.charcoal }}>
          {upload.fileName}
        </p>
        <StatusTag status={upload.status} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {stages.map((stage) => (
          <div key={stage.key} className="flex flex-col items-center gap-2">
            <ProgressRing
              percent={stage.percent}
              color={theme.success}
              isError={stage.isError}
            />
            <p className="text-center text-[10px] leading-tight" style={{ color: PALETTE.charcoalMuted }}>
              {stage.label}
            </p>
          </div>
        ))}
      </div>

      {upload.status === 'failed' && errors.length > 0 && (
        <div
          className="mt-4 rounded-lg px-3 py-2.5 text-xs font-medium"
          style={{
            backgroundColor: theme.errorSoft,
            color: theme.error,
            border: `1px solid rgba(185, 28, 28, 0.2)`,
          }}
          role="alert"
        >
          {errors[0]}
        </div>
      )}
    </div>
  );
};

const ProcessingQueuePanel = ({ jobs, isLive = true }) => {
  const { CARD_SURFACE, PALETTE } = useDesignTokens();

  return (
    <div className="rounded-xl p-6 sm:p-8" style={CARD_SURFACE}>
      <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
        Processing Queue
      </h2>
      <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
        {isLive
          ? 'Live pipeline status from the ingestion API — refreshed every second.'
          : 'Live pipeline status for files currently being ingested.'}
      </p>
      <div className="mt-5 space-y-3">
        {jobs.length === 0
          ? <EmptyQueueState isLive={isLive} />
          : jobs.map((entry) =>
              isLive
                ? <RealProcessingJobCard key={entry.id} upload={entry} />
                : <MockProcessingJobCard key={entry.id} job={entry} />
            )}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// RecentUploadsTable
// ----------------------------------------------------------------------------

const StatusTag = ({ status }) => {
  const { theme } = useTheme();
  const { PALETTE } = useDesignTokens();

  let style;
  let label;
  let busy = false;

  if (status === 'completed' || status === 'Success') {
    style = { backgroundColor: theme.successSoft, color: theme.success };
    label = 'Complete';
  } else if (status === 'failed' || status === 'Failed') {
    style = { backgroundColor: theme.errorSoft, color: theme.error };
    label = 'Failed';
  } else if (status === 'processing') {
    style = { backgroundColor: theme.warningSoft, color: theme.warning };
    label = 'Processing';
    busy = true;
  } else {
    // 'validating' | 'pending' | legacy mock 'Processing'
    style = { backgroundColor: theme.warningSoft, color: theme.warning };
    label = status === 'Processing' ? 'Processing' : 'Validating';
    busy = status !== 'Processing';
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style={style}>
      {busy ? (
        <span className="h-2 w-2 animate-pulse rounded-full" style={{ backgroundColor: theme.warning }} />
      ) : status === 'completed' || status === 'Success' ? (
        <CheckCircleIcon className="h-3.5 w-3.5" style={{ color: PALETTE.charcoal }} />
      ) : (
        <ClockIcon className="h-3.5 w-3.5" style={{ color: PALETTE.charcoal }} />
      )}
      {label}
    </span>
  );
};

const ResultStat = ({ label, value }) => {
  const { PALETTE, INSET_SURFACE } = useDesignTokens();

  return (
    <div className="rounded-lg px-3 py-2.5" style={INSET_SURFACE}>
      <p className="text-lg font-bold" style={{ color: PALETTE.charcoal }}>
        {value ?? '—'}
      </p>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: PALETTE.charcoalMuted }}>
        {label}
      </p>
    </div>
  );
};

const ResultsPanel = ({ upload }) => {
  const { theme } = useTheme();
  const { CARD_SURFACE, PALETTE, ALERT_SURFACE } = useDesignTokens();
  if (!upload) return null;
  const isFailed = upload.status === 'failed';
  const surface = isFailed ? ALERT_SURFACE.warning : null;
  const errors = describeErrors(upload.errorLog);
  const missing = extractMissingColumns(upload.errorLog);
  const totalRows = upload.totalRows ?? (upload.rowsProcessed + upload.rowsFailed);

  return (
    <div
      className="rounded-xl p-6 sm:p-8"
      style={{
        ...CARD_SURFACE,
        ...(isFailed ? { borderLeft: `4px solid ${surface.borderColor}` } : {}),
      }}
    >
      <div className="flex items-center gap-2.5">
        {isFailed ? (
          <AlertTriangleIcon className="h-5 w-5 shrink-0" style={{ color: surface.borderColor }} />
        ) : (
          <CheckCircleIcon className="h-5 w-5 shrink-0" style={{ color: theme.success }} />
        )}
        <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
          {isFailed ? 'Import failed' : 'Import complete'}
        </h2>
        <p className="ml-2 truncate text-xs" style={{ color: PALETTE.charcoalMuted }}>
          {upload.fileName}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <ResultStat label="Rows processed" value={upload.rowsProcessed} />
        <ResultStat label="Rows failed" value={upload.rowsFailed} />
        <ResultStat label="Total rows" value={totalRows} />
      </div>

      {isFailed && (
        <div
          className="mt-4 rounded-lg px-3 py-2.5 text-xs"
          style={{ backgroundColor: surface.backgroundColor, border: `1px solid ${surface.borderColor}` }}
        >
          <p className="font-medium" style={{ color: PALETTE.charcoal }}>
            What to fix:
          </p>
          {errors.length > 0 ? (
            <ul className="mt-1.5 list-disc space-y-1 pl-4" style={{ color: PALETTE.charcoalMuted }}>
              {errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5" style={{ color: PALETTE.charcoalMuted }}>
              The server didn't return a detailed reason — check your file structure and try again.
            </p>
          )}
        </div>
      )}

      <p className="mt-4 text-xs font-semibold" style={{ color: PALETTE.charcoalMuted }}>
        Required column checks
      </p>
      <ColumnChecklist
        state={isFailed && missing.length > 0 ? 'fail' : 'pass'}
        missingColumns={missing}
      />
    </div>
  );
};

const RecentUploadsTable = ({ uploads }) => {
  const { CARD_SURFACE, PALETTE } = useDesignTokens();
  const { theme } = useTheme();

  return (
    <div className="rounded-xl p-6 sm:p-8" style={CARD_SURFACE}>
      <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>Recent Uploads</h2>
      <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
        File name, size, and ingestion status — no downstream data shown here.
      </p>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b" style={{ borderColor: theme.sandBorder }}>
              {['File', 'Size', 'Uploaded', 'Status'].map((heading) => (
                <th
                  key={heading}
                  className="pb-3 pr-4 text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: PALETTE.charcoalMuted }}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {uploads.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-xs" style={{ color: PALETTE.charcoalMuted }}>
                  No uploads yet.
                </td>
              </tr>
            ) : (
              uploads.map((upload) => (
                <tr key={upload.id} className="border-b last:border-0" style={{ borderColor: theme.sandBorder }}>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <DocumentIcon className="h-4 w-4 shrink-0" style={{ color: PALETTE.charcoalMuted }} />
                      <span className="truncate font-medium" style={{ color: PALETTE.charcoal }}>
                        {upload.fileName}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 pr-4" style={{ color: PALETTE.charcoalMuted }}>
                    {formatFileSize(upload.fileSize)}
                  </td>
                  <td className="py-3 pr-4" style={{ color: PALETTE.charcoalMuted }}>
                    {formatTimestamp(upload.timestamp)}
                  </td>
                  <td className="py-3">
                    <StatusTag status={upload.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// DataIngestionHub — top-level export
// ----------------------------------------------------------------------------

const MALFORMED_ERROR_MESSAGE = '[Row 142]: Missing mandatory primary timestamp alignment value.';

// ----------------------------------------------------------------------------
// LiveDataIngestionHub — real upload pipeline (dataMode === 'live')
// Uploads via POST /api/upload, then polls GET /api/upload/:jobId/status once
// per second until a terminal state. All progress shown is derived from the
// real job fields; nothing is simulated.
// ----------------------------------------------------------------------------

const LiveDataIngestionHub = ({ onProceedToAnalytics = () => {} }) => {
  const [uploads, setUploads] = useState([]);
  const [activeJobIds, setActiveJobIds] = useState([]);
  const [notice, setNotice] = useState(null);
  const [successBanner, setSuccessBanner] = useState(null);
  const [lastResultJobId, setLastResultJobId] = useState(null);
  const busyRef = useRef(false);
  const { PALETTE } = useDesignTokens();
  const activeKey = activeJobIds.join(',');

  // Poll active jobs. Cleaned up on unmount so polling stops when leaving.
  useEffect(() => {
    if (activeKey === '') return undefined;
    const jobIds = activeKey.split(',');
    const started = Date.now();

    const tick = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        // Sane cap: stop polling after MAX_POLL_DURATION_MS and surface a
        // friendlier timeout on every job still in flight.
        if (Date.now() - started > MAX_POLL_DURATION_MS) {
          jobIds.forEach((jobId) => {
            setUploads((prev) => prev.map((u) =>
              u.jobId === jobId && u.status !== 'completed' && u.status !== 'failed'
                ? { ...u, status: 'failed', errorLog: [{ type: 'TIMEOUT', message: 'Still processing after 2 minutes — check the server logs.' }] }
                : u));
          });
          setActiveJobIds([]);
          return;
        }

        const settled = await Promise.allSettled(
          jobIds.map(async (jobId) => ({ jobId, job: await api.getUploadStatus(jobId) })),
        );
        settled.forEach(({ status, value }) => {
          if (status === 'rejected' || !value) return; // transient — retried next tick

          const { jobId, job } = value;
          setUploads((prev) => prev.map((u) => u.jobId === jobId
            ? {
                ...u,
                status: job.status,
                progressPct: job.progress_pct,
                totalRows: job.total_rows,
                rowsProcessed: job.rows_processed || 0,
                rowsFailed: job.rows_failed || 0,
                errorLog: Array.isArray(job.error_log) ? job.error_log : [],
              }
            : u));

          if (job.status === 'completed' || job.status === 'failed') {
            setActiveJobIds((ids) => ids.filter((id) => id !== jobId));
            setLastResultJobId(jobId);
            if (job.status === 'completed') {
              setSuccessBanner({
                id: Date.now(),
                message: `Import complete — ${job.rows_processed} rows imported${job.rows_failed ? `, ${job.rows_failed} failed validation` : ''}.`,
              });
            }
          }
        });
      } finally {
        busyRef.current = false;
      }
    };

    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [activeKey]);
          const handleFilesAccepted = (files) => {
    files.forEach((file) => {
      api.uploadFile(DEMO_STORE_ID, file)
        .then(({ jobId }) => {
          setUploads((prev) => [...prev, {
            id: jobId,
            jobId,
            fileName: file.name,
            fileSize: file.size,
            timestamp: new Date(),
            status: 'validating',
            progressPct: null,
            totalRows: null,
            rowsProcessed: 0,
            rowsFailed: 0,
            errorLog: [],
          }]);
          setActiveJobIds((ids) => [...ids, jobId]);
        })
        .catch((err) => {
          setNotice({
            tone: 'error',
            message: err.status === 413
              ? `"${file.name}" is larger than the ${MAX_FILE_SIZE_MB}MB upload limit.`
              : (err.data?.message || 'Upload failed — please try again.'),
          });
        });
    });
  };

  const handleReject = (message) => setNotice({ tone: 'error', message: String(message) });

  const hasCompletedUpload = uploads.some((u) => u.status === 'completed');
  const lastResult = uploads.find((u) => u.id === lastResultJobId) ?? null;

  return (
    <div className="space-y-6">
      {successBanner && (
        <SuccessFeedbackBanner
          message={successBanner.message}
          onDismiss={() => setSuccessBanner(null)}
        />
      )}

      {notice && (
        <NoticeBanner message={notice.message} onDismiss={() => setNotice(null)} />
      )}

      <div>
        <h1 className="text-xl font-semibold" style={{ color: PALETTE.charcoal }}>
          Data Ingestion Hub
        </h1>
        <p className="mt-1 text-sm" style={{ color: PALETTE.charcoalMuted }}>
          Upload store data files to import real rows. Live mode writes directly
          to your store database — no financial figures are shown here.
        </p>
      </div>

      <UploadDropzone
        onFiles={handleFilesAccepted}
        onReject={handleReject}
        onDownloadTemplate={downloadTemplate}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <ProcessingQueuePanel jobs={uploads} isLive />
        <RecentUploadsTable uploads={uploads} />
      </div>

      {lastResult && <ResultsPanel upload={lastResult} />}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onProceedToAnalytics}
          disabled={!hasCompletedUpload}
          className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
          onMouseEnter={(e) => {
            if (hasCompletedUpload) e.currentTarget.style.backgroundColor = PALETTE.bottleGreenHover;
          }}
          onMouseLeave={(e) => {
            if (hasCompletedUpload) e.currentTarget.style.backgroundColor = PALETTE.bottleGreen;
          }}
        >
          Proceed to Analytics
          <ArrowRightIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

  // ----------------------------------------------------------------------------
// MockDataIngestionHub — demo preview (dataMode !== 'live')
// The original simulated pipeline, reachable ONLY through the non-live
// preview modes on the DataModeSwitcher.
// ----------------------------------------------------------------------------

const MockDataIngestionHub = ({ onProceedToAnalytics = () => {} }) => {
  const [activeJobs, setActiveJobs] = useState([]);
  const [recentUploads, setRecentUploads] = useState([]);
  const [successBanner, setSuccessBanner] = useState(null);
  const { PALETTE } = useDesignTokens();

  useEffect(() => {
    if (activeJobs.length === 0) return undefined;

    const interval = setInterval(() => {
      setActiveJobs((prevJobs) => {
        const stillActive = [];
        const justCompleted = [];
        const justErrored = [];

        prevJobs.forEach((job) => {
          if (job.hasError) {
            stillActive.push(job);
            return;
          }

          if (job.isMockMalformed) {
            const schemaStage = job.stages[0];
            if (schemaStage.progress >= 40) {
              const haltedJob = {
                ...job,
                hasError: true,
                errorMessage: MALFORMED_ERROR_MESSAGE,
                stages: job.stages.map((stage, index) =>
                  index === 0 ? { ...stage, progress: 40 } : { ...stage, progress: 0 }
                ),
              };
              stillActive.push(haltedJob);
              justErrored.push(haltedJob);
            } else {
              stillActive.push({
                ...job,
                stages: job.stages.map((stage, index) =>
                  index === 0
                    ? { ...stage, progress: Math.min(40, stage.progress + 8 + Math.random() * 10) }
                    : stage
                ),
              });
            }
            return;
          }

          const updatedStages = job.stages.map((stage) =>
            stage.progress >= 100
              ? stage
              : { ...stage, progress: Math.min(100, stage.progress + (8 + Math.random() * 14)) }
          );
          const isComplete = updatedStages.every((stage) => stage.progress >= 100);
          const updatedJob = { ...job, stages: updatedStages };

          if (isComplete) {
            justCompleted.push(updatedJob);
          } else {
            stillActive.push(updatedJob);
          }
        });

        if (justCompleted.length) {
          setRecentUploads((prevUploads) =>
            prevUploads.map((upload) =>
              justCompleted.some((job) => job.id === upload.id)
                ? { ...upload, status: 'Success' }
                : upload
            )
          );
          setSuccessBanner({
            id: Date.now(),
            message: SUCCESS_BANNER_MESSAGE,
          });
        }

        if (justErrored.length) {
          setRecentUploads((prevUploads) =>
            prevUploads.map((upload) =>
              justErrored.some((job) => job.id === upload.id)
                ? { ...upload, status: 'Failed' }
                : upload
            )
          );
        }

        return stillActive;
      });
    }, 500);

    return () => clearInterval(interval);
  }, [activeJobs.length]);

  const handleFilesAdded = (files) => {
    const newJobs = files.map(createJob);

    setActiveJobs((prev) => [...prev, ...newJobs]);
    setRecentUploads((prev) => [
      ...newJobs.map((job) => ({
        id: job.id,
        fileName: job.fileName,
        fileSize: job.fileSize,
        timestamp: job.startedAt,
        status: 'Processing',
      })),
      ...prev,
    ]);
  };

  const handleLoadMockMalformed = () => {
    handleFilesAdded([createMockMalformedFile()]);
  };

  const hasCompletedUpload = recentUploads.some((upload) => upload.status === 'Success');

  return (
    <div className="space-y-6">
      {successBanner && (
        <SuccessFeedbackBanner
          message={successBanner.message}
          onDismiss={() => setSuccessBanner(null)}
        />
      )}

      <div>
        <h1 className="text-xl font-semibold" style={{ color: PALETTE.charcoal }}>
          Data Ingestion Hub
        </h1>
        <p className="mt-1 text-sm" style={{ color: PALETTE.charcoalMuted }}>
          Upload and monitor store data files. This preview shows the simulated
          pipeline — switch back to Healthy Store for real imports.
        </p>
      </div>

      <UploadDropzone
        onFiles={handleFilesAdded}
        onDownloadTemplate={downloadTemplate}
        showLoadSample
        onLoadSample={handleLoadMockMalformed}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <ProcessingQueuePanel jobs={activeJobs} isLive={false} />
        <RecentUploadsTable uploads={recentUploads} />
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onProceedToAnalytics}
          disabled={!hasCompletedUpload}
          className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          style={{ backgroundColor: PALETTE.bottleGreen, color: PALETTE.cream }}
          onMouseEnter={(e) => {
            if (hasCompletedUpload) e.currentTarget.style.backgroundColor = PALETTE.bottleGreenHover;
          }}
          onMouseLeave={(e) => {
            if (hasCompletedUpload) e.currentTarget.style.backgroundColor = PALETTE.bottleGreen;
          }}
        >
          Proceed to Analytics
          <ArrowRightIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// DataIngestionHub — dispatcher
// Live mode (the default) uses the real upload pipeline. Non-live preview
// modes keep the original mocked simulation reachable.
// ----------------------------------------------------------------------------

const DataIngestionHub = ({ onProceedToAnalytics = () => {}, dataMode = 'live' }) => {
  return dataMode === 'live'
    ? <LiveDataIngestionHub onProceedToAnalytics={onProceedToAnalytics} />
    : <MockDataIngestionHub onProceedToAnalytics={onProceedToAnalytics} />;
};

export default DataIngestionHub;
