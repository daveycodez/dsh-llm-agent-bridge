/** Presentation helpers: limit vocabulary, thresholds, and reset phrasing. */

import type { Usage, UsageWindow } from './usage.js'

/**
 * Threshold steps, matching the Claude Code app: the meter runs blue while
 * healthy, warns from 75%, and reads as exhausted from 95%.
 */
export const WARN_PERCENT = 75
export const DANGER_PERCENT = 95

/** Clamp a reported percentage into the range the meter can draw. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

/**
 * Claude's own row vocabulary, so the panel reads like the product it
 * reports on: "5-hour limit", "Weekly · all models", "Weekly · Fable".
 */
export function windowLabel(window: UsageWindow): string {
  if (window.kind === 'session') return '5-hour limit'
  if (window.kind === 'weekly') {
    return window.scope !== undefined && window.scope !== ''
      ? `Weekly · ${window.scope}`
      : 'Weekly · all models'
  }
  return window.scope !== undefined && window.scope !== '' ? window.scope : 'Limit'
}

/** Tooltip and accessible name for the ring, e.g. `Weekly · all models 75%`. */
export function ringLabel(window: UsageWindow | null): string {
  if (window === null) return 'Claude usage'
  return `${windowLabel(window)} ${Math.round(window.usedPercent)}%`
}

/** The design token a given consumption maps to. */
export function thresholdColor(percent: number): string {
  if (percent >= DANGER_PERCENT) return 'var(--dsw-alias-state-error-primary)'
  if (percent >= WARN_PERCENT) return 'var(--dsw-alias-state-warn-label)'
  return 'var(--dsw-static-blue-450)'
}

/**
 * Reset phrasing, following the product: a countdown while the window is
 * close ("Resets in 4 hr 35 min") and a weekday clock time beyond a day
 * ("Resets Thu 11:59 AM"), where a countdown would be noise.
 */
export function formatReset(resetsAt: number | undefined, now = Date.now()): string {
  if (resetsAt === undefined || resetsAt === 0) return ''
  const diff = resetsAt - now
  const MINUTE = 60_000
  const HOUR = 3_600_000
  if (diff > 0 && diff < 24 * HOUR) {
    const totalMinutes = Math.round(diff / MINUTE)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    if (hours > 0) return `Resets in ${hours} hr${minutes > 0 ? ` ${minutes} min` : ''}`
    return `Resets in ${minutes} min`
  }
  const date = new Date(resetsAt)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const weekday = days[date.getDay()]
  const rawHours = date.getHours()
  const suffix = rawHours >= 12 ? 'PM' : 'AM'
  const hours = rawHours % 12 === 0 ? 12 : rawHours % 12
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `Resets ${weekday} ${hours}:${minutes} ${suffix}`
}

/**
 * The panel caption, e.g. `Plan usage limits · Max`. The tier comes from the
 * Agent SDK's `subscription_type`; without one the caption reads plainly.
 */
export function planCaption(usage: Usage | null): string {
  const plan = usage?.plan
  if (typeof plan !== 'string' || plan.length === 0) return 'Plan usage limits'
  return `Plan usage limits · ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`
}
