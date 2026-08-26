import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Opt-in turn trace, off unless `DSH_AGENT_BRIDGE_DEBUG` is set.
 *
 * The handoff spans two `stream()` calls with a live Claude query parked in
 * between, so a stall has no stack to inspect — this records the decisions that
 * lead to one. Set the variable to `1` to write under `$DSH_HOME/plugin-data`,
 * or to a path of your own.
 */
const setting = (process.env.DSH_AGENT_BRIDGE_DEBUG ?? "").trim();

const target = setting && setting !== "0"
  ? (setting === "1"
      ? join(resolve((process.env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh")), "plugin-data", "agent-bridge-debug.log")
      : resolve(setting))
  : null;

export const debugPath = target;

export function debugLog(event, data = {}) {
  if (!target) return;
  try {
    appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
  } catch {
    // Tracing must never break a turn.
  }
}
