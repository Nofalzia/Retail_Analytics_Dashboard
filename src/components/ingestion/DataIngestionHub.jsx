import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CARD_SURFACE, PALETTE } from '../layout/DashboardShell';

/**
 * DataIngestionHub — System Administrator / Data Entry Clerk view
 * Operational only: no financial figures surfaced on this screen.
 */

const SUCCESS_GREEN = {
  text: '#3F6B4A',
  soft: 'rgba(63, 107, 74, 0.10)',
};

const PROCESSING_AMBER = {
  text: '#8A6A2B',
  soft: 'rgba(138, 106, 43, 0.10)',
};

const ERROR_CRIMSON = {
  text: '#B91C1C',
  soft: 'rgba(185, 28, 28, 0.12)',
  ring: '#DC2626',
};

const SUCCESS_BANNER_MESSAGE =
  'Successfully parsed 4,120 SKU records with 0 structural anomalies. The system runway has updated.';

const MOCK_MALFORMED_FILENAME = 'invoice_malformed.csv';

const STRUCTURAL_CHECKLIST = [
  { column: 'A', label: 'Tenant ID' },
  { column: 'B', label: 'Units Dispatched' },
  { column: 'C', label: 'Realized Cost Matrix' },
];

const STAGE_DEFINITIONS = [
  { key: 'schema', label: 'Structural Schema Parsing' },
  { key: 'depletion', label: 'Depletion Curve Calculation' },
  { key: 'checksum', label: 'Integrity Checksum Verification' },
];

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

const SuccessFeedbackBanner = ({ message, onDismiss }) => (
  <div
    role="status"
    className="flex items-start justify-between gap-4 rounded-xl px-4 py-3 sm:px-5"
    style={{
      backgroundColor: SUCCESS_GREEN.soft,
      border: `1px solid rgba(63, 107, 74, 0.22)`,
      boxShadow: '0 4px 16px rgba(63, 107, 74, 0.08)',
    }}
  >
    <div className="flex items-start gap-3">
      <CheckCircleIcon className="mt-0.5 h-5 w-5 shrink-0" style={{ color: SUCCESS_GREEN.text }} />
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
        e.currentTarget.style.backgroundColor = 'rgba(63, 107, 74, 0.12)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      <CloseIcon className="h-4 w-4" />
    </button>
  </div>
);

// ----------------------------------------------------------------------------
// ProgressRing
// ----------------------------------------------------------------------------

const ProgressRing = ({ percent, size = 44, strokeWidth = 4, color, isError = false }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  const ringColor = isError ? ERROR_CRIMSON.ring : color;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={isError ? 'animate-pulse' : undefined}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={PALETTE.sandBorder}
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
        fill={isError ? ERROR_CRIMSON.text : PALETTE.charcoal}
      >
        {Math.round(percent)}
      </text>
    </svg>
  );
};

// ----------------------------------------------------------------------------
// UploadDropzone
// ----------------------------------------------------------------------------

const UploadDropzone = ({ onFilesAdded }) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setIsDragging(false);
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length) onFilesAdded(files);
    },
    [onFilesAdded]
  );

  const handleBrowseChange = (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) onFilesAdded(files);
    event.target.value = '';
  };

  const handleLoadMockMalformed = () => {
    onFilesAdded([createMockMalformedFile()]);
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
        className="flex min-h-[200px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-stone-200 bg-stone-50/30 px-8 py-12 text-center transition-colors duration-200 hover:bg-stone-50/80 cursor-pointer"
        style={isDragging ? { borderColor: PALETTE.bottleGreen, backgroundColor: PALETTE.bottleGreenSoft } : undefined}
      >
        <span
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-stone-700 shadow-sm"
          style={{ border: `1px solid ${PALETTE.sandBorder}` }}
        >
          <DocumentIcon className="h-7 w-7" />
        </span>
        <p className="mt-3 text-base font-semibold text-stone-900">
          Drag and drop a file to begin ingestion
        </p>
        <p className="mt-1.5 max-w-xs text-xs text-stone-500">
          Supports .csv and .xlsx using the standard tenant template.
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-5 rounded-full border border-stone-200 bg-white px-5 py-2 text-xs font-semibold text-stone-700 transition-all duration-150 hover:bg-stone-100"
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

      <button
        type="button"
        onClick={handleLoadMockMalformed}
        className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-left text-xs transition-colors"
        style={{ ...CARD_SURFACE, color: PALETTE.charcoal }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = PALETTE.sand;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#FFFFFF';
        }}
      >
        <span className="flex items-center gap-2.5">
          <DocumentIcon className="h-4 w-4" style={{ color: ERROR_CRIMSON.text }} />
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
    </div>
  );
};

// ----------------------------------------------------------------------------
// ProcessingQueuePanel
// ----------------------------------------------------------------------------

const EmptyQueueState = () => (
  <div
    className="rounded-xl border border-dashed border-stone-200 bg-stone-50/50 px-5 py-6"
    style={{
      boxShadow: CARD_SURFACE.boxShadow,
    }}
  >
    <p className="text-center text-xs font-medium" style={{ color: PALETTE.charcoal }}>
      Nothing in the queue right now
    </p>
    <p className="mt-1 text-center text-[11px]" style={{ color: PALETTE.charcoalMuted }}>
      Upload a file to see live progress, or review the structural checklist below.
    </p>
    <ul className="mt-4 space-y-1.5">
      {STRUCTURAL_CHECKLIST.map(({ column, label }) => (
        <li
          key={column}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
          style={{ backgroundColor: PALETTE.sand }}
        >
          <ChecklistIcon className="h-3.5 w-3.5 shrink-0" style={{ color: SUCCESS_GREEN.text }} />
          <span style={{ color: PALETTE.charcoalMuted }}>
            Column {column}:{' '}
            <span className="font-medium" style={{ color: PALETTE.charcoal }}>
              {label}
            </span>
          </span>
        </li>
      ))}
    </ul>
  </div>
);

const ProcessingJobCard = ({ job }) => (
  <div className="rounded-xl p-4" style={CARD_SURFACE}>
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
              color={stage.progress >= 100 ? SUCCESS_GREEN.text : PALETTE.bottleGreen}
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
          backgroundColor: ERROR_CRIMSON.soft,
          color: ERROR_CRIMSON.text,
          border: `1px solid rgba(185, 28, 28, 0.2)`,
        }}
        role="alert"
      >
        {job.errorMessage}
      </div>
    )}
  </div>
);

const ProcessingQueuePanel = ({ jobs }) => (
  <div className="rounded-xl p-6 sm:p-8" style={CARD_SURFACE}>
    <h2 className="text-sm font-semibold" style={{ color: PALETTE.charcoal }}>
      Processing Queue
    </h2>
    <p className="mt-1 text-xs" style={{ color: PALETTE.charcoalMuted }}>
      Live pipeline status for files currently being ingested.
    </p>
    <div className="mt-5 space-y-3">
      {jobs.length === 0 ? <EmptyQueueState /> : jobs.map((job) => <ProcessingJobCard key={job.id} job={job} />)}
    </div>
  </div>
);

// ----------------------------------------------------------------------------
// RecentUploadsTable
// ----------------------------------------------------------------------------

const StatusTag = ({ status }) => {
  const isSuccess = status === 'Success';
  const isFailed = status === 'Failed';
  const style = isSuccess
    ? { backgroundColor: SUCCESS_GREEN.soft, color: SUCCESS_GREEN.text }
    : isFailed
      ? { backgroundColor: ERROR_CRIMSON.soft, color: ERROR_CRIMSON.text }
      : { backgroundColor: PROCESSING_AMBER.soft, color: PROCESSING_AMBER.text };

  const label = isSuccess ? 'Processing Complete' : isFailed ? 'Validation Failed' : 'Processing';

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style={style}>
      {isSuccess ? (
        <CheckCircleIcon className="h-3.5 w-3.5" />
      ) : (
        <ClockIcon className="h-3.5 w-3.5" />
      )}
      {label}
    </span>
  );
};

const RecentUploadsTable = ({ uploads }) => (
  <div className="rounded-xl p-6 sm:p-8" style={CARD_SURFACE}>
    <h2 className="text-sm font-semibold text-stone-900">Recent Uploads</h2>
    <p className="mt-1 text-xs text-stone-500">
      File name, size, and ingestion status — no downstream data shown here.
    </p>
    <div className="mt-5 overflow-x-auto">
      <table className="w-full min-w-[480px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-stone-100">
            {['File', 'Size', 'Uploaded', 'Status'].map((heading) => (
              <th
                key={heading}
                className="pb-3 pr-4 text-[10px] font-semibold uppercase tracking-wider text-stone-500"
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
              <tr key={upload.id} className="border-b border-stone-100 last:border-0">
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

// ----------------------------------------------------------------------------
// DataIngestionHub — top-level export
// ----------------------------------------------------------------------------

const MALFORMED_ERROR_MESSAGE = '[Row 142]: Missing mandatory primary timestamp alignment value.';

const DataIngestionHub = ({ onProceedToAnalytics = () => {} }) => {
  const [activeJobs, setActiveJobs] = useState([]);
  const [recentUploads, setRecentUploads] = useState([]);
  const [successBanner, setSuccessBanner] = useState(null);

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
          Upload and monitor store data files. This view is operational only —
          no financial figures are shown here.
        </p>
      </div>

      <UploadDropzone onFilesAdded={handleFilesAdded} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <ProcessingQueuePanel jobs={activeJobs} />
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

export default DataIngestionHub;
