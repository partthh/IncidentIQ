#!/usr/bin/env node
/**
 * SentinelAI telemetry simulator.
 *
 * Drives a running backend with realistic — and deliberately awkward — telemetry so
 * the whole pipeline can be seen working: ingestion, idempotency, detection,
 * correlation, incident lifecycle, the AI queue and the live dashboard.
 *
 * Zero dependencies on purpose. It should run from a checkout against a container
 * that may have no npm registry access, using only what Node 20 ships.
 */

import { readOptions, HELP } from './args.js';
import { createOutput } from './output.js';
import { run } from './runner.js';
import { listScenarios } from './scenarios.js';

async function main() {
  let options;
  try {
    options = readOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`error  ${error.message}`);
    console.error(HELP);
    process.exit(2);
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }

  const out = createOutput({ quiet: options.quiet });
  try {
    await run(options, out);
  } catch (error) {
    out.error(error.message);
    if (error.status) {
      // A 401 or 404 here is almost always "the backend is not running or the
      // credentials are the demo ones", so say that rather than leaving the user to
      // decode an HTTP status.
      out.error(`is the backend up at ${options.baseUrl}? Seeded login is priya@sentinel.dev / sentinel123`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`error  ${error?.stack ?? error}`);
  process.exit(1);
});

export { listScenarios };