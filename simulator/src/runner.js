/**
 * The run loop: turn a scenario into an ordered, timestamped, occasionally hostile
 * event stream and push it at the ingestion endpoint.
 *
 * Three awkward behaviours are modelled because they are the ones real producers
 * have and the ones a naive demo never shows:
 *
 * - **Duplicates.** A producer that retries after a timeout cannot know whether the
 *   first attempt landed. `--duplicate-rate` re-sends the identical payload, and the
 *   server must answer `duplicate: true` rather than counting the event twice.
 * - **Late and out-of-order arrival.** `--reorder-rate` holds events back and reports
 *   an `occurredAt` from the past, so the incident timeline has to be assembled from
 *   event time rather than arrival order.
 * - **Instruction-shaped data.** `--inject` sends a log line containing an
 *   instruction. Nothing may act on it.
 */

import { SentinelClient, sleep } from './api-client.js';
import { colour } from './output.js';
import { scenarioFor, injectionEvent, mulberry32 } from './scenarios.js';

/** Guards against a scenario change turning into a runaway flood. */
const MAX_EVENTS = 20_000;

export async function run(options, out) {
  const scenario = scenarioFor(options.scenario);
  const random = mulberry32(options.seed);
  const client = new SentinelClient(options);

  out.heading(`SentinelAI simulator — ${scenario.title}`);
  out.detail(`expected: ${scenario.expect}`);

  const user = await client.login();
  out.detail(`authenticated as ${user.name} <${user.email}> (${user.role})`);
  out.detail(`target ${options.baseUrl}, environment ${options.environment}`);

  const plan = buildPlan(options, scenario, random);
  if (plan.length === 0) {
    throw new Error('The scenario produced no events');
  }

  out.detail(
    `planned ${plan.length} event(s) over ${(plan[plan.length - 1].at - plan[0].at) / 1000}s` +
      `${options.duplicateRate > 0 ? `, ~${Math.round(plan.length * options.duplicateRate)} deliberate duplicate(s)` : ''}` +
      `${options.reorderRate > 0 ? `, ~${Math.round(plan.length * options.reorderRate)} late reorder(s)` : ''}` +
      `${options.inject ? ', 1 instruction-shaped log line' : ''}`,
  );
  out.blank();

  const stats = newStats();
  const startedAt = Date.now();
  const deadline = startedAt + options.duration * 1000;

  let cursor = 0;
  let index = 0;
  const inFlight = new Set();

  while (cursor < plan.length || inFlight.size > 0) {
    const now = Date.now();
    if (now >= deadline && cursor >= plan.length) {
      break;
    }

    while (inFlight.size < options.concurrency && cursor < plan.length && plan[cursor].at <= now) {
      const item = plan[cursor];
      cursor++;
      const task = dispatch(client, item, stats, out, options, index++)
        .catch((error) => {
          stats.failed++;
          const key = error.code ?? error.name;
          stats.byCode.set(key, (stats.byCode.get(key) ?? 0) + 1);
          out.event(`${colour.failed('!')} ${item.event.service} ${item.event.eventType} failed: ${error.message}`);
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }

    if (inFlight.size === 0 && cursor >= plan.length) {
      break;
    }
    await sleep(20);
  }

  // Anything still queued past the deadline would be dropped silently, which is the
  // one thing a producer must never do: report it instead.
  if (cursor < plan.length) {
    const dropped = plan.length - cursor;
    stats.dropped = dropped;
    out.detail(`stopped at the duration limit with ${dropped} event(s) unsent`);
  }

  await Promise.all([...inFlight]);
  const elapsed = (Date.now() - startedAt) / 1000;

  out.blank();
  summarise(stats, out, elapsed, options);
  return stats;
}

async function dispatch(client, item, stats, out, options, index) {
  stats.sent++;
  const result = await client.ingestEvent(item.event);

  if (result.duplicate) {
    stats.duplicates++;
    out.event(
      `${colour.duplicate('~')} duplicate ignored  ${shortId(item.event)} ${item.event.message.slice(0, 64)}`,
    );
    return;
  }

  stats.accepted++;
  for (const rule of result.body?.matchedRules ?? []) {
    stats.rules.set(rule, (stats.rules.get(rule) ?? 0) + 1);
  }

  const incident = result.body?.incident;
  if (incident?.reference) {
    // The field is `reference`. An earlier version checked `incidentReference`, which
    // does not exist, so this branch never ran: the summary reported "0 detections"
    // directly above a per-rule breakdown listing six matches, and nothing reconciled
    // the two. A counter that silently reports zero is worse than no counter.
    const known = stats.incidents.get(incident.incidentId);
    const action = incident.action ?? 'UPDATED';
    if (!known) {
      stats.incidents.set(incident.incidentId, { reference: incident.reference, action, events: 1 });
      stats.opened++;
    } else {
      known.action = action;
      known.events++;
    }
    stats.correlated++;
  }

  // Three outcomes worth telling apart at a glance: a new incident, an existing one
  // gaining evidence, and an event that matched nothing.
  const opened = result.body?.incident?.action === 'INCIDENT_OPENED';
  const marker = opened ? colour.opened('+') : colour.stored('.');
  const reference = result.body?.incident?.reference;
  out.event(
    `${marker} ${shortId(item.event)} ${pad(item.event.service, 21)} ${pad(item.event.eventType, 18)}` +
      `${pad(reference ? colour.reference(reference) : 'stored', opened ? 26 : 10)}` +
      `${item.event.message.slice(0, 70)}`,
  );
  void index;
}

/**
 * Expands a scenario into an absolute schedule.
 *
 * Built up front rather than generated lazily so that the whole run is a pure function
 * of (scenario, seed, options) — which is what makes a failing demo reproducible.
 */
function buildPlan(options, scenario, random) {
  const plan = [];
  const startedAt = Date.now();
  let cursorMs = 0;
  let cycle = 0;
  let counter = 0;

  const push = (step, forceLate) => {
    counter++;
    if (plan.length >= MAX_EVENTS) {
      return;
    }
    // A per-run suffix so two simulator processes pointed at one backend do not
    // collide on a generated id and turn their traffic into duplicates of each other.
    const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0');
    const occurredAtMs = startedAt + cursorMs - (step.ageMs ?? 0);

    const step2 = {
      at: startedAt + cursorMs,
      event: {
        sourceEventId: `${options.scenario}-c${cycle}-${counter}-${suffix}`,
        sourceScope: `simulator-${options.seed}`,
        service: step.service,
        environment: options.environment,
        eventType: step.eventType,
        severity: step.severity,
        message: step.message,
        occurredAt: new Date(occurredAtMs).toISOString(),
        metadata: step.metadata ?? {},
      },
    };

    plan.push(step2);

    if (!forceLate && random() < options.reorderRate) {
      // The same observation, delivered late. `occurredAt` stays where it belongs —
      // this is the distinction the backend exists to preserve — so the incident has
      // to order its evidence by event time, not arrival order.
      cursorMs += Math.round((options.lateSeconds || 5) * 1000 + random() * 2000);
      push(step, true);
    }
  };

  const advance = (step) => {
    cursorMs += Math.max(0, Math.round((step.delayMs ?? 500) / options.speed));
  };

  const replaying = () => options.loop && cursorMs < options.duration * 1000;

  do {
    const story = scenario.build(random);
    let next = story.next();
    while (!next.done) {
      if (cursorMs >= options.duration * 1000) {
        break;
      }
      push(next.value, false);
      advance(next.value);
      next = story.next();
    }
    cycle++;
  } while (replaying());

  if (options.inject) {
    const step = injectionEvent();
    cursorMs += Math.round(step.delayMs / options.speed);
    push(step, false);
  }

  return plan.sort((a, b) => a.at - b.at);
}

function newStats() {
  return {
    sent: 0,
    accepted: 0,
    duplicates: 0,
    failed: 0,
    dropped: 0,
    /** Events that produced or extended an incident. */
    correlated: 0,
    /** Distinct incidents this run opened. */
    opened: 0,
    incidents: new Map(),
    rules: new Map(),
    byCode: new Map(),
  };
}

async function summarise(stats, out, elapsed, options) {
  out.heading('Summary');
  out.detail(`sent            ${stats.sent}`);
  out.detail(`accepted        ${stats.accepted}`);
  out.detail(`duplicates      ${stats.duplicates}` +
    (options.duplicateRate > 0 ? '  (the server deduplicated on the idempotency key)' : ''));
  out.detail(`failed          ${stats.failed}` +
    (stats.failed > 0 ? `  ${formatCounts(stats.byCode)}` : ''));
  // Three distinct numbers, deliberately not collapsed into one "detections" figure:
  // how many events found a rule, how many moved an incident, and how many incidents
  // this run created. Conflating them is how a summary ends up claiming zero matches
  // while listing six.
  const ruleMatches = [...stats.rules.values()].reduce((total, count) => total + count, 0);
  out.detail(`rule matches    ${ruleMatches} across ${stats.rules.size} rule(s)`);
  out.detail(`correlated      ${stats.correlated} event(s) onto an incident`);
  out.detail(`opened          ${stats.opened} incident(s)`);
  out.detail(`elapsed         ${elapsed.toFixed(1)}s`);

  if (stats.rules.size > 0) {
    out.blank();
    out.detail('rules matched:');
    for (const [rule, count] of sorted(stats.rules)) {
      out.detail(`  ${pad(rule, 28)} ${count}`);
    }
  }

  if (stats.incidents.size > 0) {
    out.blank();
    out.detail(`incidents touched (${stats.incidents.size}):`);
    // 28 columns, the longest action being THROTTLED_BY_DEDUPE_WINDOW at 26. At 12
    // the interesting ones came out as "SYMPTOM_COR…" and "THROTTLED_B…", which is
    // precisely the information a reader opens this section for.
    for (const [, incident] of sorted(stats.incidents)) {
      out.detail(`  ${pad(incident.reference, 10)} last action ${pad(incident.action, 28)}${incident.events} event(s)`);
    }
  }
}

function sorted(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function formatCounts(map) {
  return [...map.entries()].map(([code, count]) => `${code} x${count}`).join(', ');
}

/**
 * Left-aligns a value into a fixed-width column.
 *
 * Always leaves a trailing space, even when the value fills the column. `padEnd`
 * alone does not: `DEPENDENCY_FAILURE` is exactly 18 characters, so the event log
 * printed `DEPENDENCY_FAILUREINC-1002` and the incident reference looked like part of
 * the event type. One character of overrun should cost whitespace, not legibility.
 */
function pad(value, width) {
  const text = String(value ?? '');
  return (text.length > width ? `${text.slice(0, width - 1)}… ` : text.padEnd(width)) + ' ';
}

function shortId(event) {
  return event.sourceEventId.split('-').slice(-2).join('-');
}