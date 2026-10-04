/**
 * Application shell: routing, the top bar, and the live connection indicator.
 *
 * Routing is deliberately shallow — two authenticated pages. A dashboard for this
 * problem is a feed and a detail view; anything more would be navigation for its own
 * sake.
 */

import { Link, Navigate, Route, Routes } from 'react-router-dom'

import { useAuth } from './auth/AuthContext'
import { IncidentDetailPage } from './pages/IncidentDetailPage'
import { IncidentFeedPage } from './pages/IncidentFeedPage'
import { LoginPage } from './pages/LoginPage'
import { RealtimeProvider, useRealtime } from './realtime/RealtimeContext'

function ConnectionIndicator() {
  const { state, eventCount } = useRealtime()

  const label =
    state === 'connected'
      ? 'live'
      : state === 'connecting'
        ? 'connecting'
        : state === 'reconnecting'
          ? 'reconnecting'
          : state === 'disconnected'
            ? 'disconnected'
            : 'offline'

  const title =
    state === 'connected'
      ? `Connected to the incident feed. ${eventCount} update(s) received this session.`
      : 'The dashboard falls back to polling-free manual refresh until the feed reconnects.'

  return (
    <span className={`conn conn-${state}`} title={title}>
      <span className="conn-dot" />
      {label}
      {state === 'connected' && eventCount > 0 && <span className="mono faint">({eventCount})</span>}
    </span>
  )
}

function TopBar() {
  const { user, signOut } = useAuth()

  return (
    <header className="topbar">
      <Link to="/incidents" className="brand">
        SentinelAI <span>incident intelligence</span>
      </Link>
      <div className="topbar-spacer" />
      <ConnectionIndicator />
      {user && (
        <>
          <span className="small muted">
            {user.name} · <span className="mono">{user.role.toLowerCase()}</span>
          </span>
          <button className="ghost" onClick={signOut}>
            Sign out
          </button>
        </>
      )}
    </header>
  )
}

/**
 * Gates the app on authentication.
 *
 * `status === 'unknown'` means `/auth/me` has not answered yet. Rendering the login
 * form during that window would flash it at a user who is signed in, so the shell
 * waits — and says it is waiting, rather than showing a blank page.
 */
function Gate() {
  const { status, token } = useAuth()

  if (status === 'unknown') {
    return (
      <div className="login-wrap">
        <div className="loading-row">
          <span className="spinner" />
          Restoring session…
        </div>
      </div>
    )
  }

  if (status === 'anonymous' || !token) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <RealtimeProvider token={token} enabled={status === 'authenticated'}>
      <div className="app">
        <TopBar />
        <main className="content">
          <Routes>
            <Route path="/incidents" element={<IncidentFeedPage />} />
            <Route path="/incidents/:incidentId" element={<IncidentDetailPage />} />
            <Route path="*" element={<Navigate to="/incidents" replace />} />
          </Routes>
        </main>
      </div>
    </RealtimeProvider>
  )
}

export function App() {
  return <Gate />
}