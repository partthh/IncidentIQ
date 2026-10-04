/**
 * HTTP client.
 *
 * One place that knows how to talk to the backend: base path, bearer token,
 * error translation. Every endpoint in the app goes through `request`, so there is
 * exactly one place where a 401 causes a logout and exactly one place where the
 * server's error envelope becomes a thrown `ApiError`.
 */

import type { ApiErrorBody } from './types'

export const API_BASE = '/api/v1'

/**
 * A failed request, carrying the server's machine-readable code.
 *
 * The UI branches on `code` rather than on the message text: `CONFLICT` means
 * "reload and retry", `VALIDATION_FAILED` means "show the field errors", and those
 * are decisions the client should make from a stable identifier.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: Record<string, string>
  readonly traceId?: string

  constructor(body: ApiErrorBody, fallbackMessage: string) {
    super(body.message || fallbackMessage)
    this.name = 'ApiError'
    this.status = body.status ?? 0
    this.code = body.code ?? 'UNKNOWN'
    if (body.details) this.details = body.details
    if (body.traceId) this.traceId = body.traceId
  }

  /** Optimistic-locking loss. The backend's message tells the user what to do. */
  get isConflict(): boolean {
    return this.status === 409
  }

  get isForbidden(): boolean {
    return this.status === 403
  }

  get isUnauthenticated(): boolean {
    return this.status === 401
  }

  /** Field-level validation messages, if the server sent any. */
  get fieldErrors(): Array<{ field: string; message: string }> {
    return Object.entries(this.details ?? {}).map(([field, message]) => ({ field, message }))
  }
}

type TokenReader = () => string | null
type UnauthorizedHandler = () => void

let readToken: TokenReader = () => null
let onUnauthorized: UnauthorizedHandler = () => {}

/**
 * Wires the client to the auth store.
 *
 * Dependency injection rather than a module import of the React context: the client
 * is used by non-React code paths too, and an import cycle through `main.tsx` would
 * make the failure mode a null context at module-evaluation time.
 */
export function configureApi(options: {
  getToken: TokenReader
  onUnauthorized: UnauthorizedHandler
}): void {
  readToken = options.getToken
  onUnauthorized = options.onUnauthorized
}

export type Query = Record<string, string | number | boolean | undefined | null>

function buildUrl(path: string, query?: Query): string {
  const url = `${API_BASE}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    // Absent filters must be omitted, not sent as "null": the backend reads an
    // empty string as a filter value, and `since=""` is not the same as no filter.
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `${url}?${encoded}` : url
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Query
  /** Send `If-Match` instead of an in-body `expectedVersion`. */
  ifMatch?: number
  /** 404 is a legitimate answer for optional sub-resources, not an error. */
  allowNotFound?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = readToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.ifMatch !== undefined) headers['If-Match'] = `"${options.ifMatch}"`

  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  if (response.status === 204) return undefined as T

  if (!response.ok) {
    if (response.status === 401) onUnauthorized()
    if (response.status === 404 && options.allowNotFound) return undefined as T

    let body: ApiErrorBody | null = null
    try {
      body = (await response.json()) as ApiErrorBody
    } catch {
      body = null
    }
    throw new ApiError(
      body ?? { status: response.status, code: 'UNKNOWN', message: response.statusText || 'Request failed' },
      `Request to ${path} failed with ${response.status}`,
    )
  }

  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}