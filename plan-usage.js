/**
 * Plan usage as the composer ring wants it.
 *
 * The Agent SDK reports the same windows Claude Code's own `/usage` shows —
 * the five-hour window, the weekly pool, and any per-model weekly buckets the
 * server scopes (Fable, for instance) — plus the subscription tier. This module
 * maps that onto the ring's vocabulary and nothing else; the fetching and the
 * caching belong to the client that owns the query.
 */

/** One reported window, in the shape the ring renders. */
export const WINDOW_KINDS = ["session", "weekly", "other"];

function windowFrom(kind, reported, scope) {
  if (!reported) return null;
  const utilization = reported.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const resetsAt = Date.parse(reported.resets_at ?? "");
  return {
    kind,
    ...(scope ? { scope } : {}),
    usedPercent: Math.min(100, Math.max(0, utilization)),
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

/**
 * Project the SDK's usage response onto the ring's model.
 *
 * @param response - what `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` returned.
 * @returns `{ supported, plan?, windows? }`; unsupported when no plan limits apply
 *   (an API key, Bedrock, Vertex), which is a fact about the session, not a failure.
 */
export function planUsageFrom(response) {
  if (!response || response.rate_limits_available !== true || !response.rate_limits) {
    return { supported: false };
  }
  const limits = response.rate_limits;
  const windows = [
    windowFrom("session", limits.five_hour),
    windowFrom("weekly", limits.seven_day),
    windowFrom("weekly", limits.seven_day_opus, "Opus"),
    windowFrom("weekly", limits.seven_day_sonnet, "Sonnet"),
    // Server-labelled per-model buckets: the label is theirs, not ours, so a
    // bucket for a model this code has never heard of still reads correctly.
    ...(limits.model_scoped ?? []).map(bucket => windowFrom("weekly", bucket, bucket?.display_name)),
  ].filter(Boolean);

  return {
    supported: windows.length > 0,
    ...(typeof response.subscription_type === "string" && response.subscription_type
      ? { plan: response.subscription_type }
      : {}),
    windows,
  };
}
