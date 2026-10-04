/**
 * Console output.
 *
 * Kept separate from the run loop so the format is one decision in one place, and so
 * `--quiet` is a filter here rather than a branch scattered through the sender.
 */

/** Colour only when the terminal wants it, so piped output stays readable. */
const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const ESC = '[';

const CODES = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
};

function paint(code, text) {
  return useColour ? `${CODES[code]}${text}${CODES.reset}` : text;
}

/** Per-event markers, so the shape of a run is readable without reading every line. */
export const colour = {
  opened: (text) => paint('green', text),
  duplicate: (text) => paint('yellow', text),
  stored: (text) => paint('dim', text),
  failed: (text) => paint('red', text),
  reference: (text) => paint('cyan', text),
};

export function createOutput({ quiet = false } = {}) {
  return {
    heading(text) {
      if (!quiet) {
        console.log(paint('bold', text));
      }
    },
    detail(text) {
      if (!quiet) {
        console.log(`  ${paint('dim', text)}`);
      }
    },
    event(text) {
      if (!quiet) {
        console.log(`  ${text}`);
      }
    },
    blank() {
      if (!quiet) {
        console.log();
      }
    },
    /** Never suppressed: a tool that fails quietly is worse than one that is loud. */
    error(text) {
      console.error(`${paint('red', 'error')} ${text}`);
    },
    success(text) {
      console.log(paint('green', text));
    },
  };
}