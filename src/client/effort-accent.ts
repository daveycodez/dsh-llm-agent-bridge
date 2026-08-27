/**
 * Accent for the Ultracode effort row in the model picker.
 *
 * The row belongs to `dsh-client-ui-model-selection`, and an adapter can only
 * describe an effort as `{ id, name, description }` — there is no colour, icon
 * or emphasis in that contract. The rendered choice is a bare
 * `<button role="menuitemradio">` carrying no effort id, so its label is the
 * only handle, exactly as the settings-nav glyph in dsh-plugin-usage-meter
 * found its cell by label.
 *
 * This therefore decorates after render, on the same terms:
 *
 * - it colours the label element itself, not the button: the label sits in its
 *   own span carrying the picker's own `color` rule, which beats a colour
 *   inherited from an ancestor, and the declaration is set `important` so the
 *   class cannot win on specificity either;
 * - it sets an inline style on the existing node rather than replacing any
 *   React-managed one, so React's tree is never invalidated underneath it;
 * - it uses `--dsw-alias-state-business-primary`, the shell's own accent token,
 *   so the row follows the active theme instead of hard-coding a colour;
 * - it marks what it touched and skips already-marked nodes, so re-renders are
 *   cheap and two installs cannot fight;
 * - every failure path leaves the row exactly as shipped, and disposal restores
 *   it.
 *
 * Delete this file if the effort contract ever grows a presentation field, or
 * if the picker starts exposing the effort id on the element — either would be
 * a better handle than a label.
 */

/** The label the adapter gives the Ultracode effort. */
const ULTRACODE_LABEL = 'Ultracode'

/** The shell's own accent token, so the row follows the active theme. */
const ACCENT = 'var(--dsw-alias-state-business-primary)'

/** One step above the 500 the picker's label ships at. */
const WEIGHT = '600'

/** Marks a button this module coloured, so re-renders skip it. */
const PATCHED_FLAG = 'agentBridgeUltracode'

/** What one decorated row needs to be restored to its shipped state. */
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
 * The element holding a row's label: the innermost span whose text is exactly
 * the label, so the colour lands on the node whose own rule would otherwise
 * win, and a row whose name merely contains the word is left alone.
 */
function labelElement(row: Element): HTMLElement | null {
  const spans = [...row.querySelectorAll('span')]
  for (const span of spans) {
    if (span.querySelector('span') !== null) continue
    if ((span.textContent ?? '').trim() === ULTRACODE_LABEL) return span as HTMLElement
  }
  return null
}

function decorate(restores: Restore[]): void {
  for (const row of queryAll('button[role="menuitemradio"]')) {
    try {
      const element = labelElement(row)
      if (element === null || element.dataset[PATCHED_FLAG] !== undefined) continue

      restores.push({ element, color: element.style.color, fontWeight: element.style.fontWeight })
      element.dataset[PATCHED_FLAG] = 'true'
      // `important`, because the picker's own class sets both of these on this
      // node — the label ships at 500, so this is one step up, not a bold.
      element.style.setProperty('color', ACCENT, 'important')
      element.style.setProperty('font-weight', WEIGHT, 'important')
    } catch {
      // A row mid-unmount: leave it as shipped.
    }
  }
}

/**
 * Start accenting the row, and return a disposer that restores every row it
 * touched.
 */
export function installEffortAccent(): () => void {
  const restores: Restore[] = []
  const run = (): void => { decorate(restores) }

  run()

  let observer: MutationObserver | undefined
  try {
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body !== null) {
      // The picker mounts on open, so the row does not exist at install time.
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
        delete entry.element.dataset[PATCHED_FLAG]
        entry.element.style.removeProperty('color')
        entry.element.style.removeProperty('font-weight')
        if (entry.color) entry.element.style.color = entry.color
        if (entry.fontWeight) entry.element.style.fontWeight = entry.fontWeight
      } catch {
        // The node may already be gone with the closed picker.
      }
    }
    restores.length = 0
  }
}
