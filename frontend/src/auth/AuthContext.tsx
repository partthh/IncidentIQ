/**
 * Authentication state.
 *
 * The session is established by `/auth/login` and *revalidated* by `/auth/me` on
 * mount. Revalidation is what makes a reload honest: a token in localStorage might
 * be expired, revoked in spirit, or from a different environment, and the only way to
 * know is to ask the server.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { configureApi } from '../api/client'
import * as api from '../api/endpoints'
import type { UserView } from '../api/types'
import { clearSession, isExpired, readSession, readToken, writeSession } from './session'

export interface AuthState {
  user: UserView | null
  token: string | null
  status: 'unknown' | 'authenticated' | 'anonymous'
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => void
  canWrite: boolean
  isAdmin: boolean
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(() => readSession())
  const [status, setStatus] = useState<AuthState['status']>('unknown')

  const signOut = useCallback(() => {
    clearSession()
    setSession(null)
    setStatus('anonymous')
  }, [])

  // The HTTP client needs the current token without importing this module.
  // configureApi is called at module scope with a ref-like closure so a token
  // change is picked up on the next request rather than being captured once.
  useEffect(() => {
    configureApi({
      getToken: () => readToken(),
      onUnauthorized: signOut,
    })
  }, [signOut])

  useEffect(() => {
    let cancelled = false

    const stored = readSession()
    if (!stored || isExpired(stored.expiresAt)) {
      // Expired locally: clear it rather than letting the first page load fail.
      clearSession()
      setSession(null)
      setStatus('anonymous')
      return
    }

    // Show the cached user immediately, then confirm with the server.
    setSession(stored)
    setStatus('authenticated')

    api
      .me()
      .then((user) => {
        if (cancelled) return
        const next = { ...stored, user }
        writeSession(next)
        setSession(next)
      })
      .catch(() => {
        if (cancelled) return
        signOut()
      })

    return () => {
      cancelled = true
    }
    // Runs once per mount: the intent is "is the stored token still good", which is
    // a question about the token, not about the session object's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signOut])

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await api.login(email, password)
    const next = { token: response.accessToken, user: response.user, expiresAt: response.expiresAt }
    writeSession(next)
    setSession(next)
    setStatus('authenticated')
  }, [])

  const value = useMemo<AuthState>(() => {
    const role = session?.user.role
    return {
      user: session?.user ?? null,
      token: session?.token ?? null,
      status,
      signIn,
      signOut,
      // VIEWER is read-only by design, not by accident: the server enforces the same
      // rule, and hiding the buttons just avoids offering a guaranteed 403.
      canWrite: role === 'ADMIN' || role === 'ENGINEER',
      isAdmin: role === 'ADMIN',
    }
  }, [session, status, signIn, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}