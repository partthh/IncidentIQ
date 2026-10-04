/**
 * Formatting helpers.
 *
 * Kept in one file because the interesting decisions are about consistency: an
 * incident table and a detail header must show the same instant the same way, or an
 * engineer comparing them concludes the two disagree about when something happened.
 */

/** Absolute local time, to the second. */
export function formatInstant(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * Relative time, for "how long has this been open".
 *
 * * `null` when the timestamp is missing or unparseable. Rendering "0s ago" for a
 *   missing timestamp would assert a duration nobody measured.
 */
export function formatRelative(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null

  const seconds = Math.round((now - then) / 1000)
  const future = seconds < 0
  const abs = Math.abs(seconds)

  const text =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.floor(abs / 60)}m ${abs % 60}s`
        : abs < 86400
          ? `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`
          : `${Math.floor(abs / 86400)}d ${Math.floor((abs % 86400) / 3600)}h`

  return future ? `in ${text}` : `${text} ago`
}

/** Elapsed between two instants, or null when either is missing. */
export function formatDuration(fromIso: string | undefined, toIso: string | undefined): string | null {
  if (!fromIso || !toIso) return null
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null

  const seconds = Math.round((to - from) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * Milliseconds as a compact duration, or null when there is nothing to show.
 *
 * <p>Nullish <em>and</em> non-finite input are both rejected. A formatter that returns
 * "NaNms" is worse than one that returns null: the string renders as plausible text and
 * nobody downstream notices that the measurement never existed. A JSON field typed
 * `number | null` can still arrive as `undefined` if the API omits it rather than
 * sending null, so the guard cannot be a null comparison alone.
 */
export function formatMillis(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Percentage as an integer, for confidence bars. Clamped, never NaN. */
export function percent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value * 100)))
}

/** "payment-service / staging", the form used everywhere a service is named. */
export function serviceLabel(name: string, environment?: string): string {
  return environment ? `${name} / ${environment}` : name
}

/**
 * Label for a nested service reference.
 *
 * <p>The incident payloads carry the service as a nested `{name, environment}` pair
 * rather than the denormalised `qualifiedName` that the service registry returns, so
 * the label is composed here instead of being read from the wrong place.
 */
export function serviceRefLabel(service: { name: string; environment: string }): string {
  return serviceLabel(service.name, service.environment)
}