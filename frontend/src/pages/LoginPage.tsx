/**
 * Sign-in.
 *
 * A split screen: a brand panel that behaves like a small slice of the product —
 * live signal bars, a rotating incident ticker, headline numbers — so the first
 * screen of the app feels alive instead of like a static form. The form itself
 * sits in its own card with floating labels, a password toggle and a shake on
 * rejected credentials.
 *
 * No seeded accounts are listed. A login page that offers valid credentials is a
 * login page nobody should deploy; the demo logins live in the README and the
 * start scripts instead of on screen.
 */

import { useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'

import { ApiError } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { Alert } from '../ui/components'

/** Rotating lines for the brand-panel ticker — incident-flavoured, not decoration. */
const TICKER = [
  'SEV-1 · Checkout latency p99 4.2s — acknowledged by on-call',
  'Anomaly · auth-service error rate +312% over 5 minutes',
  'Runbook complete · traffic failed over to eu-west-1',
  '1,284 events/min ingested · 12 awaiting triage',
  'MTTA holding at 42s · 96% of alerts auto-enriched',
]

const STATS: Array<{ value: string; label: string }> = [
  { value: '99.98%', label: '30-day uptime' },
  { value: '42s', label: 'median ack' },
  { value: '24/7', label: 'autonomous triage' },
]

/** Bar heights vary per column so the meter reads as a signal, not a pattern. */
const BARS = Array.from({ length: 18 }, (_, index) => ({
  delay: `${(index * 0.11).toFixed(2)}s`,
  duration: `${(1.3 + (index % 5) * 0.22).toFixed(2)}s`,
}))

function MailIcon() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7.5 8.5 5.5 8.5-5.5" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10" width="15" height="10" rx="2" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </svg>
  )
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M3 3.5 21 20.5" />
          <path d="M10.7 5.2A11.4 11.4 0 0 1 12 5c6.5 0 10 6.5 10 6.5a17.9 17.9 0 0 1-3.5 4.2" />
          <path d="M6.4 6.7A17.6 17.6 0 0 0 2 11.5S5.5 18 12 18a11 11 0 0 0 4.4-.9" />
          <path d="M9.9 10a3 3 0 0 0 4.2 4.2" />
        </>
      ) : (
        <>
          <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  )
}

function ShieldLogo() {
  return (
    <svg className="brand-glyph" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 2.5 4.5 7v9.6c0 6.6 4.7 11.4 11.5 12.9 6.8-1.5 11.5-6.3 11.5-12.9V7L16 2.5z" />
      <path d="M9.5 16.2h3.2l1.8-4.4 2.6 8 1.7-3.6h3.7" />
    </svg>
  )
}

export function LoginPage() {
  const { signIn, status } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Bumped on every rejection so the card can re-mount its shake animation. */
  const [rejected, setRejected] = useState(0)
  const [tickerIndex, setTickerIndex] = useState(0)

  useEffect(() => {
    const id = window.setInterval(
      () => setTickerIndex((current) => (current + 1) % TICKER.length),
      4200,
    )
    return () => window.clearInterval(id)
  }, [])

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
      setRejected((count) => count + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-shell">
        {/* Brand panel: a small piece of the product, not a marketing block. */}
        <aside className="login-brand" aria-hidden="true">
          <div className="brand-top">
            <ShieldLogo />
            <div>
              <div className="brand-name">SentinelAI</div>
              <div className="brand-tag">incident intelligence</div>
            </div>
          </div>

          <p className="brand-lede">
            Correlates every alert across your stack, drafts the root cause, and wakes the
            right engineer — before the dashboard does.
          </p>

          <div className="signal-card">
            <div className="signal-head">
              <span className="live">
                <span className="live-dot" /> live signal
              </span>
              <span>ingest · global</span>
            </div>
            <div className="signal-bars">
              {BARS.map((bar, index) => (
                <i key={index} style={{ animationDelay: bar.delay, animationDuration: bar.duration }} />
              ))}
            </div>
          </div>

          {/* Remounted per line so the entrance animation replays on every swap. */}
          <div className="ticker" key={tickerIndex}>
            <span className="ticker-kind">{['sev-1', 'anomaly', 'runbook', 'ingest', 'mtta'][tickerIndex]}</span>
            <p>{TICKER[tickerIndex]}</p>
          </div>

          <dl className="brand-stats">
            {STATS.map((stat) => (
              <div key={stat.label}>
                <dt>{stat.label}</dt>
                <dd>{stat.value}</dd>
              </div>
            ))}
          </dl>
        </aside>

        {/* Form card. The shake wrapper is keyed so a rejection replays it. */}
        <section className="login-pane">
          <div className="brand-compact">
            <ShieldLogo />
            <span>SentinelAI</span>
          </div>

          <div className={rejected > 0 ? 'login-shake' : undefined} key={rejected}>
            <header className="login-head">
              <h1>Welcome back</h1>
              <p className="subtitle">Sign in to the incident feed</p>
            </header>

            {error && (
              <div style={{ marginTop: 16 }}>
                <Alert kind="error">{error}</Alert>
              </div>
            )}

            <form onSubmit={submit} className="login-form">
              <div className="login-field">
                <MailIcon />
                <input
                  id="login-email"
                  type="email"
                  placeholder=" "
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  required
                  autoFocus
                />
                <label htmlFor="login-email">Email address</label>
              </div>

              <div className="login-field">
                <LockIcon />
                <input
                  id="login-password"
                  type={revealed ? 'text' : 'password'}
                  placeholder=" "
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
                <label htmlFor="login-password">Password</label>
                <button
                  type="button"
                  className="pw-toggle"
                  onClick={() => setRevealed((shown) => !shown)}
                  aria-label={revealed ? 'Hide password' : 'Show password'}
                  aria-pressed={revealed}
                  tabIndex={-1}
                >
                  <EyeIcon off={revealed} />
                </button>
              </div>

              <button type="submit" className="primary login-submit" disabled={busy}>
                {busy ? (
                  <>
                    <span className="spinner" /> Signing in…
                  </>
                ) : (
                  <>
                    Sign in
                    <span className="btn-shine" aria-hidden="true" />
                  </>
                )}
              </button>
            </form>

            <p className="login-note">Encrypted session · access attempts are logged</p>
          </div>
        </section>
      </div>
    </div>
  )
}
