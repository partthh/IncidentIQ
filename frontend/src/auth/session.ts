/**
 * Token storage.
 *
 * `localStorage` rather than a cookie because the API is stateless bearer-token
 * authenticated and the dashboard is a separate origin from the API in every
 * deployment. That choice has a cost — an XSS bug would be able to read the token —
 * and the mitigation is not to store less but to render untrusted text as text
 * (see the raw-response panel) so there is nothing to execute.
 *
 * Nothing is trusted from storage to decide authorisation. The role shown in the UI
 * comes from `/auth/me`, and the server re-checks every request; the cached role
 * exists only to hide buttons that would fail anyway.
 */

import type { UserView } from '../api/types'

const TOKEN_KEY = 'sentinel.token'
const USER_KEY = 'sentinel.user'
const EXPIRY_KEY = 'sentinel.expiresAt'

export interface StoredSession {
  token: string
  user: UserView
  expiresAt: string
}

export function readToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function readSession(): StoredSession | null {
  const token = readToken()
  if (!token) return null
  const user = localStorage.getItem(USER_KEY)
  const expiresAt = localStorage.getItem(EXPIRY_KEY)
  if (!user || !expiresAt) return null
  try {
    return { token, user: JSON.parse(user) as UserView, expiresAt }
  } catch {
    // A corrupt entry must not brick the app; clear it and start at the login screen.
    clearSession()
    return null
  }
}

export function writeSession(session: StoredSession): void {
  localStorage.setItem(TOKEN_KEY, session.token)
  localStorage.setItem(USER_KEY, JSON.stringify(session.user))
  localStorage.setItem(EXPIRY_KEY, session.expiresAt)
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(EXPIRY_KEY)
}

/**
 * Cheap client-side expiry check.
 *
 * This is a courtesy, not a security control: it avoids showing a logged-in shell
 * whose every request is about to 401. The server is the only authority, which is
 * why a refresh always calls `/auth/me` rather than trusting the cached user.
 */
export function isExpired(expiresAt: string, skewSeconds = 30): boolean {
  const expiry = Date.parse(expiresAt)
  if (Number.isNaN(expiry)) return true
  return Date.now() >= expiry - skewSeconds * 1000
}