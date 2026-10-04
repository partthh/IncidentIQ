/**
 * Command line parsing.
 *
 * Hand-rolled rather than a dependency: the simulator is meant to be run straight
 * from a checkout against a container that may not have npm access, and a
 * twenty-line parser is a smaller liability than an un-audited install.
 */

/** Reads `--key value`, `--key=value` and `--flag` into a plain object. */
export function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      raw[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      raw[body] = true;
    } else {
      raw[body] = next;
      i++;
    }
  }
  return raw;
}

function text(raw, key, fallback) {
  const value = raw[key];
  return value === undefined ? fallback : String(value);
}

function number(raw, key, fallback) {
  const value = raw[key];
  if (value === undefined || value === true) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${key} must be a number, got "${value}"`);
  }
  return parsed;
}

function flag(raw, key) {
  return raw[key] === true || raw[key] === 'true';
}

/** Reads a probability in [0,1] so a typo cannot silently disable a behaviour. */
function probability(raw, key, fallback) {
  const value = number(raw, key, fallback);
  if (value < 0 || value > 1) {
    throw new Error(`--${key} must be between 0 and 1, got ${value}`);
  }
  return value;
}

export function readOptions(argv) {
  const raw = parseArgs(argv);
  return {
    baseUrl: text(raw, 'base-url', 'http://localhost:8080').replace(/\/+$/, ''),
    email: text(raw, 'email', 'priya@sentinel.dev'),
    password: text(raw, 'password', 'sentinel123'),
    scenario: text(raw, 'scenario', 'chaos'),
    environment: text(raw, 'environment', 'staging'),
    duration: number(raw, 'duration', 60),
    speed: number(raw, 'speed', 1),
    concurrency: number(raw, 'concurrency', 4),
    loop: flag(raw, 'loop'),
    quiet: flag(raw, 'quiet'),
    help: flag(raw, 'help') || flag(raw, 'h'),
    // Awkwardness, all off by default so the happy path is the default path.
    duplicateRate: probability(raw, 'duplicate-rate', 0),
    reorderRate: probability(raw, 'reorder-rate', 0),
    lateSeconds: number(raw, 'late-seconds', 0),
    inject: flag(raw, 'inject'),
    seed: number(raw, 'seed', 1),
  };
}

export const HELP = `
sentinel-sim — generate telemetry for a running SentinelAI backend

  Usage
    node src/cli.js [options]

  Target
    --base-url <url>        Backend base URL            (default http://localhost:8080)
    --email <address>       Ingestion account           (default priya@sentinel.dev)
    --password <secret>     Account password             (default sentinel123)
    --environment <env>     Environment to report as     (default staging)

  Load
    --scenario <name>       chaos | pool-exhaustion | checkout-degradation |
                            bad-deploy | cpu-pressure | dependency-blackout
    --duration <seconds>    How long to run             (default 60)
    --speed <multiplier>    Event rate multiplier       (default 1)
    --concurrency <n>       In-flight requests          (default 4)
    --loop                  Keep going after the scenario ends
    --seed <n>              Deterministic seed          (default 1)

  Awkwardness (off unless asked for)
    --duplicate-rate <p>    Re-send events; the server must dedupe (default 0)
    --reorder-rate <p>      Deliver some events late and out of order (default 0)
    --late-seconds <n>      How late reordered events arrive (default 0)
    --inject                Include a log line carrying an instruction

  Output
    --quiet                 Only print the summary
    --help                  This text

  Examples
    node src/cli.js --scenario pool-exhaustion --duration 45
    node src/cli.js --scenario chaos --loop --speed 2 --duplicate-rate 0.1 --reorder-rate 0.2
    node src/cli.js --scenario bad-deploy --inject --duration 30
`;