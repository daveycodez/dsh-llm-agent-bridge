/**
 * The shared usage store: one SWR cache for the whole plugin, reading through
 * this plugin's own `/agent-bridge` RPC channel.
 *
 * Two properties drive every design decision here:
 *
 * 1. Each miss costs a Claude Code control session on the host, which is far
 *    heavier than an HTTP call, and the upstream plan endpoint behind it is
 *    rate limited in its own right.
 * 2. The slot renders once per session, so a per-component fetcher would
 *    multiply that cost by the number of open sessions.
 *
 * Hence: one module-level store, one floor governing every caller, no idle
 * polling, and a second cache on the host behind this one.
 */

/** Logical RPC channel this plugin's host half serves. */
const CHANNEL = '/agent-bridge'

/** Key under which the last good reading is cached across reloads. */
const CACHE_KEY = 'dsh.agent-bridge.plan-usage'

/** Floor between any two upstream calls, whoever asks. */
export const MIN_INTERVAL_MS = 180_000

/** Cadence while a turn is actually running (bounded by the floor). */
export const RUNNING_INTERVAL_MS = 180_000

/** First 429 stands down this long; subsequent ones double up to the cap. */
const BACKOFF_START_MS = 300_000
const BACKOFF_MAX_MS = 600_000

/** A request that never settles must not wedge the store. */
const REQUEST_TIMEOUT_MS = 15_000

/** One reported rate-limit window, as the subscriptions plugin maps it. */
export interface UsageWindow {
  readonly kind: 'session' | 'weekly' | 'other'
  readonly scope?: string
  readonly usedPercent: number
  readonly resetsAt?: number
}

/** The usage snapshot for one provider. */
export interface Usage {
  readonly supported: boolean
  readonly windows?: readonly UsageWindow[]
  /**
   * The plan tier, e.g. `max`. The Agent SDK reports it as `subscription_type`
   * alongside the windows, so unlike the RPC channel this store replaced, the
   * caption has a tier to name.
   */
  readonly plan?: string
}

/** What subscribers see. `at` is 0 until a reading has ever landed. */
export interface UsageState {
  readonly usage: Usage | null
  readonly at: number
}

/** The minimal RPC surface this plugin needs from the connection handle. */
export interface RpcCaller {
  call(channel: string, endpoint: string, payload: unknown): Promise<unknown>
}

interface RpcResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly message?: string }
}

export interface UsageStore {
  get(): UsageState
  subscribe(fn: (state: UsageState) => void): () => void
  /** Revalidate if — and only if — the floor and any active backoff allow it. */
  request(): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a failure is a rate limit. The failure reaches the browser as
 * `{ code: 'internal', message }` — the RPC branch types `details` as an empty
 * object upstream, so nothing structured survives — and the status is
 * recovered from the message text.
 */
function isRateLimited(message: string): boolean {
  return /\b429\b/.test(message) || /rate.?limit/i.test(message)
}

/**
 * The delay the provider asked for, when the node half disclosed one.
 *
 * dsh-plugin-subscriptions historically dropped `Retry-After` inside
 * `oauthEndpointError`, so this returned nothing and the caller fell back to a
 * fixed backoff. V1ki/dsh-plugin-subscriptions#41 parses the header and
 * appends a ` (retry-after: 300s)` suffix — the only channel that survives
 * that RPC boundary — so the first pattern below reads the interval the
 * provider actually named. The looser pattern stays for any other phrasing,
 * and an installation without that change simply keeps the fixed backoff.
 */
function retryHintMs(message: string): number | null {
  const match = /retry-after:\s*(\d+)s/i.exec(message)
    ?? /retry[- ]after["':\s]*(\d+)/i.exec(message)
  if (match === null) return null
  const seconds = Number(match[1])
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

function readCache(): UsageState | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as UsageState
    if (parsed?.usage && Array.isArray(parsed.usage.windows)) return parsed
  } catch {
    // The cache is an optimization, never a requirement.
  }
  return null
}

function writeCache(usage: Usage, at: number): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ usage, at }))
  } catch {
    // Quota exhausted or storage blocked: proceed without a warm start.
  }
}

/**
 * Create the shared store.
 * @param rpc - the connection's RPC caller.
 * @returns the store; call `request()` to revalidate under the floor.
 */
export function createUsageStore(rpc: RpcCaller): UsageStore {
  const listeners = new Set<(state: UsageState) => void>()
  const seeded = readCache()
  let state: UsageState = seeded ?? { usage: null, at: 0 }
  let inflight = false
  let blockedUntil = 0
  let backoffMs = 0

  const publish = (next: UsageState): void => {
    state = next
    for (const fn of [...listeners]) fn(state)
  }

  const request = (): void => {
    const now = Date.now()
    if (inflight || now < blockedUntil || now - state.at < MIN_INTERVAL_MS) return

    inflight = true
    let settled = false
    const finish = (apply?: () => void): void => {
      if (settled) return
      settled = true
      inflight = false
      clearTimeout(watchdog)
      apply?.()
    }
    const watchdog = setTimeout(() => { finish() }, REQUEST_TIMEOUT_MS)

    rpc.call(CHANNEL, 'usage', {}).then(
      (raw) => {
        const result = raw as RpcResult
        if (!result.ok) throw new Error(result.error?.message ?? 'usage lookup failed')
        finish(() => {
          backoffMs = 0
          blockedUntil = 0
          const at = Date.now()
          const usage = result.value as Usage
          writeCache(usage, at)
          publish({ usage, at })
        })
      },
      (error: unknown) => {
        const message = messageOf(error)
        finish(() => {
          if (!isRateLimited(message)) return
          const hint = retryHintMs(message)
          backoffMs = hint ?? (backoffMs === 0
            ? BACKOFF_START_MS
            : Math.min(backoffMs * 2, BACKOFF_MAX_MS))
          blockedUntil = Date.now() + backoffMs
          // Stale-while-revalidate: the last good reading stays untouched, so
          // a refused request never blanks the meter or raises an error card.
        })
      },
    )
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    request,
  }
}

/**
 * The window the ring represents: the current model's own weekly limit when
 * the provider scopes one to it, otherwise the shared weekly pool — the two
 * readings a user is actually spending.
 *
 * The scope match is derived rather than hardcoded. An earlier version tested
 * for Fable by name, which would silently fall back to the shared pool the day
 * a limit is scoped to any other model; comparing the reported scope against
 * the model id keeps working as the plan shape changes.
 *
 * Falls back to the most consumed window so the ring still means something on
 * a plan shape this code has not seen.
 */
export function pickWindow(
  windows: readonly UsageWindow[],
  model: string | null,
): UsageWindow | null {
  if (windows.length === 0) return null
  const weekly = windows.filter(w => w.kind === 'weekly')
  if (typeof model === 'string') {
    const scoped = weekly.find(w => typeof w.scope === 'string' && w.scope.length > 0
      && model.toLowerCase().includes(w.scope.toLowerCase()))
    if (scoped !== undefined) return scoped
  }
  const overall = weekly.find(w => w.scope === undefined || w.scope === '')
  if (overall !== undefined) return overall
  if (weekly.length > 0) return weekly[0]!
  return [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]!
}
