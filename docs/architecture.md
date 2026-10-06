# SentinelAI — Architecture

This document explains how the system is put together and, more importantly, *why* the
non-obvious decisions were made. Where a choice has a cost, the cost is stated. Where a
constraint was imposed by something outside this codebase (a browser, PostgreSQL, the
JVM), that is said too.

The [README](../README.md) carries the summary. This is the reasoning underneath it.

---

## 1. Shape of the system

A modular monolith: one deployable Spring Boot application, one PostgreSQL database.

```
   producer ──POST /api/v1/events──▶ ┌──────────────────────────────────────┐
                                     │  ingestion                           │
   simulator (Node, dependency-free) │    idempotent on                      │
                                     │    (source_scope, source_event_id)    │
                                     └───────────────┬──────────────────────┘
                                                     │
                                              event row (committed)
                                                     │
                                     ┌───────────────▼──────────────────────┐
                                     │  detection  — rules, in the database │
                                     │    fingerprint → incident             │
                                     └───────────────┬──────────────────────┘
                                                     │  IncidentDetectedEvent
                                     ┌───────────────▼──────────────────────┐
                                     │  incidents + timeline                │
                                     │    state machine, row locks          │
                                     └───────────────┬──────────────────────┘
                                                     │ after commit
                              ┌──────────────────────┴───────────────────┐
                              │                                          │
                  ┌───────────▼──────────┐                ┌──────────────▼─────────────┐
                  │ realtime (STOMP)     │                │ investigation (queue)      │
                  │  notification only   │                │  claim → call → settle     │
                  └───────────┬──────────┘                └────────────────────────────┘
                              │
                     ┌────────▼─────────┐
                     │ React dashboard  │─── refetches REST on every envelope
                     └──────────────────┘
```

Not microservices, and not for lack of imagination. The interesting problems here are
transaction boundaries and concurrency, and splitting a transaction across the network
turns a hard problem into a merely distributed one. The seams are explicit — detection
publishes an event, the AI queue is a table — so extraction is possible later if the
deployment story demands it, without paying for it now.

---

## 2. Ingestion

### Idempotency is a constraint, not a check

`(source_scope, source_event_id)` carries a UNIQUE constraint. The application does not
first "look and see" whether the event exists before deciding to insert. Two producers
racing on the same key produce one row because **PostgreSQL** says so, not because the
two request threads happened to agree about the answer.

The application-level check that a check-then-insert design needs is exactly the kind of
code that is correct on the day it is written and wrong the first time two instances are
deployed. A producer retrying after a read timeout must not be able to create a second
event, and therefore must not be able to create a second incident.

The duplicate response is not an error. It returns `200` with `"duplicate": true` and the
original event's id, because the producer did nothing wrong and needs to be able to treat
the retry as a success.

### Two transactions on purpose

A unique-constraint violation aborts the enclosing PostgreSQL transaction. If ingestion
were one transaction, the conflict would poison the transaction that also builds the
HTTP response, and the producer would receive a 500 for what is a normal, expected
situation.

So ingestion runs **two** `TransactionTemplate`s: the insert commits, and only then does
the detection hand-off run. The violation is caught inside the first, where the failed
transaction is already discarded.

### Event time and ingestion time are separate columns

`occurred_at` is the producer's clock. `received_at` is ours. They are never conflated,
because a producer whose clock is 40 minutes fast would otherwise file every incident
against the future and make every time-range query quietly wrong.

Timestamps are validated against our clock and rejected with `CLOCK_SKEW` when they are
implausibly ahead. Rejected, not clamped: silently rewriting a producer's timestamp is
worse than refusing it, because the caller cannot then know their clock is wrong.

`occurred_at` is stored **verbatim**. It is never rewritten to `now()` for convenience.

### Payload sanitisation

The `message` and `metadata` fields are producer-controlled strings that will later be
rendered in a browser and quoted into a model prompt. They are length-capped and stripped
of control characters at the boundary. See `PayloadSanitizer`.

This is the first of two trust boundaries. The second is the model prompt, below.

---

## 3. Detection

### Rules are rows, not code

Each rule is a row in `detection_rule`: an event type, a metadata key, an operator, a
threshold, a severity, a dedupe window, and a correlation group. Evaluation happens in
the database. Adding a rule is an insert, not a deploy.

No model is involved in deciding that an incident exists. This is the central constraint
of the whole design: **rules detect, AI only suggests.** A rule that matched is a fact
about the telemetry. An AI hypothesis is a guess, and the two are never allowed to share
a code path, because a guess that silently becomes a record is how systems end up
investigating incidents that never happened.

### Fingerprints

An incident's identity is `SHA-256(serviceId | signature)`.

The signature comes from `ErrorSignatureExtractor`, which reduces a free-text message to
a stable form by replacing everything volatile — UUIDs, timestamps, IPs, quoted values,
hex ids, and numbers — with placeholders. "Payment declined for order 88213" and
"Payment declined for order 99301" are the same defect and must collapse into one
incident, or one outage becomes hundreds of tickets.

The extractor is deliberately conservative, because the two failure modes are not
symmetric. Over-normalising merges unrelated problems into one incident nobody can
diagnose. Under-normalising fragments one problem into hundreds. Both are bad; the second
is worse during an outage and the first is permanent.

Units are preserved: `1800ms` becomes `<num>ms`, not `<num>`. A latency spike and a
request count are different problems, and collapsing them would merge them.

### The signature is not a title

The normalised signature is a **grouping key**, and it is unfit for display:
`booking-service: db connection pool utilisation <num> percent` describes no observation
at all. The incident title is therefore built from the producer's raw message, with the
signature and the event type as fallbacks. The signature still does its job — it is the
fingerprint input and the stored grouping key — it just stops pretending to be English.

### Correlation groups

Matching symptoms across services in the same correlation group fold into one incident,
so a database saturation and the resulting checkout errors surface as one problem rather
than three. A rule never correlates a service into itself: one service with two distinct
problems is two incidents.

### Dedupe windows

A rule carries a dedupe window. Occurrences arriving inside it increment the repeat count
but do not each produce a timeline entry or a broadcast. This is the difference between
"one incident, 4 000 alerts" and "one incident, 4 000 timeline entries".

---

## 4. Incidents

### A state machine

```
OPEN ──▶ ACKNOWLEDGED ──▶ INVESTIGATING ──▶ RESOLVED
  └──────────────────────────────────────────────┘
```

Transitions are validated, not merely documented. Resolution requires a human-written
root cause: the record that future investigations learn from is not something a heuristic
gets to write, and an incident resolved with an empty cause string teaches the next
analyst nothing.

### Two layers of concurrency control

Every mutation takes a `PESSIMISTIC_WRITE` row lock via `findByIdForUpdate`, **and** the
entity carries a `@Version` column checked with optimistic locking.

The row lock alone would serialise concurrent writers correctly. It is there anyway
because it also serialises the *read-modify-write* — the sequence number allocation, the
state transition, the timeline append — as one unit. Without it, two writers could each
read `OPEN`, each decide on a different valid transition, and the optimistic check would
merely turn a lost update into a 409 for the loser.

The version is what the *client* sees. A caller sends the version it holds, in the body
or as `If-Match`. If it is stale the server answers `409 CONFLICT` with
*"Reload and retry"*.

That 409 is not an error to be retried blindly. It means the dashboard is showing
something that is no longer true, and the correct response is to re-read, not to force.

### The timeline

Append-only. Sequence numbers are allocated under the incident's row lock, so ordering is
total even under concurrent writes — two timeline entries can never share a sequence, and
the order is the order things actually happened.

`TimelineService.append` is `@Transactional(MANDATORY)`: a timeline entry cannot exist
without a transaction that also owns the change it describes. An orphan entry would
describe a change that never committed.

---

## 5. Realtime

### Envelopes are published after commit, never before

A `TransactionTemplate` runs the publish *after* the business transaction commits. The
alternative — publishing inside it — means a client is told about a change that later
rolls back, and no amount of care on the client side can distinguish that from a change
that stuck.

`AfterCommitExecutor` performs the hand-off. `IncidentUpdatePublisher` swallows publish
failures with a log line rather than propagating them: the change is already durable, so
failing to notify is a degraded notification, not a failed operation. Clients refetch.

### The envelope is a notification, not data

An envelope carries an `eventId`, an incident reference, a sequence, and a payload
partial. It deliberately does **not** carry the full incident.

This forces the client to refetch a REST snapshot on every envelope. That looks wasteful
and is the single most important client-side decision in the system: a client that
patched its local incident from an envelope would render a plausible incident that never
existed, because the envelope has no assignee, no `firstSeenAt`, and no status. Clients
refetch, and bursts are coalesced into one request.

`eventId` exists so a reconnecting client can discard redelivery. Redelivery over a
reconnecting TCP connection is normal, not a bug.

### Authentication, and a Spring subtlety worth documenting

A browser cannot set headers on a WebSocket upgrade, so the handshake is anonymous and
the token arrives in the first STOMP `CONNECT` frame. That keeps it out of URLs, proxy
access logs, and browser history.

Both interceptors read the accessor **registered in the message headers**
(`MessageHeaderAccessor.getAccessor`), not `StompHeaderAccessor.wrap(message)`. This is
not a style preference:

> `StompSubProtocolHandler` stores each socket's principal in a `SessionInfo`, seeded from
> the (anonymous) `WebSocketSession` principal, and re-applies it to **every** subsequent
> frame. That store is updated only by a change callback which Spring attaches to the
> registered accessor instance. `wrap(message)` constructs a *new* accessor from the
> message; calling `setUser` on it writes the header into a private map and silently
> leaves `SessionInfo` empty.
>
> The symptom is deceptive: `CONNECT` succeeds and returns `CONNECTED`, and then every
> `SUBSCRIBE` is refused as *"Unauthenticated STOMP frame"* — which reads exactly like a
> bad token and is not one.

`StompAuthorizationTest` asserts against the registered accessor specifically, so the
regression cannot come back quietly.

The simple in-memory broker is used deliberately: it is sufficient for one node, adds no
infrastructure to run, and the interfaces chosen (publish to a destination, send to a
user) are the ones a relay-backed broker would satisfy. Swapping in RabbitMQ later
changes configuration rather than code.

### Split origins in production: the upgrade cannot be proxied everywhere

Dev and Docker keep one origin — vite and nginx both forward `/ws`, so the browser
never sees two hosts. A static host cannot do that. Vercel's rewrites forward HTTP
requests to the backend, but they do not carry the WebSocket `Upgrade`; a `/ws`
rewrite there is answered with the SPA's `index.html` and the handshake dies on a
non-`101` response. That is the error this design produces on such a deploy, and it
is a routing failure, not an authentication one.

So the two channels split:

- **REST stays same-origin**, proxied by the rewrites in `vercel.json`.
- **The socket goes straight to the backend.** `VITE_WS_URL` is set in the host's
  build environment (Vite bakes it in at build time), and the client derives `wss://`
  from whatever scheme it is given so a deployer may paste the origin they already
  have.

A cross-origin handshake needs exactly one thing from the backend: the page's origin
in `SENTINEL_SECURITY_ALLOWED_ORIGINS` (comma-separated, no trailing slash). Spring
Security's CORS filter runs over the handshake like any other request, so an origin
missing from that list is a `403` on the upgrade — which reads like a token failure
and is not one. `WebSocketConfig` still permits every origin at the protocol level;
the allow-list above it is the real boundary.

---

## 6. AI investigation

### Rules detect, the model suggests — and the boundary is enforced

Nothing the model returns can change an incident's state. There is no code path from an
AI response to `IncidentService`. The response is stored, displayed, and read by a human.
The dashboard says so on the panel itself, because a reader who does not know that
conclusion will not act on it correctly.

### The queue

Analysis jobs are rows, claimed by a background worker with a claim/complete/retry
protocol:

```
tx₁: SELECT … FOR UPDATE SKIP LOCKED → mark RUNNING → commit
        ↓ (no transaction held)
     provider call
        ↓
tx₂: mark COMPLETED / FAILED / requeue → commit
```

Claiming and settling are separate transactions and the provider call happens in neither.
A slow model must not hold a database row or a connection. With the call inside a
transaction, one slow provider response would pin a row for the length of its timeout and
exhaust the pool.

Retries are bounded and classified. Timeouts and 5xx are retryable and requeue up to
`maxAttempts`. Parse failures and schema-validation failures are **terminal immediately**
— retrying a response that will never parse is not resilience, it is a way of burning the
budget slowly.

The worker is driven by a scheduler that is `@ConditionalOnProperty`-gated, delegating to
an unconditional component, so tests can exercise the worker's logic without a timer
racing their assertions.

### Provider-agnostic

`LlmClient` has two implementations: a deterministic offline stub (the default) and an
OpenAI-compatible HTTP client, configured by base URL, model, and API key.

The stub is deterministic because a portfolio demo that invents a different answer each
run cannot be debugged. It is not presented as a language model, and every result it
produces carries a caveat saying so.

### Prompt injection: logs are untrusted data

Event messages and log payloads are producer-controlled. They reach the model as quoted
data inside a delimited block, with an explicit instruction that the block's contents are
evidence about the incident and not instructions to follow.

This is a mitigation, not a guarantee — no prompt construct is a security boundary. The
structural protections are elsewhere: the response is parsed against a schema and
validated (a confidence of `1.4`, or a citation to an event that does not exist, causes
rejection), and no model output can mutate state.

---

## 7. Persistence

Flyway owns the schema. Hibernate runs with `ddl-auto: validate`.

`validate` means a mismatch between the entities and the migrations fails at startup
rather than producing a schema nobody wrote. Combined with Flyway this makes the
migration files the single source of truth.

### Test isolation: one schema per test class

Each test class gets its own PostgreSQL schema, derived deterministically from the class
name and dropped in a startup sweep when the embedded server starts.

This replaced a shared schema, which made the suite **order-dependent**: a cached
application context's scheduler would drain another class's queued jobs, so an assertion
that expected `QUEUED` could observe `RUNNING`. Per-class schemas make each class
independent of execution order.

Cleanup is a startup sweep rather than an `@AfterAll` hook. Dropping a schema
mid-run turns every subsequent tick of a still-running cached worker into a
"relation does not exist" stack trace — the schema disappears while something is still
using it.

Tests run against an embedded PostgreSQL (zonky), with the Testcontainers variant
retained for CI.

---

## 8. Frontend

React 18, TypeScript, Vite. No state-management library and no component library — the
point of the exercise is the behaviour, and both would obscure it.

### The socket is a notification

This mirrors the backend contract exactly. Components subscribe to a destination and
**refetch a REST snapshot** on each envelope rather than patching local state.

Three details that are easy to get wrong and were each fixed after being got wrong:

- **One subscription per destination.** All delivery funnels through a single `dispatch`,
  so a listener that subscribed after the socket came up cannot bypass deduplication. An
  earlier version gave late listeners their own subscription with a direct handler, which
  applied redelivered messages twice to exactly those listeners.
- **Deduplication is bounded.** A reconnecting TCP connection can redeliver, so `eventId`
  is remembered — but an unbounded set is a memory leak on a long-lived dashboard. 2 000
  entries, insertion-ordered, evicting oldest first.
- **Reconnect backoff is capped.** A backend restart must not become a reconnect storm; a
  long outage must not become a permanently dead dashboard.

### 409 is surfaced, not swallowed

When a mutation loses an optimistic-locking race, the conflict is shown as a conflict —
telling the operator their view was stale — rather than being retried automatically.
Auto-retrying would fight whoever actually won.

### Role gating is honest

A VIEWER sees no write controls, and is told that *every* action on the panel is rejected
by the server, not merely hidden in the UI. Hiding a button without saying so teaches
users that the server does not check.

---

## 9. What this design does not do

Stated plainly, because a list of omissions is more useful than an implication of
completeness:

- **No horizontal scale-out.** The simple broker and an in-process job queue assume one
  node. Both have known replacements.
- **No durable message delivery.** Envelopes are best-effort by design; the database is
  the record. Clients refetch, so nothing is lost.
- **No per-incident access control.** Every authenticated role may read every incident.
  `StompDestinationAuthorizationInterceptor` is the single place that grows the check when
  ACLs arrive, and it already has the principal in hand.
- **No model-quality claims.** Confidence values are heuristic scores and are not
  calibrated probabilities. Nothing here has been benchmarked against a labelled dataset,
  and no number in this repository pretends otherwise.