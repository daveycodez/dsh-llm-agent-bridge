import { telemetryExport, telemetryRefusal } from "./telemetry.js";

/**
 * What the plugin does when DSH's session exporter is live.
 *
 * `disable` (the default) shuts it down. This plugin exists to route one
 * vendor's model through another vendor's harness, and DSH's exporter uploads
 * unredacted session records — including that model's output — to its own
 * collector. Installing this plugin is a statement that Claude should run here;
 * quietly letting its output ship elsewhere is not a reasonable default, and an
 * installer who has never read this README will not know to set an environment
 * variable.
 *
 * `refuse` fails the turn instead and leaves the exporter alone, for anyone who
 * would rather the plugin never touch host configuration. `ignore` disables the
 * guard entirely.
 */
export const TELEMETRY_MODES = ["disable", "refuse", "ignore"];

/** The mounted backend, or null when the host has none. */
function liveBackend(ctx) {
  try {
    return ctx?.get?.("sessionTelemetry") ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether records currently leave the machine.
 *
 * `sharing` is the backend's own three-value vocabulary ("full",
 * "feedback-only", "disabled"); `provider` is the OTel pipeline, absent when
 * disabled, and is the fallback for a backend that reports no sharing status.
 *
 * @returns the sharing mode when exporting, otherwise null.
 */
export function exportingState(backend) {
  if (!backend) return null;
  if (typeof backend.sharing === "string") return backend.sharing === "disabled" ? null : backend.sharing;
  return backend.provider === undefined ? null : "unknown";
}

/**
 * Guard the turn against a live exporter.
 *
 * Checking the mounted backend is exact, unlike {@link telemetryExport}'s scan
 * of environment and config layers — it sees the row whatever switched it on.
 * The scan stays as a fallback for a host whose backend cannot be read.
 */
export function createTelemetryControl(ctx, { mode = "disable", logger = console } = {}) {
  const setting = TELEMETRY_MODES.includes(mode) ? mode : "disable";
  let stopped = null;

  async function disable(backend, sharing) {
    // Drain and quiesce the pipeline through the backend's own API, then
    // unmount the row so capture stops too rather than filling a dead pipe.
    await backend.shutdown?.().catch(error => {
      logger.warn?.(`agent-bridge: telemetry shutdown reported ${error?.message ?? error}`);
    });
    const fiber = backend?.ctx?.fiber;
    if (typeof fiber?.dispose === "function") {
      await fiber.dispose().catch(error => {
        logger.warn?.(`agent-bridge: telemetry row would not unmount (${error?.message ?? error}); its exporter is shut down`);
      });
    }
    stopped = sharing;
    logger.warn?.(
      `agent-bridge: DSH session telemetry was ${sharing} and has been turned off. `
      + "It uploads unredacted session records, which now include Claude's output. "
      + "Set DSH_TELEMETRY_DISABLED=1 to keep it off at the source, or configure this plugin with telemetry: \"refuse\" to be failed instead.",
    );
  }

  return {
    /** @returns what the guard did, or throws when a turn must not run. */
    async enforce() {
      if (setting === "ignore") return { state: "ignored" };
      if (stopped) return { state: "disabled", sharing: stopped };

      const backend = liveBackend(ctx);
      const sharing = exportingState(backend);
      if (sharing) {
        if (setting === "refuse") {
          throw new Error(telemetryRefusal(telemetryExport() ?? { mode: sharing.toUpperCase(), endpoint: "DSH's configured collector", source: "the running exporter" }));
        }
        await disable(backend, sharing);
        return { state: "disabled", sharing };
      }

      // No readable backend: fall back to the config scan, which can only
      // report, not disable.
      const configured = telemetryExport();
      if (configured) throw new Error(telemetryRefusal(configured));
      return { state: "off" };
    },
  };
}

/** The guard used when no host context is available, e.g. in tests. */
export function scanOnlyTelemetryControl() {
  return {
    async enforce() {
      const configured = telemetryExport();
      if (configured) throw new Error(telemetryRefusal(configured));
      return { state: "off" };
    },
  };
}
