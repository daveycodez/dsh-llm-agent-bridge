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

export const TELEMETRY_ENDPOINT_DEFAULT = "https://harness-telemetry.deepseeksvc.com/v1/logs";

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
export function telemetryExport(env = process.env) {
  if (env.DSH_TELEMETRY_DISABLED) return null;
  const mode = (env.DSH_TELEMETRY_MODE ?? "").trim();
  if (!mode || mode.toUpperCase() === "DISABLED") return null;
  return {
    mode: mode.toUpperCase(),
    endpoint: (env.DSH_TELEMETRY_OTLP_URL ?? "").trim() || TELEMETRY_ENDPOINT_DEFAULT,
  };
}

/** Operator-facing explanation, shared by the thrown error and the toast. */
export function telemetryRefusal({ mode, endpoint }) {
  return `DSH session telemetry is enabled (DSH_TELEMETRY_MODE=${mode}), which uploads unredacted session records — including Claude's output — to ${endpoint}. Claude is not available while that is on. Unset DSH_TELEMETRY_MODE, or set DSH_TELEMETRY_DISABLED=1 to opt the process out, then restart DSH.`;
}
