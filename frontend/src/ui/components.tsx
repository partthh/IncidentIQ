/**
 * Small presentational primitives.
 *
 * Each carries a note about *why* it looks the way it does, because the styling
 * choices here are load-bearing rather than cosmetic: severity must be readable at a
 * glance, and every badge keeps its label in text so colour is never the only channel.
 */

import type { AnalysisStatus, IncidentStatus, Severity } from '../api/types'

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`badge sev-${severity}`}>
      <span className="badge-dot" />
      {severity}
    </span>
  )
}

export function StatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`badge status-${status}`}>{status.toLowerCase()}</span>
}

/**
 * QUEUED and RUNNING pulse: work genuinely is in flight, and an operator watching the
 * queue should be able to see the difference between "waiting" and "working" without
 * reading the word.
 */
export function AnalysisStatusBadge({ status }: { status: AnalysisStatus }) {
  const inFlight = status === 'QUEUED' || status === 'RUNNING'
  return (
    <span className={`badge analysis-${status}`}>
      {inFlight && <span className="badge-dot pulse" />}
      {status.toLowerCase()}
    </span>
  )
}

export function Field({
  label,
  children,
  error,
  className,
}: {
  label: string
  children: React.ReactNode
  error?: string
  className?: string
}) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label>{label}</label>
      {children}
      {error && <div className="field-error">{error}</div>}
    </div>
  )
}

export function Alert({
  kind,
  children,
}: {
  kind: 'error' | 'warn' | 'info'
  children: React.ReactNode
}) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{kind === 'error' ? '✕' : kind === 'warn' ? '!' : 'i'}</span>
      <span>{children}</span>
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="loading-row">
      <span className="spinner" />
      {label ?? 'Loading…'}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>
}

/**
 * Horizontal bar list, used for the busiest-services and severity breakdowns.
 *
 * The bar width is a proportion of the largest value, not of a total, because the
 * series rarely sums to anything meaningful and a bar that looked like a share of the
 * total would imply one.
 */
export function BarList({
  rows,
  emptyText = 'Nothing to show yet',
}: {
  rows: Array<{ label: string; value: number }>
  emptyText?: string
}) {
  if (rows.length === 0) return <div className="small faint">{emptyText}</div>
  const max = rows.reduce((peak, row) => Math.max(peak, row.value), 0)
  return (
    <div className="bar-list">
      {rows.map((row) => (
        <div className="bar-row" key={row.label}>
          <span className="bar-label" title={row.label}>
            {row.label}
          </span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{ width: `${max > 0 ? Math.max(2, (row.value / max) * 100) : 0}%` }}
            />
          </span>
          <span className="bar-value">{row.value}</span>
        </div>
      ))}
    </div>
  )
}