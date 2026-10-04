# SentinelAI telemetry simulator

Generates realistic — and deliberately awkward — telemetry for a running SentinelAI
backend, so the whole pipeline can be seen working end to end: ingestion,
idempotency, detection, correlation, the incident lifecycle, the AI queue and the
live dashboard.

No dependencies. Node 20 and nothing else, so it runs from a checkout against a
container that may have no npm registry access.

```bash
node src/cli.js --scenario pool-exhaustion --duration 45
```

## What it is for

A demo that only ever sends well-formed events in a tidy order proves very little.
The behaviours worth demonstrating are the awkward ones, so the simulator has a
first-class way to produce each:

| Flag | What it models | What the backend must do |
| --- | --- | --- |
| `--duplicate-rate 0.1` | A producer retrying after a timeout, unsure whether the first attempt landed | Deduplicate on `(sourceScope, sourceEventId)` and answer `duplicate: true` |
| `--reorder-rate 0.2 --late-seconds 5` | A batching agent that delivers late and out of order | Order the incident by `occurredAt`, not arrival, and keep `receivedAt` visible so the gap is auditable |
| `--inject` | A log line carrying an instruction aimed at the model | Store it as evidence, quote it into the evidence package, and let nothing act on it |
| default | An ordinary outage | Open one incident per outage, not one per rule match |

The last row is the one people get wrong most often. A pool saturating, latency
climbing and errors appearing is *one* incident with three symptoms, and the seeded
correlation groups are arranged so that a correct implementation produces one
incident reference while an incorrect one produces three.

## Scenarios

| Name | Storyline | Expected |
| --- | --- | --- |
| `pool-exhaustion` | Payment service exhausts its connection pool; latency and errors follow | One incident; `DB_POOL_SATURATED` then `PAYMENT_P95_LATENCY_HIGH` |
| `checkout-degradation` | booking-service cannot reach payment-service | One incident; booking symptoms correlated into the payment one |
| `bad-deploy` | A deploy to notification-service, then failing health checks | One CRITICAL incident, and *not* one for the deploy itself |
| `cpu-pressure` | CPU saturation on inventory-service | One MEDIUM incident from `CPU_SATURATED` |
| `dependency-blackout` | payment-service loses auth-service | One incident naming auth-service as the dependency |
| `chaos` | Four storylines interleaved | Several incidents, correlated only where causality exists |

Every scenario is a deterministic generator: the same `--seed` replays the same run,
which is what makes a surprising result worth investigating rather than dismissing.

## Usage

```
Target
  --base-url <url>        Backend base URL            (default http://localhost:8080)
  --email <address>       Ingestion account           (default priya@sentinel.dev)
  --password <secret>     Account password            (default sentinel123)
  --environment <env>     Environment to report as    (default staging)

Load
  --scenario <name>       See the table above
  --duration <seconds>    How long to run             (default 60)
  --speed <multiplier>    Event rate multiplier       (default 1)
  --concurrency <n>       In-flight requests          (default 4)
  --loop                  Keep replaying the storyline until the duration expires
  --seed <n>              Deterministic seed          (default 1)
```

## Output

```
  . a1b2c3 payment-service    LATENCY_SPIKE      INC-1043  checkout latency p95 2400ms
+ . c4d5e6 payment-service    SATURATION         INC-1041  connection pool utilisation 0.97
  ~ a1b2c3 payment-service    LATENCY_SPIKE      stored    checkout latency p95 2400ms
  ! 9f8e7d booking-service    DEPENDENCY_FAILURE failed: POST /api/v1/events -> 400 VALIDATION_FAILED
```

`+` opened an incident, `.` was stored, `~` was correctly deduplicated, `!` was
rejected. The summary reports what the *server* decided, not what was sent:

```
Summary
  sent            41
  accepted        38
  duplicates      3  (the server deduplicated on the idempotency key)
  detections      12 match(es)
  rules matched:
    PAYMENT_P95_LATENCY_HIGH        8
    DB_POOL_SATURATED               6
```

## Why the numbers look the way they do

- **Thresholds match the seeded rules.** Each scenario crosses exactly one threshold,
  and crosses it after a run of values below it, so the transition is visible in the
  event stream rather than asserted in prose.
- **Dependencies are named in `metadata.dependency`.** That is the field the AI
  evidence builder aggregates, so naming it is what lets an analysis say where the
  failures originate rather than only that something broke.
- **Values are jittered but bounded.** Real exporters do not report exact numbers, and
  a generator with no jitter cannot demonstrate that a threshold comparison works.
- **Non-payment services stay under 1000 ms.** The seeded latency rule is keyed on
  the metric name, not on the service, so any service reporting `p95LatencyMs >= 1000`
  trips `PAYMENT_P95_LATENCY_HIGH`. That is a property of the seed data rather than of
  the engine, and the scenarios respect it so the demo output stays legible.

## Troubleshooting

**`error POST /api/v1/auth/login -> 401`** — the backend is not running, or the seed
data is missing. `app.seed.enabled` defaults to true in development; set it to false
in production.

**`error UNKNOWN_SERVICE`** — the service is not registered. Seeded services are
`payment-service`, `booking-service`, `inventory-service` and `notification-service`,
all in `staging`. Change the environment with `--environment` to match, or register
one with `POST /api/v1/services`.

**Events accepted but no incidents** — the rule did not match, which the summary
reports under "rules matched". Check `stub-failure-mode` is irrelevant here; this is
the detection path, not the AI path.