import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * ============================================================================
 * DataIngestionHub
 * ----------------------------------------------------------------------------
 * "Data Ingestion Hub" tab — lets a tenant manage how raw retail files/feeds
 * (CSV, Excel, webhook payloads) get mapped into the platform's generic
 * entities (Product, Category, SaleTransaction, InventoryLog) and gives a
 * live pulse on the parsing pipeline via a terminal-style log stream.
 *
 * Composition:
 *   DataIngestionHub
 *     ├─ HubHeader            – title, sync status summary, manual sync CTA
 *     ├─ ConnectionGrid        – 3-col bento of active integrations
 *     └─ (12-col row)
 *          ├─ PipelineConfigForm   (lg:col-span-5)
 *          └─ RealTimeLogStream    (lg:col-span-7)
 *
 * Design system: Warm Euro-Asian Minimalist
 *  - Canvas: bg-stone-50, wide margins, generous gaps
 *  - Panels: bg-white, border-stone-200, rounded-2xl (bento modules)
 *  - Log console is the one intentional departure: bg-stone-950/text-stone-200
 *    monospace, kept inside a warm-toned card so it still reads as part of
 *    the same family rather than a jarring "dev tool" insert.
 *
 * Multi-tenant note: nothing here references a specific retail vertical —
 * mappings target generic entities only (Product, Category, SaleTransaction,
 * InventoryLog), consistent with the SaaS architecture constraints.
 * ============================================================================
 */

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

const SyncIcon = ({ className, spinning }) => (
  <svg
    viewBox="0 0 24 24"
    className={`${className} ${spinning ? 'animate-spin' : ''}`}
    {...strokeProps}
  >
    <path d="M4 4v5h5" />
    <path d="M20 20v-5h-5" />
    <path d="M4.5 15A8 8 0 0 0 19 16.5" />
    <path d="M19.5 9A8 8 0 0 0 5 7.5" />
  </svg>
);

const UploadIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M12 4v11" />
    <path d="M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4.5 17.5v1.5A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-1.5" />
  </svg>
);

const WebhookIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <circle cx="6" cy="7" r="2" />
    <circle cx="17.5" cy="17.5" r="2" />
    <circle cx="17.5" cy="6.5" r="2" />
    <path d="M7.7 8.2 15.8 16" />
    <path d="M7.9 6.3h7.8" />
  </svg>
);

const ScheduleIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l3 2" />
  </svg>
);

const TerminalIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M7 9.5 10 12l-3 2.5" />
    <path d="M12.5 14.5h4" />
  </svg>
);

const PlusIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);

const TrashIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} {...strokeProps}>
    <path d="M5 7h14" />
    <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
    <path d="M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7" />
  </svg>
);

// ----------------------------------------------------------------------------
// Status pill — smooth earth-toned color shift based on integration state
// ----------------------------------------------------------------------------

const STATUS_STYLES = {
  Active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Paused: 'bg-amber-50 text-amber-700 border-amber-200',
  Error: 'bg-rose-50 text-rose-700 border-rose-200',
};

const StatusPill = ({ status }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-300 ${STATUS_STYLES[status]}`}
  >
    <span
      className={`h-1.5 w-1.5 rounded-full ${
        status === 'Active'
          ? 'bg-emerald-500'
          : status === 'Paused'
          ? 'bg-amber-500'
          : 'bg-rose-500'
      }`}
    />
    {status}
  </span>
);

// ----------------------------------------------------------------------------
// HubHeader
// ----------------------------------------------------------------------------

const HubHeader = ({ activeCount, totalCount, lastSyncedLabel, onTriggerSync, isSyncing }) => (
  <div className="rounded-2xl border border-stone-200 bg-white px-6 py-6 sm:px-8">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-stone-800">Data Ingestion Hub</h1>
        <p className="mt-1 text-sm text-stone-500">
          Manage how incoming files and feeds are parsed into your store&apos;s
          records.
        </p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-stone-400">
          {activeCount} of {totalCount} integrations active &middot; last sync{' '}
          {lastSyncedLabel}
        </p>
      </div>

      <button
        type="button"
        onClick={onTriggerSync}
        disabled={isSyncing}
        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-stone-800 px-4 py-2.5 text-sm font-medium text-stone-50 transition-colors duration-150 hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <SyncIcon className="h-4 w-4" spinning={isSyncing} />
        {isSyncing ? 'Syncing…' : 'Trigger Manual Sync'}
      </button>
    </div>
  </div>
);

// ----------------------------------------------------------------------------
// ConnectionGrid
// ----------------------------------------------------------------------------

const CONNECTIONS = [
  {
    id: 'pos-upload',
    label: 'POS File Upload',
    description: 'CSV / Excel batches uploaded from point-of-sale exports.',
    Icon: UploadIcon,
    status: 'Active',
    detail: '48 files this month',
  },
  {
    id: 'webhook-api',
    label: 'Webhook API',
    description: 'Streaming transaction events pushed in real time.',
    Icon: WebhookIcon,
    status: 'Active',
    detail: '1.2k events today',
  },
  {
    id: 'scheduled-export',
    label: 'Scheduled Export',
    description: 'Nightly inventory snapshot pulled on a fixed schedule.',
    Icon: ScheduleIcon,
    status: 'Paused',
    detail: 'Resumes tomorrow 02:00',
  },
];

const ConnectionCard = ({ connection }) => {
  const { label, description, Icon, status, detail } = connection;

  return (
    <div className="flex h-full flex-col justify-between rounded-2xl border border-stone-200 bg-white p-5">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-stone-100 text-stone-600">
            <Icon className="h-5 w-5" />
          </div>
          <StatusPill status={status} />
        </div>

        <h3 className="mt-4 text-sm font-semibold text-stone-800">{label}</h3>
        <p className="mt-1 text-xs leading-relaxed text-stone-500">{description}</p>
      </div>

      <p className="mt-4 text-xs font-medium text-stone-400">{detail}</p>
    </div>
  );
};

const ConnectionGrid = () => (
  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
    {CONNECTIONS.map((connection) => (
      <ConnectionCard key={connection.id} connection={connection} />
    ))}
  </div>
);

// ----------------------------------------------------------------------------
// PipelineConfigForm
// ----------------------------------------------------------------------------
// Lets a tenant declare how columns/fields in an incoming file map to the
// platform's generic entities. Intentionally entity-agnostic — no niche
// retail vocabulary baked in.

const TARGET_ENTITIES = ['SaleTransaction', 'Product', 'Category', 'InventoryLog'];

let mappingIdCounter = 0;
const nextMappingId = () => {
  mappingIdCounter += 1;
  return `mapping-${mappingIdCounter}`;
};

const createDefaultMappings = () => [
  { id: nextMappingId(), sourceField: 'transaction_id', targetEntity: 'SaleTransaction' },
  { id: nextMappingId(), sourceField: 'sku', targetEntity: 'Product' },
];

const PipelineConfigForm = () => {
  const [topicName, setTopicName] = useState('Default Ingestion Topic');
  const [delimiter, setDelimiter] = useState('comma');
  const [mappings, setMappings] = useState(createDefaultMappings);
  const [savedAt, setSavedAt] = useState(null);

  const updateMapping = (id, field, value) => {
    setMappings((prev) =>
      prev.map((mapping) => (mapping.id === id ? { ...mapping, [field]: value } : mapping))
    );
  };

  const addMapping = () => {
    setMappings((prev) => [
      ...prev,
      { id: nextMappingId(), sourceField: '', targetEntity: TARGET_ENTITIES[0] },
    ]);
  };

  const removeMapping = (id) => {
    setMappings((prev) => prev.filter((mapping) => mapping.id !== id));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    // In production this would persist to the backend's pipeline config
    // endpoint. Kept local-only here since this is a UI shell.
    setSavedAt(new Date());
  };

  return (
    <div className="flex h-full flex-col rounded-2xl border border-stone-200 bg-white p-6 sm:p-8">
      <div>
        <h2 className="text-sm font-semibold text-stone-800">Tenant Topic Mapping</h2>
        <p className="mt-1 text-xs leading-relaxed text-stone-500">
          Map columns from your uploaded files to the platform&apos;s standard
          data entities.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-1 flex-col">
        {/* Topic name */}
        <div className="mb-5">
          <label htmlFor="topicName" className="block text-xs font-medium text-stone-600">
            Topic name
          </label>
          <input
            id="topicName"
            type="text"
            value={topicName}
            onChange={(event) => setTopicName(event.target.value)}
            className="mt-1.5 w-full rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-sm text-stone-800 outline-none transition-colors focus:border-stone-400 focus:bg-white"
          />
        </div>

        {/* Delimiter */}
        <div className="mb-6">
          <label htmlFor="delimiter" className="block text-xs font-medium text-stone-600">
            File delimiter
          </label>
          <select
            id="delimiter"
            value={delimiter}
            onChange={(event) => setDelimiter(event.target.value)}
            className="mt-1.5 w-full rounded-xl border border-stone-200 bg-stone-50 px-3.5 py-2.5 text-sm text-stone-800 outline-none transition-colors focus:border-stone-400 focus:bg-white"
          >
            <option value="comma">Comma ( , )</option>
            <option value="semicolon">Semicolon ( ; )</option>
            <option value="tab">Tab</option>
          </select>
        </div>

        {/* Field mappings */}
        <div className="flex-1">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-stone-600">Field mappings</span>
            <button
              type="button"
              onClick={addMapping}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-stone-500 hover:bg-stone-100 hover:text-stone-800"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Add field
            </button>
          </div>

          <div className="space-y-2.5">
            {mappings.map((mapping) => (
              <div key={mapping.id} className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="source_column"
                  value={mapping.sourceField}
                  onChange={(event) =>
                    updateMapping(mapping.id, 'sourceField', event.target.value)
                  }
                  className="w-1/2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-800 outline-none transition-colors focus:border-stone-400 focus:bg-white"
                />
                <select
                  value={mapping.targetEntity}
                  onChange={(event) =>
                    updateMapping(mapping.id, 'targetEntity', event.target.value)
                  }
                  className="w-1/2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-800 outline-none transition-colors focus:border-stone-400 focus:bg-white"
                >
                  {TARGET_ENTITIES.map((entity) => (
                    <option key={entity} value={entity}>
                      {entity}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeMapping(mapping.id)}
                  aria-label="Remove field mapping"
                  className="shrink-0 rounded-lg p-2 text-stone-400 hover:bg-rose-50 hover:text-rose-600"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            {mappings.length === 0 && (
              <p className="rounded-lg border border-dashed border-stone-200 px-3 py-4 text-center text-xs text-stone-400">
                No field mappings yet. Add one above.
              </p>
            )}
          </div>
        </div>

        {/* Footer / save */}
        <div className="mt-6 flex items-center justify-between border-t border-stone-100 pt-5">
          <p className="text-xs text-stone-400">
            {savedAt
              ? `Saved at ${savedAt.toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : 'Unsaved changes are local until you save.'}
          </p>
          <button
            type="submit"
            className="rounded-xl bg-stone-800 px-4 py-2 text-sm font-medium text-stone-50 transition-colors duration-150 hover:bg-stone-700"
          >
            Save Mapping
          </button>
        </div>
      </form>
    </div>
  );
};

// ----------------------------------------------------------------------------
// RealTimeLogStream
// ----------------------------------------------------------------------------
// Mock ingestion console — appends a new realistic log line every few
// seconds via setInterval, capped so the array doesn't grow unbounded, and
// auto-scrolls to the newest entry.

const LOG_LEVEL_STYLES = {
  INFO: 'text-emerald-400',
  WARN: 'text-amber-400',
  ERROR: 'text-rose-400',
};

const MOCK_LOG_TEMPLATES = [
  { level: 'INFO', message: 'Chunk parsed successfully into raw_inventory' },
  { level: 'INFO', message: 'Row batch (500 rows) committed to SaleTransaction' },
  { level: 'INFO', message: 'Webhook payload validated and queued' },
  { level: 'INFO', message: 'Stream reader advanced to offset' },
  { level: 'WARN', message: 'Skipped 3 rows with missing sku column' },
  { level: 'WARN', message: 'Delimiter mismatch auto-corrected for upload' },
  { level: 'ERROR', message: 'Retrying chunk after transient connection reset' },
  { level: 'INFO', message: 'Checksum verified for uploaded file' },
  { level: 'INFO', message: 'Category mapping applied to 214 records' },
];

const MAX_LOG_LINES = 200;

const formatLogTimestamp = (date) =>
  date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const createLogEntry = () => {
  const template = MOCK_LOG_TEMPLATES[Math.floor(Math.random() * MOCK_LOG_TEMPLATES.length)];
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: formatLogTimestamp(new Date()),
    level: template.level,
    message: template.message,
  };
};

const RealTimeLogStream = () => {
  const [logLines, setLogLines] = useState(() => [createLogEntry()]);
  const [isLive, setIsLive] = useState(true);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!isLive) return undefined;

    const interval = setInterval(() => {
      setLogLines((prev) => {
        const next = [...prev, createLogEntry()];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    }, 2600);

    return () => clearInterval(interval);
  }, [isLive]);

  // Auto-scroll to the newest line as entries arrive.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logLines]);

  const toggleLive = useCallback(() => setIsLive((prev) => !prev), []);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-stone-200 bg-white p-6 sm:p-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <TerminalIcon className="h-4.5 w-4.5 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-800">Real-Time Ingestion Log</h2>
        </div>

        <button
          type="button"
          onClick={toggleLive}
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isLive ? 'animate-pulse bg-emerald-500' : 'bg-stone-300'
            }`}
          />
          {isLive ? 'Live' : 'Paused'}
        </button>
      </div>

      {/* Terminal card — the one intentional monospace/dark departure,
          wrapped in the same warm rounded-2xl language as every other panel. */}
      <div
        ref={scrollRef}
        className="mt-5 h-[350px] flex-1 overflow-y-auto rounded-xl bg-stone-950 p-4 font-mono text-xs leading-relaxed text-stone-200 lg:h-full"
      >
        {logLines.map((line) => (
          <div key={line.id} className="flex gap-2 whitespace-pre-wrap break-all">
            <span className="shrink-0 text-stone-500">{line.timestamp}</span>
            <span className={`shrink-0 font-semibold ${LOG_LEVEL_STYLES[line.level]}`}>
              [{line.level}]
            </span>
            <span className="text-stone-300">{line.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// DataIngestionHub — top-level export
// ----------------------------------------------------------------------------

const DataIngestionHub = () => {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(() => new Date());

  const activeCount = CONNECTIONS.filter((connection) => connection.status === 'Active').length;

  const handleTriggerSync = () => {
    if (isSyncing) return;
    setIsSyncing(true);

    // Simulated sync round-trip — swap for a real API call against the
    // ingestion service when wiring up the backend.
    setTimeout(() => {
      setIsSyncing(false);
      setLastSyncedAt(new Date());
    }, 1800);
  };

  const lastSyncedLabel = lastSyncedAt.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="space-y-6">
      <HubHeader
        activeCount={activeCount}
        totalCount={CONNECTIONS.length}
        lastSyncedLabel={lastSyncedLabel}
        onTriggerSync={handleTriggerSync}
        isSyncing={isSyncing}
      />

      <ConnectionGrid />

      {/* Equal-height 12-column row on desktop; stacks on mobile. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-stretch">
        <div className="lg:col-span-5">
          <PipelineConfigForm />
        </div>
        <div className="lg:col-span-7">
          <RealTimeLogStream />
        </div>
      </div>
    </div>
  );
};

export default DataIngestionHub;