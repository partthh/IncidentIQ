/**
 * Incident detail: evidence, audit trail, AI investigation, and the write actions.
 *
 * <p>Three decisions shape this page:
 *
 * <ol>
 *   <li><b>Optimistic locking is surfaced, not swallowed.</b> Every mutation sends the
 *       version the page currently holds. If someone else got there first the server
 *       answers 409, and this page says so and reloads — rather than retrying, which
 *       would overwrite a colleague's change, or showing a bare "request failed".</li>
 *   <li><b>AI output is visibly a suggestion.</b> The panel labels the model's
 *       confidence as the model's own estimate, shows the evidence it cited, lists what
 *       it says is missing, and carries an explicit reminder that nothing here changed
 *       the incident. The unvalidated raw output is admin-only and rendered as
 *       preformatted text, because it can contain instruction-shaped text lifted from a
 *       log payload.</li>
 *   <li><b>Actions are hidden for VIEWER, not disabled.</b> The server enforces the
 *       role, so the buttons are removed rather than shown broken.</li>
 * </ol>
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ApiError } from '../api/client'
import * as api from '../api/endpoints'
import type {
  AnalysisDetail,
  AssigneeOption,
  IncidentDetail,
  TimelineEntry,
} from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { incidentTopic, useRealtimeSubscription } from '../realtime/RealtimeContext'
import { Alert, AnalysisStatusBadge, Empty, Field, SeverityBadge, Spinner, StatusBadge } from '../ui/components'
import { formatDuration, formatInstant, formatMillis, formatRelative, percent, serviceRefLabel } from '../ui/format'
import { useResource } from '../ui/useResource'

type ActionKind = 'acknowledge' | 'investigate' | 'assign' | 'note' | 'resolve' | 'ai'

export function IncidentDetailPage() {
  const { incidentId = '' } = useParams()
  const { canWrite } = useAuth()

  const incident = useResource(() => api.getIncident(incidentId), [incidentId])
  const timeline = useResource(() => api.getTimeline(incidentId, undefined, 200), [incidentId])
  const analysis = useResource(() => api.latestAnalysis(incidentId), [incidentId])
  const assignable = useResource(
    () => (canWrite ? api.assignableUsers() : Promise.resolve([] as AssigneeOption[])),
    [canWrite],
  )

  const [conflict, setConflict] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState<ActionKind | null>(null)

  // Live updates: refetch rather than patch, for the reason given in the module note.
  const [tick, setTick] = useState(0)
  useRealtimeSubscription(
    incidentId ? incidentTopic(incidentId) : null,
    useCallback(() => setTick((value) => value + 1), []),
  )
  useEffect(() => {
    if (tick === 0) return
    const timer = setTimeout(() => {
      incident.reload()
      timeline.reload()
      analysis.reload()
    }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  // A 409 means the version this page holds is stale. Reloading is the only honest
  // response: the operator must look at the current state before acting again.
  async function run(kind: ActionKind, action: (version: number) => Promise<IncidentDetail>) {
    const current = incident.data
    if (!current) return
    setBusy(kind)
    setFailure(null)
    setConflict(null)
    try {
      await action(current.version)
      timeline.reload()
      incident.reload()
    } catch (caught) {
      if (caught instanceof ApiError && caught.isConflict) {
        setConflict(caught.message)
        incident.reload()
      } else {
        setFailure(caught instanceof ApiError ? caught.message : String(caught))
      }
    } finally {
      setBusy(null)
    }
  }

  async function requestAi(note?: string) {
    setBusy('ai')
    setFailure(null)
    try {
      // 202, not 200: this queues work. The UI reflects that by watching for the
      // analysis rather than expecting an answer here.
      await api.requestAiInvestigation(incidentId, note)
      analysis.reload()
      incident.reload()
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  if (incident.error) {
    return (
      <div className="panel">
        <Alert kind="error">{incident.error.message}</Alert>
        <div style={{ marginTop: 12 }}>
          <Link to="/incidents" className="button">
            Back to incidents
          </Link>
        </div>
      </div>
    )
  }

  if (!incident.data) {
    return (
      <div className="panel">
        <Spinner label="Loading incident…" />
      </div>
    )
  }

  const data = incident.data

  return (
    <>
      <div className="page-head">
        <div className="detail-head">
          <div className="row">
            <Link to="/incidents" className="ghost">
              ← Incidents
            </Link>
            <span className="ref" style={{ fontSize: 14 }}>
              {data.reference}
            </span>
            <SeverityBadge severity={data.severity} />
            <StatusBadge status={data.status} />
          </div>
          <h1 style={{ margin: 0 }}>{data.title}</h1>
          <p className="subtitle">
            {serviceRefLabel(data.service)}
            {data.service.ownerTeam ? ` · ${data.service.ownerTeam}` : ''} ·{' '}
            {data.eventCount} event(s) · first seen {formatInstant(data.firstSeenAt)}
          </p>
        </div>
      </div>

      {conflict && (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="warn">
            {conflict} The page has been reloaded to show the current state — check it
            before trying again.
          </Alert>
        </div>
      )}
      {failure && (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="error">{failure}</Alert>
        </div>
      )}

      <div className="split">
        <div className="stack">
          <ActionPanel
            incident={data}
            canWrite={canWrite}
            busy={busy}
            assignable={assignable.data ?? []}
            onAcknowledge={() => run('acknowledge', (version) => api.acknowledge(data.id, version))}
            onInvestigate={() => run('investigate', (version) => api.startInvestigating(data.id, version))}
            onAssign={(assigneeId) => run('assign', (version) => api.assign(data.id, assigneeId, version))}
            onNote={(body) => run('note', (version) => api.addNote(data.id, body, version))}
            onResolve={(rootCause, preventive) =>
              run('resolve', (version) => api.resolve(data.id, rootCause, preventive, version))
            }
          />

          {data.resolvedAt && (
            <div className="panel">
              <h2>Resolution</h2>
              <div className="stack">
                <div>
                  <div className="stat-label">Verified root cause</div>
                  <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{data.resolvedRootCause}</p>
                </div>
                {data.preventiveActions && (
                  <div>
                    <div className="stat-label">Preventive actions</div>
                    <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{data.preventiveActions}</p>
                  </div>
                )}
                <div className="small faint">
                  Resolved {formatInstant(data.resolvedAt)} · open for{' '}
                  {formatDuration(data.firstSeenAt, data.resolvedAt) ?? 'unknown'}
                </div>
              </div>
            </div>
          )}

          <AiPanel
            detail={analysis.data}
            loading={analysis.loading}
            canWrite={canWrite}
            busy={busy === 'ai'}
            onRequest={requestAi}
          />
        </div>

        <div className="stack">
          <EvidencePanel incident={data} />

          <div className="panel">
            <h2>Audit timeline</h2>
            <p className="small faint" style={{ marginTop: -4, marginBottom: 10 }}>
              Append-only. Every state change, note and investigation is recorded with
              its actor.
            </p>
            {timeline.error ? (
              <Alert kind="error">{timeline.error.message}</Alert>
            ) : timeline.loading && !timeline.data ? (
              <Spinner />
            ) : !timeline.data || timeline.data.entries.length === 0 ? (
              <Empty>No timeline entries.</Empty>
            ) : (
              <TimelineList entries={timeline.data.entries} />
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ actions

function ActionPanel({
  incident,
  canWrite,
  busy,
  assignable,
  onAcknowledge,
  onInvestigate,
  onAssign,
  onNote,
  onResolve,
}: {
  incident: IncidentDetail
  canWrite: boolean
  busy: ActionKind | null
  assignable: AssigneeOption[]
  onAcknowledge: () => void
  onInvestigate: () => void
  onAssign: (assigneeId: string | null) => void
  onNote: (body: string) => void
  onResolve: (rootCause: string, preventiveActions: string) => void
}) {
  const [note, setNote] = useState('')
  const [rootCause, setRootCause] = useState('')
  const [preventive, setPreventive] = useState('')
  const [showResolve, setShowResolve] = useState(false)

  const isOpen = incident.status === 'OPEN'
  const isAcknowledged = incident.status === 'ACKNOWLEDGED'
  const isActive = incident.status !== 'RESOLVED'

  // Resolution is the one irreversible transition, so the form stays closed until it
  // is asked for, and the server independently rejects a blank root cause.
  const canResolve = canWrite && isActive && rootCause.trim().length > 0

  return (
    <div className="panel">
      <h2>Actions</h2>

      {!canWrite ? (
        <p className="small muted" style={{ margin: 0 }}>
          You are signed in as a viewer, which is read-only. Every action on this panel
          is rejected by the server, not just hidden here.
        </p>
      ) : (
        <div className="stack">
          <div className="action-bar">
            <button onClick={onAcknowledge} disabled={!isOpen || busy !== null}>
              {busy === 'acknowledge' ? 'Working…' : 'Acknowledge'}
            </button>
            <button
              onClick={onInvestigate}
              disabled={incident.status === 'INVESTIGATING' || !isActive || busy !== null}
            >
              {busy === 'investigate' ? 'Working…' : 'Start investigating'}
            </button>
            <button
              className="danger"
              onClick={() => setShowResolve((value) => !value)}
              disabled={!isActive}
            >
              {showResolve ? 'Cancel resolve' : 'Resolve…'}
            </button>
          </div>

          <Field label="Owner">
            <select
              value={incident.assignedTo?.id ?? ''}
              onChange={(event) => onAssign(event.target.value || null)}
              disabled={busy !== null}
            >
              <option value="">Unassigned</option>
              {assignable.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} ({user.role.toLowerCase()})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Add a note">
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What did you find or try?"
            />
          </Field>
          <div className="action-bar">
            <button
              onClick={() => {
                onNote(note.trim())
                setNote('')
              }}
              disabled={note.trim().length === 0 || busy !== null}
            >
              {busy === 'note' ? 'Saving…' : 'Save note'}
            </button>
          </div>

          {showResolve && (
            <div
              className="stack"
              style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}
            >
              <Alert kind="info">
                Resolving is permanent and requires a verified root cause. This is the
                record the knowledge lookup is built from, so “probably the database”
                is worse than leaving the incident open.
              </Alert>
              <Field label="Verified root cause (required)">
                <textarea
                  value={rootCause}
                  onChange={(event) => setRootCause(event.target.value)}
                  placeholder="What actually caused it, and how do you know?"
                />
              </Field>
              <Field label="Preventive actions (optional)">
                <textarea
                  value={preventive}
                  onChange={(event) => setPreventive(event.target.value)}
                  placeholder="What stops this recurring?"
                />
              </Field>
              <div className="action-bar">
                <button
                  className="primary"
                  disabled={!canResolve || busy !== null}
                  onClick={() => {
                    onResolve(rootCause.trim(), preventive.trim())
                    setRootCause('')
                    setPreventive('')
                    setShowResolve(false)
                  }}
                >
                  {busy === 'resolve' ? 'Resolving…' : 'Resolve incident'}
                </button>
                {!rootCause.trim() && (
                  <span className="small faint">A root cause is required.</span>
                )}
              </div>
            </div>
          )}

          {(isOpen || isAcknowledged) && (
            <p className="small faint" style={{ margin: 0 }}>
              Acknowledging records you as the responder on the timeline. It is
              idempotent, so pressing it twice is harmless.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ evidence

function EvidencePanel({ incident }: { incident: IncidentDetail }) {
  return (
    <div className="panel">
      <h2>Detection evidence</h2>
      <dl className="kv">
        <dt>Rule</dt>
        <dd className="mono">{incident.detectionRuleCode ?? '—'}</dd>

        <dt>Error signature</dt>
        <dd className="mono" style={{ wordBreak: 'break-all' }}>
          {incident.errorSignature ?? '—'}
        </dd>

        <dt>Correlation group</dt>
        <dd className="mono" style={{ wordBreak: 'break-all' }}>
          {incident.correlationGroup ?? '—'}
        </dd>

        <dt>First seen</dt>
        <dd>{formatInstant(incident.firstSeenAt)}</dd>

        <dt>Last seen</dt>
        <dd>{formatInstant(incident.lastSeenAt)}</dd>

        <dt>Events</dt>
        <dd>{incident.eventCount}</dd>

        <dt>Version</dt>
        <dd className="mono">{incident.version}</dd>
      </dl>

      {incident.triggerEvidence && (
        <details className="disclosure" open>
          <summary>Triggering event</summary>
          <div className="raw-output" style={{ background: 'var(--bg-inset)' }}>
            {incident.triggerEvidence}
          </div>
        </details>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ timeline

function TimelineList({ entries }: { entries: TimelineEntry[] }) {
  // Newest first: an operator opening the page wants the most recent state, and the
  // sequence number is still shown so the ordering is verifiable.
  const ordered = useMemo(() => [...entries].sort((a, b) => b.sequence - a.sequence), [entries])

  return (
    <ul className="timeline">
      {ordered.map((entry) => (
        <li key={entry.id} className={entry.eventType.includes('RESOLVED') ? 'accent' : undefined}>
          <div className="timeline-summary">{entry.summary}</div>
          <div className="timeline-meta">
            <span className="mono">#{entry.sequence}</span>
            <span>{formatInstant(entry.createdAt)}</span>
            <span className="faint">{formatRelative(entry.createdAt)}</span>
            {entry.actor && (
              <span>
                {entry.actor.name} · {entry.actor.role.toLowerCase()}
              </span>
            )}
          </div>
          {entry.eventType === 'NOTE' && entry.payload?.note ? (
            <div className="timeline-payload">{String(entry.payload.note)}</div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

// ------------------------------------------------------------------ AI panel

function AiPanel({
  detail,
  loading,
  canWrite,
  busy,
  onRequest,
}: {
  detail: AnalysisDetail | undefined
  loading: boolean
  canWrite: boolean
  busy: boolean
  onRequest: (note?: string) => void
}) {
  const { isAdmin } = useAuth()
  const [showRaw, setShowRaw] = useState(false)
  const [raw, setRaw] = useState<Awaited<ReturnType<typeof api.rawResponse>> | null>(null)
  const [rawError, setRawError] = useState<string | null>(null)

  async function toggleRaw() {
    if (showRaw) {
      setShowRaw(false)
      return
    }
    if (!detail) return
    setRawError(null)
    try {
      setRaw(await api.rawResponse(detail.id))
    } catch (caught) {
      setRawError(caught instanceof ApiError ? caught.message : String(caught))
    }
    setShowRaw(true)
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>AI investigation</h2>
        {detail && <AnalysisStatusBadge status={detail.status} />}
      </div>

      {canWrite && (
        <div className="action-bar" style={{ marginBottom: 12 }}>
          <button onClick={() => onRequest()} disabled={busy}>
            {busy ? 'Queueing…' : 'Request investigation'}
          </button>
          <span className="small faint">
            Queues work on a background worker. The result appears here when it lands.
          </span>
        </div>
      )}

      {loading && !detail ? (
        <Spinner />
      ) : !detail ? (
        <Empty>
          No investigation has been requested for this incident.
          {canWrite && <div className="small">Auto-investigation runs after several events are correlated.</div>}
        </Empty>
      ) : (
        <AiBody
          detail={detail}
          isAdmin={isAdmin}
          showRaw={showRaw}
          raw={raw}
          rawError={rawError}
          onToggleRaw={toggleRaw}
        />
      )}
    </div>
  )
}

function AiBody({
  detail,
  isAdmin,
  showRaw,
  raw,
  rawError,
  onToggleRaw,
}: {
  detail: AnalysisDetail
  isAdmin: boolean
  showRaw: boolean
  raw: Awaited<ReturnType<typeof api.rawResponse>> | null
  rawError: string | null
  onToggleRaw: () => void
}) {
  return (
    <div className="stack">
      <div className="row small faint">
        <span className="mono">{detail.reference}</span>
        <span>{detail.modelName}</span>
        <span>prompt {detail.promptVersion}</span>
        <span>trigger: {detail.triggerReason}</span>
        {detail.durationMs !== undefined && <span>took {formatMillis(detail.durationMs)}</span>}
        {detail.attemptCount > 1 && (
          <span>
            {detail.attemptCount} attempts
          </span>
        )}
      </div>

      {detail.status === 'REJECTED' && (
        <Alert kind="warn">
          This response was rejected by validation ({detail.errorCode}) and is not shown
          as analysis. {detail.errorMessage}
        </Alert>
      )}
      {detail.status === 'FAILED' && (
        <Alert kind="error">
          The provider call failed ({detail.errorCode}). {detail.errorMessage}
        </Alert>
      )}
      {(detail.status === 'QUEUED' || detail.status === 'RUNNING') && (
        <Alert kind="info">
          {detail.status === 'QUEUED'
            ? 'Queued. A worker will pick it up shortly.'
            : 'The model is being called now.'}
        </Alert>
      )}

      {detail.analysis && (
        <>
          <p style={{ margin: 0 }}>{detail.analysis.summary}</p>

          {detail.analysis.hypotheses.map((hypothesis, index) => (
            <div className="hypothesis" key={index}>
              <div className="hypothesis-cause">
                {index + 1}. {hypothesis.cause}
              </div>
              <div className="confidence">
                <span className="confidence-bar">
                  <span className="confidence-fill" style={{ width: `${percent(hypothesis.confidence)}%` }} />
                </span>
                {/* Labelled as the model's estimate, not a probability. The backend
                    validates the structure of a response; it does not calibrate it. */}
                <span className="confidence-value">
                  model confidence {percent(hypothesis.confidence)}%
                </span>
              </div>

              {hypothesis.evidence.length > 0 && (
                <>
                  <div className="stat-label">Evidence cited</div>
                  <ul className="evidence-list">
                    {hypothesis.evidence.map((line, lineIndex) => (
                      <li key={lineIndex}>{line}</li>
                    ))}
                  </ul>
                </>
              )}

              {hypothesis.nextChecks.length > 0 && (
                <>
                  <div className="stat-label" style={{ marginTop: 8 }}>
                    Suggested checks
                  </div>
                  <ul className="evidence-list">
                    {hypothesis.nextChecks.map((line, lineIndex) => (
                      <li key={lineIndex}>{line}</li>
                    ))}
                  </ul>
                </>
              )}

              {hypothesis.evidenceEventIds.length > 0 && (
                <div className="small faint mono" style={{ marginTop: 6 }}>
                  cites {hypothesis.evidenceEventIds.length} stored event(s)
                </div>
              )}
            </div>
          ))}

          {detail.analysis.missingEvidence.length > 0 && (
            <>
              <div className="stat-label" style={{ marginTop: 4 }}>
                Evidence it says is missing
              </div>
              <ul className="evidence-list">
                {detail.analysis.missingEvidence.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </>
          )}

          {detail.analysis.caveats.length > 0 && (
            <>
              <div className="stat-label" style={{ marginTop: 4 }}>
                Caveats
              </div>
              <ul className="evidence-list">
                {detail.analysis.caveats.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </>
          )}

          <p className="ai-disclaimer">
            This is a suggestion, not a finding. Nothing on this panel changed the
            incident, and no part of the system acted on it automatically.
          </p>
        </>
      )}

      {isAdmin && (
        <div>
          <details className="disclosure" open={showRaw}>
            <summary onClick={onToggleRaw}>
              Unvalidated model output (admin)
            </summary>
            {showRaw && (
              <>
                {rawError && (
                  <div style={{ marginTop: 8 }}>
                    <Alert kind="error">{rawError}</Alert>
                  </div>
                )}
                {raw && (
                  <>
                    <p className="small faint" style={{ margin: '6px 0 0' }}>
                      Exactly what the model returned, before validation. It may contain
                      instruction-shaped text copied out of a log payload — it is
                      evidence, not instruction.
                    </p>
                    {/* Preformatted text, never markup. */}
                    <div className="raw-output">{raw.unvalidated ?? '(empty)'}</div>
                  </>
                )}
              </>
            )}
          </details>
        </div>
      )}
    </div>
  )
}