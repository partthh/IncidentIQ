/**
 * Sign-in.
 *
 * The seeded accounts are listed as clickable buttons. That is a convenience for a
 * portfolio demo, and it is labelled as one — a real deployment would not ship it,
 * because a login page that offers valid credentials is a login page nobody should
 * deploy. The password is printed because the backend seeds it and the README says so.
 */

import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'

import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert, Field } from '../ui/components'

const SEED_ACCOUNTS = [
  { email: 'admin@sentinel.dev', role: 'admin' },
  { email: 'priya@sentinel.dev', role: 'engineer' },
  { email: 'viewer@sentinel.dev', role: 'viewer' },
]

const DEMO_PASSWORD = 'sentinel123'

export function LoginPage() {
  const { signIn, status } = useAuth()
  const [email, setEmail] = useState(SEED_ACCOUNTS[1]?.email ?? '')
  const [password, setPassword] = useState(DEMO_PASSWORD)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'authenticated') return <Navigate to="/incidents" replace />

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signIn(email.trim(), password)
    } catch (caught) {
      // The server deliberately does not distinguish "no such user" from "wrong
      // password"; neither does this message.
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Is the backend running on port 8080?',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="panel">
          <h1>SentinelAI</h1>
          <p className="subtitle">Sign in to the incident feed</p>

          <form onSubmit={submit} style={{ marginTop: 18 }}>
            {error && (
              <div style={{ marginBottom: 12 }}>
                <Alert kind="error">{error}</Alert>
              </div>
            )}

            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                autoFocus
              />
            </Field>

            <Field label="Password">
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>

            <button
              type="submit"
              className="primary"
              style={{ width: '100%', marginTop: 14 }}
              disabled={busy}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="seed-list">
            <h3>Seeded accounts · demo only</h3>
            {SEED_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                className="seed-account"
                onClick={() => {
                  setEmail(account.email)
                  setPassword(DEMO_PASSWORD)
                }}
              >
                <span>
                  {account.email} <code>{account.role}</code>
                </span>
                <span aria-hidden="true">→</span>
              </button>
            ))}
            <p className="small faint" style={{ marginBottom: 0 }}>
              Password <code>{DEMO_PASSWORD}</code>. A viewer can read everything and change
              nothing — the server enforces it, this page just hides the buttons.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}