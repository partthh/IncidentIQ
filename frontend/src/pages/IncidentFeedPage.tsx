/**
 * The incident feed.
 *
 * <p>Filters live in the URL rather than in component state. An operator pastes
 * "show me unassigned CRITICALs" to a colleague; if the filter were in state that link
 * would open the unfiltered feed. Pagination follows for the same reason.
 *
 * <p>Live updates work by <em>refetching</em>, not by patching rows from the socket
 * payload. The envelope's payload is a partial snapshot — it has no assignee and no
 * first-seen timestamp — so a client that patched from it would render an incident
 * that does not exist. Refetching is also correct after a missed broadcast, which is
 * the case the backend's contract explicitly does not try to handle.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import * as api from '../api/endpoints'
import type { IncidentSummary, MetricsSummary } from '../api/types'
import { useRealtimeSubscription } from '../realtime/RealtimeContext'
import { Alert, BarList, Empty, SeverityBadge, Spinner, StatusBadge } from '../ui/components'
import { formatDuration, formatMillis, formatRelative, serviceRefLabel } from '../ui/format'
import { useResource } from '../ui/useResource'

const FEED = '/topic/incidents'
const PAGE_SIZE = 25

const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED']
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']

export function IncidentFeedPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()

  const status = params.get('status') ?? ''
  const severity = params.get('severity') ?? ''
  const serviceId = params.get('serviceId') ?? ''
  const search = params.get('search') ?? ''
  const activeOnly = params.get('activeOnly') !== 'false'
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0)

  // The search box is local state so typing does not push a history entry per
  // keystroke; the URL is updated on a debounce.
  const [searchDraft, setSearchDraft] = useState(search)
  useEffect(() => setSearchDraft(search), [search])

  useEffect(() => {
    if (searchDraft === search) return
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params)
      if (searchDraft) next.set('search', searchDraft)
      else next.delete('search')
      next.delete('page')
      setParams(next, { replace: true })
    }, 350)
    return () => clearTimeout(timer)
  }, [searchDraft, search, params, setParams])

  const update = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params)
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
      // Any filter change invalidates the page number; keeping page 4 of the old
      // result set would show an empty table.
      if (key !== 'page') next.delete('page')
      setParams(next)
    },
    [params, setParams],
  )

  const filter = useMemo(
    () => ({ status, severity, serviceId, search, activeOnly }),
    [status, severity, serviceId, search, activeOnly],
  )

  const incidents = useResource(
    () => api.listIncidents(filter, page, PAGE_SIZE),
    [status, severity, serviceId, search, activeOnly, page],
  )
  const metrics = useResource(() => api.metricsSummary(), [])
  const services = useResource(() => api.listServices(), [])

  // A burst of timeline entries from one action collapses into a single refetch.
  useDebouncedReload(incidents.reload, FEED, 400)
  useDebouncedReload(metrics.reload, FEED, 600)

  const rows = incidents.data?.items ?? []

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p className="subtitle">
            {incidents.data
              ? `${incidents.data.totalItems} matching · ${activeOnly ? 'active only' : 'including resolved'}`
              : 'Loading…'}
          </p>
        </div>
      </div>

      <MetricsPanel metrics={metrics.data} loading={metrics.loading} />

      <div className="panel section-gap">
        <div className="filters">
          <div className="field">
            <label htmlFor="f-status">Status</label>
            <select
              id="f-status"
              value={status}
              onChange={(event) => update('status', event.target.value)}
            >
              <option value="">Any</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="f-severity">Severity</label>
            <select
              id="f-severity"
              value={severity}
              onChange={(event) => update('severity', event.target.value)}
            >
              <option value="">Any</option>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {value.toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="f-service">Service</label>
            <select
              id="f-service"
              value={serviceId}
              onChange={(event) => update('serviceId', event.target.value)}
            >
              <option value="">Any</option>
              {(services.data ?? []).map((service) => (
                <option key={service.id} value={service.id}>
                  {service.qualifiedName}
                </option>
              ))}
            </select>
          </div>

          <div className="field grow">
            <label htmlFor="f-search">Search</label>
            <input
              id="f-search"
              value={searchDraft}
              placeholder="reference, title, error signature"
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="f-active">Scope</label>
            <select
              id="f-active"
              value={activeOnly ? 'active' : 'all'}
              onChange={(event) => update('activeOnly', event.target.value === 'active' ? null : 'false')}
            >
              <option value="active">Active</option>
              <option value="all">All, including resolved</option>
            </select>
          </div>
        </div>
      </div>

      <div className="panel section-gap">
        {incidents.error && (
          <div style={{ marginBottom: 12 }}>
            <Alert kind="error">{incidents.error.message}</Alert>
          </div>
        )}

        {incidents.loading && rows.length === 0 ? (
          <Spinner label="Loading incidents…" />
        ) : rows.length === 0 ? (
          <Empty>
            No incidents match these filters.
            {activeOnly && <div className="small">Try switching the scope to “all”.</div>}
          </Empty>
        ) : (
          <>
            <table className="incident-table">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Severity</th>
                  <th>Incident</th>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Owner</th>
                  {/* Repeat occurrences, not total events. The count excludes the event
                      that opened the incident, so a freshly opened incident reads 0 — and it
                      is the number the auto-investigation threshold is compared against. */}
                  <th
                    className="num"
                    title="Further occurrences of this incident, excluding the event that opened it. Auto-investigation is queued once this reaches the configured threshold."
                  >
                    Repeats
                  </th>
                  <th className="num">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((incident) => (
                  <IncidentRow
                    key={incident.id}
                    incident={incident}
                    onOpen={() => navigate(`/incidents/${incident.id}`)}
                  />
                ))}
              </tbody>
            </table>

            <div className="pagination">
              <span className="small muted">
                Page {incidents.data!.page + 1} of {Math.max(1, incidents.data!.totalPages)}
              </span>
              <div className="row">
                <button
                  disabled={incidents.data!.page <= 0}
                  onClick={() => update('page', String(page - 1))}
                >
                  Previous
                </button>
                <button
                  disabled={!incidents.data!.hasNext}
                  onClick={() => update('page', String(page + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function IncidentRow({
  incident,
  onOpen,
}: {
  incident: IncidentSummary
  onOpen: () => void
}) {
  const age = formatRelative(incident.lastSeenAt)
  // For an open incident this is how long it has been active. For a resolved one it
  // is a lower bound, because the feed summary omits the resolution instant — better
  // than inventing an end time the payload does not contain.
  const openFor = formatDuration(incident.firstSeenAt, new Date().toISOString())

  return (
    <tr
      onClick={onOpen}
      // Keyboard users navigate by table semantics, not by clicking a row.
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <td className="ref">{incident.reference}</td>
      <td>
        <SeverityBadge severity={incident.severity} />
      </td>
      <td className="cell-title">{incident.title}</td>
      <td className="cell-service">{serviceRefLabel(incident.service)}</td>
      <td>
        <StatusBadge status={incident.status} />
      </td>
      <td className="small muted">
        {incident.assignedTo?.name ?? <span className="faint">unassigned</span>}
      </td>
      <td className="num">{incident.eventCount}</td>
      <td className="num" title={incident.lastSeenAt}>
        {age ?? '—'}
        {openFor && <div className="faint" style={{ fontSize: 11 }}>{openFor}</div>}
      </td>
    </tr>
  )
}

function MetricsPanel({
  metrics,
  loading,
}: {
  metrics: MetricsSummary | undefined
  loading: boolean
}) {
  if (loading && !metrics) return null
  if (!metrics) return null

  const severityRows = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const)
    .map((key) => ({ label: key.toLowerCase(), value: metrics.activeIncidentsBySeverity[key] ?? 0 }))
    .filter((row) => row.value > 0)

  const statusRows = STATUSES.map((key) => ({
    label: key.toLowerCase(),
    value: metrics.incidentsByStatus[key] ?? 0,
  })).filter((row) => row.value > 0)

  return (
    <div className="grid grid-stats section-gap">
      <Stat
        label="Active incidents"
        value={metrics.activeIncidents}
        note={`${metrics.resolvedIncidents} resolved`}
      />
      <Stat label="Events ingested" value={metrics.ingestedEvents} note="since startup" />
      <Stat
        label="AI analyses"
        value={metrics.ai.total}
        note={`${metrics.ai.byStatus.COMPLETED ?? 0} completed · ${(metrics.ai.byStatus.REJECTED ?? 0) + (metrics.ai.byStatus.FAILED ?? 0)} rejected or failed`}
      />
      <Stat
        label="Mean AI duration"
        // Absent means nothing has completed, and showing 0 would claim a latency was
        // measured when no measurement exists. The check has to be nullish rather than
        // `=== null`: the API omits the field entirely when there are no completed
        // analyses, so an omitted field arrives as undefined and slipped past a null
        // comparison into the formatter, which rendered "NaNs".
        value={formatMillis(metrics.ai.meanDurationMs) ?? '—'}
        note={
          formatMillis(metrics.ai.meanDurationMs) === null
            ? 'no completed analyses yet'
            : `over ${metrics.ai.completedCount} completed`
        }
      />
      <Stat
        label="Queue backlog"
        value={(metrics.ai.byStatus.QUEUED ?? 0) + (metrics.ai.byStatus.RUNNING ?? 0)}
        note={`${metrics.ai.byStatus.QUEUED ?? 0} queued · ${metrics.ai.byStatus.RUNNING ?? 0} running`}
      />
      <div className="stat">
        <div className="stat-label">Active by severity</div>
        <div style={{ marginTop: 8 }}>
          <BarList rows={severityRows} emptyText="No active incidents" />
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">All time by status</div>
        <div style={{ marginTop: 8 }}>
          <BarList rows={statusRows} emptyText="No incidents yet" />
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">Busiest services</div>
        <div style={{ marginTop: 8 }}>
          <BarList
            rows={metrics.activeIncidentsByService.map((row) => ({
              label: row.service,
              value: row.activeIncidents,
            }))}
            emptyText="No active incidents"
          />
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  )
}

/**
 * Refetches when anything arrives on a destination, coalescing bursts.
 *
 * <p>The envelope is a hint, not data: it says "something changed" without saying what
 * became true. Ten notes posted in quick succession produce ten envelopes and, after
 * this delay, one refetch.
 */
function useDebouncedReload(reload: () => void, destination: string, delayMs: number): void {
  const [tick, setTick] = useState(0)

  useRealtimeSubscription(
    destination,
    useCallback(() => setTick((value) => value + 1), []),
  )

  useEffect(() => {
    if (tick === 0) return
    const timer = setTimeout(reload, delayMs)
    return () => clearTimeout(timer)
    // `tick` is the trigger; `reload` is stable.
  }, [tick, delayMs, reload])
}