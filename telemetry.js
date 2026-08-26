/**
 * DSH's `dsh-base` bundle mounts an OTLP exporter (`session-telemetry-otel`)
 * aimed at DeepSeek's collector. Its own note on the row says an enabled upload
 * mirrors session-log records "with no session-telemetry/record redaction rule,
 * so exports are the raw captured copy".
 *
 * With this plugin installed that raw copy contains Claude's outputs, so an
 * enabled exporter would ship one model vendor's output to another's collector.
 * The adapter refuses to run a turn while that is true; this module is the
 * detection, kept separate so it can be tested without a live session.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const TELEMETRY_ENDPOINT_DEFAULT = "https://harness-telemetry.deepseeksvc.com/v1/logs";

/** Row ids dsh-base uses for the exporter, as they appear in a patch or settings file. */
const TELEMETRY_KEYS = ["session-telemetry-otel", "session-telemetry"];

/**
 * Read DSH's telemetry posture from the environment the host process was
 * launched with, mirroring `dsh-base`'s own row semantics:
 *
 * - a non-empty `DSH_TELEMETRY_DISABLED` (any value, including `0` and `false`)
 *   opts the process out, and the launchers patch the row off entirely;
 * - `DSH_TELEMETRY_MODE` defaults to `DISABLED`, and anything else (`FULL`,
 *   `FEEDBACK_ONLY`) opts in;
 * - `DSH_TELEMETRY_OTLP_URL` overrides the production endpoint.
 *
 * @returns `null` when nothing is exported, otherwise the active mode and endpoint.
 */
export function telemetryExport(env = process.env, readFile = readTextFile) {
  // The hard opt-out wins everywhere: the launchers patch the row off, so no
  // configuration can turn it back on.
  if (env.DSH_TELEMETRY_DISABLED) return null;
  const endpoint = (env.DSH_TELEMETRY_OTLP_URL ?? "").trim() || TELEMETRY_ENDPOINT_DEFAULT;

  const fromEnv = (env.DSH_TELEMETRY_MODE ?? "").trim();
  if (fromEnv && fromEnv.toUpperCase() !== "DISABLED") {
    return { mode: fromEnv.toUpperCase(), endpoint, source: "DSH_TELEMETRY_MODE" };
  }

  // The row's mode can also come from a config layer, which the environment
  // cannot see. Best-effort by design: a scan, not a cordis resolution.
  for (const path of configSources(env)) {
    const mode = telemetryModeIn(readFile(path));
    if (mode) return { mode, endpoint, source: path };
  }
  return null;
}

/** Every config layer that can carry a row override, home first then profiles. */
function configSources(env) {
  const home = resolve((env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh"));
  const paths = [join(home, "settings.yaml"), join(home, "cordis.patch.yml")];
  let profiles = [];
  try {
    profiles = readdirSync(join(home, "profiles"), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(home, "profiles", entry.name, "cordis.patch.yml"));
  } catch {
    profiles = [];
  }
  return [...paths, ...profiles];
}

function readTextFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Find an enabled telemetry mode inside a YAML-ish config layer.
 *
 * Deliberately shallow: it walks the indented block that follows a telemetry
 * row and reads `mode`/`disabled`. It cannot resolve `!!js` expressions, which
 * is why the environment is checked first and separately.
 */
export function telemetryModeIn(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!TELEMETRY_KEYS.some(key => line.includes(key))) continue;
    const indent = line.search(/\S/);
    let mode = null;
    let disabled = false;
    for (const next of lines.slice(index + 1)) {
      if (!next.trim()) continue;
      if (next.search(/\S/) <= indent) break;
      const modeMatch = /^\s*mode:\s*(.+?)\s*$/.exec(next);
      if (modeMatch && !modeMatch[1].startsWith("!!js")) mode = modeMatch[1].replace(/^['"]|['"]$/g, "").toUpperCase();
      if (/^\s*disabled:\s*true\b/.test(next)) disabled = true;
    }
    if (!disabled && mode && mode !== "DISABLED") return mode;
  }
  return null;
}

/** Operator-facing explanation, shared by the thrown error and the toast. */
export function telemetryRefusal({ mode, endpoint, source }) {
  const origin = source === "DSH_TELEMETRY_MODE" ? "DSH_TELEMETRY_MODE" : source;
  return `DSH session telemetry is enabled (mode ${mode}, from ${origin}), which uploads unredacted session records — including Claude's output — to ${endpoint}. Claude is not available while that is on. Turn it off there, or set DSH_TELEMETRY_DISABLED=1 to opt the process out entirely, then restart DSH.`;
}
