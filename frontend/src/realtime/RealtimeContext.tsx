/**
 * The live connection.
 *
 * Design stance, taken straight from the backend's own contract: **delivery here is
 * not durable, the database is the record.** Every envelope is treated as "something
 * changed, go look" — never as "here is the new state". That is why subscribers
 * re-fetch REST snapshots instead of patching their local copy from the payload:
 * the payload is a partial snapshot (no assignee, no firstSeenAt) and a client that
 * trusted it would render a plausible incident that never existed.
 *
 * Three things this layer is responsible for, and which are easy to get wrong:
 *
 *  1. The token travels in the STOMP CONNECT frame, not in the WebSocket URL. A URL
 *     token ends up in proxy access logs and browser history.
 *  2. Redelivery is expected. A reconnecting TCP connection can resend messages, so
 *     every `eventId` is remembered in a bounded set and duplicates are dropped. The
 *     bound matters: an unbounded set is a memory leak on a long-lived dashboard.
 *  3. Reconnects need backoff, and the backoff needs a ceiling. A backend restart
 *     must not turn into a reconnect storm.
 */

import { Client, type IMessage } from '@stomp/stompjs'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { RealtimeEnvelope } from '../api/types'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/** How many event ids to remember for deduplication. */
const SEEN_LIMIT = 2_000

/**
 * Bounded insertion-ordered set. `Set` preserves insertion order, so dropping the
 * first key evicts the oldest — exactly the eviction policy wanted here, and no
 * dependency needed.
 */
class BoundedSet {
  private readonly keys = new Set<string>()

  constructor(private readonly limit: number) {}

  /** @returns true if the key is new, false if it was already seen */
  add(key: string): boolean {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    if (this.keys.size > this.limit) {
      const oldest = this.keys.values().next()
      if (!oldest.done) this.keys.delete(oldest.value)
    }
    return true
  }
}

export interface RealtimeState {
  state: ConnectionState
  /** Live envelopes, newest last. Replays nothing; the feed page refetches on demand. */
  lastEvent: RealtimeEnvelope | null
  /** Count of distinct envelopes seen since connect. Useful as a liveness indicator. */
  eventCount: number
  subscribe: (destination: string, onEnvelope: (envelope: RealtimeEnvelope) => void) => () => void
}

const RealtimeContext = createContext<RealtimeState | null>(null)

const FEED_DESTINATION = '/topic/incidents'
export const incidentTopic = (incidentId: string) => `/topic/incidents/${incidentId}`

/**
 * The STOMP handshake target, ending in `/ws`. The token is not in it.
 *
 * Same-origin by default, which is what holds everywhere this repository ships:
 * vite proxies `/ws` in dev and nginx proxies it in Docker. The exception is a
 * static host that cannot forward an upgrade — Vercel's rewrites proxy HTTP but
 * not the WebSocket `Upgrade`, so a `/ws` rewrite there just answers with the SPA
 * shell. A deploy on such a host sets `VITE_WS_URL` to the backend's origin in its
 * build environment and the browser opens the socket there directly. That
 * cross-origin handshake needs nothing beyond the backend's origin allow-list
 * (`SENTINEL_SECURITY_ALLOWED_ORIGINS`): the token travels in the STOMP CONNECT
 * frame and the upgrade request carries no credentials of its own.
 */
function resolveBrokerURL(): string {
  const origin =
    import.meta.env.VITE_WS_URL ||
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  // `https://host` is not a WebSocket URL: accept the origin a deployer already has
  // in hand rather than making them remember which scheme a socket needs, and drop
  // a trailing slash so the path never comes out as `//ws`.
  return `${origin.replace(/^http/, 'ws').replace(/\/+$/, '')}/ws`
}

export function RealtimeProvider({
  token,
  enabled,
  children,
}: {
  token: string | null
  enabled: boolean
  children: ReactNode
}) {
  const [state, setState] = useState<ConnectionState>('idle')
  const [lastEvent, setLastEvent] = useState<RealtimeEnvelope | null>(null)
  const [eventCount, setEventCount] = useState(0)

  const clientRef = useRef<Client | null>(null)
  const seenRef = useRef(new BoundedSet(SEEN_LIMIT))
  // Subscribers are held in a ref so the socket effect never rebuilds the
  // connection just because a component mounted or unmounted.
  const listenersRef = useRef(new Map<string, Set<(envelope: RealtimeEnvelope) => void>>())
  // Destinations with a live STOMP subscription, so one subscription serves every
  // listener on that destination. Keyed by destination rather than by id because the
  // id only ever exists to identify the subscription being removed.
  const subscribedRef = useRef(new Set<string>())
  // Set by the socket effect and read by `subscribe`, which is created once and must
  // not close over a stale client.
  const dispatchRef = useRef<(destination: string, message: IMessage) => void>(() => {})

  useEffect(() => {
    if (!enabled || !token) {
      setState('idle')
      return
    }

    const seen = seenRef.current
    seenRef.current = new BoundedSet(SEEN_LIMIT)
    setEventCount(0)
    setLastEvent(null)

    const client = new Client({
      brokerURL: resolveBrokerURL(),
      connectHeaders: { Authorization: `Bearer ${token}` },
      // Reconnection is on, with a ceiling. A restarted backend must not become a
      // reconnect storm; a long outage must not become a permanently dead dashboard.
      reconnectDelay: 2_000,
      heartbeatIncoming: 10_000,
      heartbeatOutgoing: 10_000,
      debug: () => {},
    })

    /**
     * Fan-out for one destination.
     *
     * <p>Every envelope — whether it arrives on the feed subscription or an incident
     * one — passes through here, so deduplication cannot be bypassed by a listener
     * that subscribed after the socket came up. An earlier version gave late listeners
     * their own STOMP subscription with a direct handler, which meant a redelivered
     * message was applied twice to exactly those listeners.
     */
    const dispatch = (destination: string, message: IMessage) => {
      let envelope: RealtimeEnvelope
      try {
        envelope = JSON.parse(message.body) as RealtimeEnvelope
      } catch {
        return
      }
      // Dedupe on the server-assigned id. Redelivery after a reconnect is normal,
      // not a bug, and applying it twice would double-count timeline entries.
      if (!seen.add(envelope.eventId)) return

      setLastEvent(envelope)
      setEventCount((count) => count + 1)
      for (const listener of [...(listenersRef.current.get(destination) ?? [])]) {
        listener(envelope)
      }
    }
    dispatchRef.current = dispatch

    /** Creates the STOMP subscription for a destination, once. */
    const ensureSubscribed = (destination: string) => {
      if (!client.connected || subscribedRef.current.has(destination)) return
      subscribedRef.current.add(destination)
      client.subscribe(destination, (message: IMessage) => dispatch(destination, message), {
        id: `sub-${destination}`,
      })
    }

    client.onConnect = () => {
      setState('connected')
      ensureSubscribed(FEED_DESTINATION)
      // Re-attach everything registered while the socket was down. A reconnect clears
      // the server-side subscriptions, so this is required, not tidy-up.
      for (const destination of listenersRef.current.keys()) {
        ensureSubscribed(destination)
      }
    }
    client.onWebSocketClose = () => {
      subscribedRef.current.clear()
      setState('reconnecting')
    }
    client.onStompError = (frame) => {
      // A refused CONNECT means the token is bad, not the network. Retrying forever
      // would hammer the server with a request that cannot succeed.
      if (frame.headers.message?.includes('Authorization')) {
        setState('disconnected')
        void client.deactivate()
      } else {
        setState('reconnecting')
      }
    }
    client.onDisconnect = () => setState('disconnected')

    client.activate()
    setState('connecting')
    clientRef.current = client

    return () => {
      clientRef.current = null
      subscribedRef.current.clear()
      dispatchRef.current = () => {}
      void client.deactivate()
      setState('idle')
    }
  }, [token, enabled])

  /**
   * Registers a listener for a destination, subscribing to it if the socket is up.
   *
   * <p>Registered before connecting is normal — the feed page mounts long before the
   * handshake completes — so `onConnect` replays whatever is already registered.
   */
  const subscribe = useMemo(
    () =>
      (destination: string, onEnvelope: (envelope: RealtimeEnvelope) => void): (() => void) => {
        const existing = listenersRef.current.get(destination) ?? new Set()
        existing.add(onEnvelope)
        listenersRef.current.set(destination, existing)

        const client = clientRef.current
        if (client?.connected && !subscribedRef.current.has(destination)) {
          subscribedRef.current.add(destination)
          void client.subscribe(
            destination,
            (message: IMessage) => dispatchRef.current(destination, message),
            { id: `sub-${destination}` },
          )
        }

        return () => {
          const bucket = listenersRef.current.get(destination)
          if (!bucket) return
          bucket.delete(onEnvelope)
          // The last listener leaving cancels the STOMP subscription too. The feed
          // destination is exempt: it is the connection's baseline and stays
          // subscribed for the liveness counter in the top bar.
          if (bucket.size === 0 && destination !== FEED_DESTINATION) {
            listenersRef.current.delete(destination)
            subscribedRef.current.delete(destination)
            if (client?.connected) void client.unsubscribe(`sub-${destination}`)
          }
        }
      },
    [],
  )

  const value = useMemo<RealtimeState>(
    () => ({ state, lastEvent, eventCount, subscribe }),
    [state, lastEvent, eventCount, subscribe],
  )

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

export function useRealtime(): RealtimeState {
  const value = useContext(RealtimeContext)
  if (!value) throw new Error('useRealtime must be used inside RealtimeProvider')
  return value
}

/**
 * Subscribes to one destination for the lifetime of a component.
 *
 * The handler is held in a ref so a caller may pass a fresh closure every render
 * without resubscribing.
 */
export function useRealtimeSubscription(
  destination: string | null,
  onEnvelope: (envelope: RealtimeEnvelope) => void,
): void {
  const { subscribe } = useRealtime()
  const handlerRef = useRef(onEnvelope)
  handlerRef.current = onEnvelope

  useEffect(() => {
    if (!destination) return
    return subscribe(destination, (envelope) => handlerRef.current(envelope))
  }, [destination, subscribe])
}

/**
 * Debounced "something changed" signal for a destination.
 *
 * Returns a boolean that flips true when an envelope arrives. The intended use is
 * `useEffect(() => { if (dirty) refetch() }, [dirty])` — a burst of ten timeline
 * entries from one action collapses into a single refetch.
 */
export function useRealtimeDirty(destination: string | null, delayMs = 300): boolean {
  const [dirty, setDirty] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useRealtimeSubscription(
    destination,
    useCallbackStable(() => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setDirty(true), delayMs)
    }, [delayMs]),
  )

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return dirty
}

/** Stable identity for an inline callback, so effects depending on it do not churn. */
function useCallbackStable<T extends (...args: never[]) => void>(fn: T, deps: unknown[]): T {
  const ref = useRef(fn)
  ref.current = fn
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ((...args: never[]) => ref.current(...args)) as T, deps)
}
