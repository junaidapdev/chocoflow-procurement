'use client';

import { useMemo, useState } from 'react';
import { Database, Eye, Filter, Search, User, X } from 'lucide-react';

type AuditOutcome = 'success' | 'failure' | 'denied';

type JsonObject = Record<string, unknown> | null;

export type AuditLog = {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_role: string | null;
  actor_email: string | null;
  actor_name: string | null;
  actor_type: string | null;
  action: string;
  outcome: AuditOutcome;
  error_message: string | null;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  before_state: JsonObject;
  after_state: JsonObject;
  metadata: Record<string, unknown>;
  request_ip: string | null;
  user_agent: string | null;
};

type FilterState = {
  action: string;
  entityType: string;
  entitySearch: string;
  actorSearch: string;
  outcome: string;
};

const EMPTY_FILTERS: FilterState = {
  action: '',
  entityType: '',
  entitySearch: '',
  actorSearch: '',
  outcome: '',
};

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function lower(value: unknown) {
  return String(value || '').toLowerCase();
}

function compactValue(value: unknown) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) return value.length ? value.join(', ') : null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function truncate(value: string, maxLength = 120) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function metadataPreview(metadata: Record<string, unknown>) {
  const entries = Object.entries(metadata || {})
    .map(([key, value]) => [key, compactValue(value)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    .slice(0, 3);

  if (entries.length === 0) return 'No metadata';

  return truncate(entries.map(([key, value]) => `${key}: ${value}`).join(' | '), 150);
}

function formatActor(log: AuditLog) {
  const primary = log.actor_email || log.actor_name || log.actor_type || 'Unknown actor';
  const role = log.actor_role ? ` (${log.actor_role})` : '';
  return `${primary}${role}`;
}

function shortId(value: string | null) {
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function outcomeClass(outcome: AuditOutcome) {
  if (outcome === 'success') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (outcome === 'denied') return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
}

function prettyJson(value: unknown) {
  if (value == null) return 'null';
  return JSON.stringify(value, null, 2);
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-white">
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">{title}</h3>
      </div>
      <pre className="p-4 text-xs text-gray-800 overflow-auto max-h-72 whitespace-pre-wrap break-words font-mono">
        {prettyJson(value)}
      </pre>
    </div>
  );
}

export default function AuditLogsClient({ initialLogs }: { initialLogs: AuditLog[] }) {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const actions = useMemo(
    () => Array.from(new Set(initialLogs.map(log => log.action))).sort(),
    [initialLogs]
  );

  const entityTypes = useMemo(
    () => Array.from(new Set(initialLogs.map(log => log.entity_type))).sort(),
    [initialLogs]
  );

  const filteredLogs = useMemo(() => {
    return initialLogs.filter(log => {
      const metadataText = lower(JSON.stringify(log.metadata || {}));
      const entityText = lower([
        log.entity_type,
        log.entity_id,
        log.entity_label,
        metadataText,
      ].join(' '));
      const actorText = lower([
        log.actor_email,
        log.actor_name,
        log.actor_role,
        log.actor_type,
      ].join(' '));

      if (filters.action && log.action !== filters.action) return false;
      if (filters.entityType && log.entity_type !== filters.entityType) return false;
      if (filters.outcome && log.outcome !== filters.outcome) return false;
      if (filters.entitySearch && !entityText.includes(lower(filters.entitySearch))) return false;
      if (filters.actorSearch && !actorText.includes(lower(filters.actorSearch))) return false;

      return true;
    });
  }, [filters, initialLogs]);

  const hasActiveFilters = Object.values(filters).some(Boolean);

  return (
    <>
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gray-200 bg-gray-50/70">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <label className="block">
              <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Action</span>
              <select
                value={filters.action}
                onChange={event => setFilters(prev => ({ ...prev, action: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">All actions</option>
                {actions.map(action => (
                  <option key={action} value={action}>{action}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Entity Type</span>
              <select
                value={filters.entityType}
                onChange={event => setFilters(prev => ({ ...prev, entityType: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">All entities</option>
                {entityTypes.map(entityType => (
                  <option key={entityType} value={entityType}>{entityType}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Entity Search</span>
              <div className="relative mt-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  value={filters.entitySearch}
                  onChange={event => setFilters(prev => ({ ...prev, entitySearch: event.target.value }))}
                  placeholder="Invoice, ID, metadata"
                  className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm font-medium text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </label>

            <label className="block">
              <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Actor</span>
              <div className="relative mt-1">
                <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  value={filters.actorSearch}
                  onChange={event => setFilters(prev => ({ ...prev, actorSearch: event.target.value }))}
                  placeholder="Email, name, role"
                  className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm font-medium text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </label>

            <label className="block">
              <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Outcome</span>
              <select
                value={filters.outcome}
                onChange={event => setFilters(prev => ({ ...prev, outcome: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">All outcomes</option>
                <option value="success">success</option>
                <option value="failure">failure</option>
                <option value="denied">denied</option>
              </select>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600">
              <Filter className="h-4 w-4 text-gray-400" />
              {filteredLogs.length} of {initialLogs.length} logs
            </div>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <X className="h-4 w-4" />
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/80">
                <th className="px-5 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Timestamp</th>
                <th className="px-5 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Actor</th>
                <th className="px-5 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Action</th>
                <th className="px-5 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Entity</th>
                <th className="px-5 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Outcome</th>
                <th className="px-5 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">Metadata</th>
                <th className="px-5 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredLogs.map(log => (
                <tr key={log.id} className="hover:bg-gray-50/70 transition-colors">
                  <td className="px-5 py-4 align-top text-sm font-medium text-gray-700 whitespace-nowrap">
                    {formatTimestamp(log.created_at)}
                  </td>
                  <td className="px-5 py-4 align-top">
                    <div className="max-w-[220px]">
                      <p className="truncate text-sm font-bold text-gray-900">{formatActor(log)}</p>
                      <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                        {log.actor_type || 'unknown'}
                      </p>
                    </div>
                  </td>
                  <td className="px-5 py-4 align-top">
                    <span className="font-mono text-xs font-semibold text-gray-900">{log.action}</span>
                  </td>
                  <td className="px-5 py-4 align-top">
                    <div className="max-w-[180px]">
                      <p className="text-sm font-bold text-gray-900">{log.entity_type}</p>
                      <p className="mt-1 truncate font-mono text-xs text-gray-500">
                        {log.entity_label || shortId(log.entity_id) || 'No entity'}
                      </p>
                    </div>
                  </td>
                  <td className="px-5 py-4 align-top">
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${outcomeClass(log.outcome)}`}>
                      {log.outcome}
                    </span>
                  </td>
                  <td className="px-5 py-4 align-top">
                    <p className="max-w-[300px] text-sm text-gray-600">{metadataPreview(log.metadata)}</p>
                    {log.error_message && (
                      <p className="mt-1 max-w-[300px] text-xs font-medium text-red-600">{truncate(log.error_message, 100)}</p>
                    )}
                  </td>
                  <td className="px-5 py-4 align-top text-right">
                    <button
                      type="button"
                      onClick={() => setSelectedLog(log)}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <Eye className="h-4 w-4" />
                      View
                    </button>
                  </td>
                </tr>
              ))}

              {filteredLogs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-sm font-medium text-gray-500">
                    No audit logs match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedLog && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-gray-950/55 p-4 backdrop-blur-sm">
          <div className="min-h-full flex items-start justify-center py-8">
            <div className="w-full max-w-5xl rounded-lg bg-white shadow-2xl border border-gray-200">
              <div className="flex items-start justify-between gap-4 border-b border-gray-200 p-5">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${outcomeClass(selectedLog.outcome)}`}>
                      {selectedLog.outcome}
                    </span>
                    <span className="font-mono text-sm font-bold text-gray-900">{selectedLog.action}</span>
                  </div>
                  <p className="mt-2 text-sm font-medium text-gray-500">
                    {formatTimestamp(selectedLog.created_at)} | {formatActor(selectedLog)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedLog(null)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  aria-label="Close audit log details"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-5 space-y-5">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border border-gray-200 p-4">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Entity</p>
                    <p className="mt-2 text-sm font-bold text-gray-900">{selectedLog.entity_type}</p>
                    <p className="mt-1 break-words font-mono text-xs text-gray-500">
                      {selectedLog.entity_label || selectedLog.entity_id || 'No entity'}
                    </p>
                  </div>
                  <div className="rounded-lg border border-gray-200 p-4">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Actor</p>
                    <p className="mt-2 break-words text-sm font-bold text-gray-900">{formatActor(selectedLog)}</p>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-gray-400">{selectedLog.actor_type || 'unknown'}</p>
                  </div>
                  <div className="rounded-lg border border-gray-200 p-4">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Request IP</p>
                    <p className="mt-2 break-words font-mono text-sm text-gray-900">{selectedLog.request_ip || 'Not captured'}</p>
                  </div>
                  <div className="rounded-lg border border-gray-200 p-4">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">User Agent</p>
                    <p className="mt-2 line-clamp-3 break-words text-xs font-medium text-gray-600">{selectedLog.user_agent || 'Not captured'}</p>
                  </div>
                </div>

                {selectedLog.error_message && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                    <p className="text-xs font-bold text-red-600 uppercase tracking-wider">Error Message</p>
                    <p className="mt-2 text-sm font-medium text-red-800">{selectedLog.error_message}</p>
                  </div>
                )}

                <div className="grid gap-5 lg:grid-cols-2">
                  <JsonBlock title="Before State" value={selectedLog.before_state} />
                  <JsonBlock title="After State" value={selectedLog.after_state} />
                </div>

                <JsonBlock title="Metadata" value={selectedLog.metadata} />

                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider">
                    <Database className="h-4 w-4" />
                    Audit ID
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-gray-700">{selectedLog.id}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
