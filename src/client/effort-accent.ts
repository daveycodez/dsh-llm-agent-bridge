/**
 * Accent for the Ultracode effort, in both places the picker shows it.
 *
 * An adapter can only describe an effort as `{ id, name, description }` — the
 * contract carries no colour, icon or emphasis — and neither the dropdown row
 * nor the composer trigger exposes the effort id in the DOM. The label text is
 * therefore the only handle, exactly as the settings-nav glyph in
 * dsh-plugin-usage-meter found its cell by label.
 *
 * Two targets, two tokens, both referenced as `var(...)` rather than resolved
 * here, so a theme change repaints them without this plugin knowing:
 *
 * - the dropdown row takes `--dsw-alias-button-info-fill`, the solid accent;
 * - the trigger's effort chip — the muted text beside the model name — takes
 *   `--dsw-alias-button-info-hover`, the lighter one, since it sits against the
 *   composer rather than inside a menu.
 *
 * Both are weighted one step above whatever they ship at, read from the
 * computed style rather than hard-coded, so a restyle upstream keeps the
 * relationship instead of the number.
 *
 * The decoration runs after render on the same terms as that nav glyph: inline
 * styles on existing nodes rather than replaced ones, so React's tree is never
 * invalidated; `important`, because the picker's own classes set both
 * properties on these nodes; a marker so re-renders skip them and two installs
 * cannot fight; and a disposer that restores every node it touched. Every
 * failure path leaves the element exactly as shipped.
 *
 * Delete this file if the effort contract ever grows a presentation field, or
 * if either surface starts exposing the effort id — both would be better
 * handles than a label.
 */

/** The label the adapter gives the Ultracode effort. */
const ULTRACODE_LABEL = 'Ultracode'

/** Solid accent, for the row inside the dropdown. */
const DROPDOWN_COLOR = 'var(--dsw-alias-button-info-fill)'

/** Lighter accent, for the muted effort chip on the composer trigger. */
const TRIGGER_COLOR = 'var(--dsw-alias-button-info-hover)'

/** How much heavier the accented text sits than its neighbours. */
const WEIGHT_STEP = 100

/** Marks a node this module styled, so re-renders skip it. */
const PATCHED_FLAG = 'agentBridgeUltracode'

/** What one decorated node needs to be restored to its shipped state. */
interface Restore {
  readonly element: HTMLElement
  readonly color: string
  readonly fontWeight: string
}

function queryAll(selector: string): Element[] {
  try {
    return typeof document === 'undefined' ? [] : [...document.querySelectorAll(selector)]
  } catch {
    return []
  }
}

/**
 * One step above what the element already renders at.
 *
 * The trigger chip inherits its weight rather than declaring one, so the
 * shipped value is read from the computed style; anything unreadable falls back
 * to the 500 the picker's own labels use.
 */
function heavierWeight(element: HTMLElement): string {
  let shipped = 500
  try {
    const computed = Number.parseInt(window.getComputedStyle(element).fontWeight, 10)
    if (Number.isFinite(computed) && computed > 0) shipped = computed
  } catch {
    // Fall back to the picker's own label weight.
  }
  return String(Math.min(900, shipped + WEIGHT_STEP))
}

function paint(element: HTMLElement, color: string, restores: Restore[]): void {
  if (element.dataset[PATCHED_FLAG] !== undefined) return
  const weight = heavierWeight(element)
  restores.push({ element, color: element.style.color, fontWeight: element.style.fontWeight })
  element.dataset[PATCHED_FLAG] = 'true'
  // `important`, because the picker's own classes colour these nodes.
  element.style.setProperty('color', color, 'important')
  element.style.setProperty('font-weight', weight, 'important')
}

/** Put one node back exactly as it shipped. */
function unpaint(entry: Restore): void {
  const { element } = entry
  delete element.dataset[PATCHED_FLAG]
  element.style.removeProperty('color')
  element.style.removeProperty('font-weight')
  if (entry.color) element.style.color = entry.color
  if (entry.fontWeight) element.style.fontWeight = entry.fontWeight
}

/**
 * Drop the accent from anything that is no longer Ultracode.
 *
 * React reuses these nodes and swaps their text rather than remounting them —
 * the composer's effort chip is one span that reads "Max" or "High" or
 * "Ultracode" in turn — so a node painted while it said Ultracode keeps the
 * accent when the selection changes unless it is revisited every pass.
 */
function releaseStale(restores: Restore[]): void {
  for (let index = restores.length - 1; index >= 0; index -= 1) {
    const entry = restores[index]!
    try {
      if (!entry.element.isConnected) {
        restores.splice(index, 1)
        continue
      }
      if ((entry.element.textContent ?? '').trim() === ULTRACODE_LABEL) continue
      unpaint(entry)
      restores.splice(index, 1)
    } catch {
      restores.splice(index, 1)
    }
  }
}

/**
 * The element holding a row's label: the innermost span whose text is exactly
 * the label, so the colour lands on the node whose own rule would otherwise
 * win, and a row whose name merely contains the word is left alone.
 */
function labelElement(row: Element): HTMLElement | null {
  for (const span of [...row.querySelectorAll('span')]) {
    if (span.querySelector('span') !== null) continue
    if ((span.textContent ?? '').trim() === ULTRACODE_LABEL) return span as HTMLElement
  }
  return null
}

function decorate(restores: Restore[]): void {
  // Before painting anything, let go of nodes the picker has since reused for
  // another effort.
  releaseStale(restores)

  // The dropdown row, while the menu is open.
  for (const row of queryAll('button[role="menuitemradio"]')) {
    try {
      const element = labelElement(row)
      if (element !== null) paint(element, DROPDOWN_COLOR, restores)
    } catch {
      // A row mid-unmount: leave it as shipped.
    }
  }

  // The effort chip on the composer trigger, whenever Ultracode is selected.
  // The class is content-hashed, so match on the stable part of the name.
  for (const chip of queryAll('[class*="triggerEffort"]')) {
    try {
      if ((chip.textContent ?? '').trim() !== ULTRACODE_LABEL) continue
      paint(chip as HTMLElement, TRIGGER_COLOR, restores)
    } catch {
      // The trigger may be re-rendering: leave it as shipped.
    }
  }
}

/**
 * Start accenting both surfaces, and return a disposer that restores every node
 * it touched.
 */
export function installEffortAccent(): () => void {
  const restores: Restore[] = []
  const run = (): void => { decorate(restores) }

  run()

  let observer: MutationObserver | undefined
  try {
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body !== null) {
      // The menu mounts on open and the trigger re-renders on selection, so
      // neither node exists at install time.
      observer = new MutationObserver(run)
      observer.observe(document.body, { childList: true, subtree: true })
    }
  } catch {
    observer = undefined
  }

  return () => {
    try {
      observer?.disconnect()
    } catch {
      // Best-effort teardown.
    }
    for (const entry of restores) {
      try {
        unpaint(entry)
      } catch {
        // The node may already be gone with the closed picker.
      }
    }
    restores.length = 0
  }
}
