/**
 * The composer usage ring: a ContextMeter-shaped meter in the input tool row
 * that reports the Claude subscription limit relevant to the session's current
 * model, and opens a panel of every reported limit.
 *
 * It renders only while a Claude model is selected, so it never claims to
 * describe a turn it has no data for.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './UsageMeter.module.css'
import {
  clampPercent,
  formatReset,
  planCaption,
  ringLabel,
  thresholdColor,
  windowLabel,
} from './format.js'
import { RUNNING_INTERVAL_MS, pickWindow, type UsageState, type UsageStore } from './usage.js'

/** Ring geometry, matching the shipped ContextMeter: 14px box, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** ContextMeter's own hover delay. */
const TOOLTIP_DELAY_MS = 200

/**
 * Model-gate cadence. The current model is not on the session snapshot, no
 * model-change event exists in the client catalog, and the model selector's
 * store is private to that plugin — so the gate polls `sessions.models`. That
 * is a LOCAL host RPC with no upstream traffic, so it can run briskly.
 */
const GATE_POLL_MS = 700

/**
 * A model switch is always a user gesture, so any pointer or Enter gesture
 * schedules a short probe burst. The poll is the safety net; the burst is what
 * makes the ring appear and disappear promptly rather than a tick later.
 */
const GATE_BURST_MS = [90, 260, 600, 1100] as const
const GATE_BURST_THROTTLE_MS = 350

/** What the session's current model resolves to for gating purposes. */
export interface ModelGate {
  readonly visible: boolean
  readonly model: string | null
}

export interface UsageMeterProps {
  /** Resolve the session's current model; rejects rather than guessing. */
  readonly checkModel?: () => Promise<ModelGate>
  /** The shared usage store. */
  readonly store?: UsageStore
  /** Session snapshot selector supplied by the slot renderer. */
  readonly useSession?: <T>(select: (snapshot: { running?: boolean }) => T) => T
}

/**
 * The ring itself. Kept separate so the trigger stays a plain button — the
 * Tooltip primitive clones its child and needs to own that element's handlers.
 */
function Ring({ percent, color }: { percent: number, color: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
      <circle className={styles.track} cx="7" cy="7" r={RADIUS} />
      <circle
        className={styles.fill}
        cx="7"
        cy="7"
        r={RADIUS}
        stroke={color}
        strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`}
        transform="rotate(-90 7 7)"
      />
    </svg>
  )
}

export function UsageMeter({ checkModel, store, useSession }: UsageMeterProps): React.ReactElement | null {
  const running = useSession?.(snapshot => snapshot.running === true) === true

  const [gate, setGate] = useState<ModelGate>({ visible: false, model: null })
  const [usageState, setUsageState] = useState<UsageState>(() => store?.get() ?? { usage: null, at: 0 })
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (store === undefined) return
    setUsageState(store.get())
    return store.subscribe(setUsageState)
  }, [store])

  // Model gate: brisk poll plus gesture bursts, so a switch registers promptly.
  useEffect(() => {
    if (checkModel === undefined) return
    let cancelled = false
    let inflight = false
    let lastBurst = 0
    const burstTimers: ReturnType<typeof setTimeout>[] = []

    const check = (): void => {
      if (cancelled || inflight) return
      inflight = true
      void checkModel().then(
        (next) => {
          if (cancelled) return
          setGate(prev => (prev.visible === next.visible && prev.model === next.model ? prev : next))
        },
        () => {
          // A failed probe keeps the last known gate rather than flickering.
        },
      ).finally(() => { inflight = false })
    }

    const clearBurst = (): void => {
      while (burstTimers.length > 0) clearTimeout(burstTimers.pop())
    }

    const burst = (event: Event): void => {
      // Enter commits the /model popup; other keys are ordinary typing.
      if (event.type === 'keyup' && (event as KeyboardEvent).key !== 'Enter') return
      const now = Date.now()
      if (now - lastBurst < GATE_BURST_THROTTLE_MS) return
      lastBurst = now
      clearBurst()
      for (const delay of GATE_BURST_MS) burstTimers.push(setTimeout(check, delay))
    }

    check()
    const poll = setInterval(check, GATE_POLL_MS)
    document.addEventListener('pointerdown', burst, true)
    document.addEventListener('keyup', burst, true)
    return () => {
      cancelled = true
      clearBurst()
      clearInterval(poll)
      document.removeEventListener('pointerdown', burst, true)
      document.removeEventListener('keyup', burst, true)
    }
  }, [checkModel])

  // Revalidate only while a turn is running; an idle session makes no upstream
  // calls at all, which is what keeps the shared endpoint available to the
  // subscriptions Settings page.
  useEffect(() => {
    if (!gate.visible || !running || store === undefined) return
    const timer = setInterval(() => { store.request() }, RUNNING_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [running, gate.visible, store])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!gate.visible && open) setOpen(false)
  }, [gate.visible, open])

  /**
   * Hover is the revalidation trigger. Pointing at the ring is the earliest
   * honest signal of intent, so the panel opens onto an already-fresh reading
   * instead of refetching underneath the user. The Tooltip resolves its label
   * only while visible, which makes this the natural hook.
   */
  const resolveLabel = useCallback((): string => {
    store?.request()
    const windows = usageState.usage?.windows ?? []
    return ringLabel(pickWindow(windows, gate.model))
  }, [store, usageState, gate.model])

  if (!gate.visible) return null

  const windows = usageState.usage?.windows ?? []
  const selected = pickWindow(windows, gate.model)
  const percent = selected === null ? 0 : clampPercent(selected.usedPercent)
  const color = thresholdColor(percent)
  const label = ringLabel(selected)

  return (
    <span className={styles.root} ref={rootRef}>
      <Tooltip label={resolveLabel} side="top" delayMs={TOOLTIP_DELAY_MS} disabled={open}>
        <button
          type="button"
          className={styles.trigger}
          style={{ color }}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <Ring percent={percent} color={color} />
        </button>
      </Tooltip>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Subscription usage">
          <p className={styles.caption}>{planCaption(usageState.usage)}</p>
          {windows.length === 0
            ? <div className={styles.empty}>No usage data yet.</div>
            : windows.map((window, index) => {
              const used = clampPercent(window.usedPercent)
              const reset = formatReset(window.resetsAt)
              return (
                <div className={styles.limit} key={`${window.kind}:${window.scope ?? ''}:${String(index)}`}>
                  <div className={styles.line}>
                    <span className={styles.name}>{windowLabel(window)}</span>
                    {reset !== '' && <span className={styles.reset}>{reset}</span>}
                    <span className={reset === '' ? `${styles.percent} ${styles.percentAlone}` : styles.percent}>
                      {`${String(Math.round(used))}%`}
                    </span>
                  </div>
                  <div className={styles.bar}>
                    <div
                      className={styles.barFill}
                      style={{ width: `${String(used)}%`, background: thresholdColor(used) }}
                    />
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </span>
  )
}
