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
 * - it sets an inline colour on the existing button rather than replacing any
 *   React-managed node, so React's tree is never invalidated underneath it;
 * - it uses `--dsw-alias-brand-primary`, the shell's own accent token, so the
 *   row follows the active theme instead of hard-coding a colour;
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

/** The shell's accent token, the same one its primary affordances use. */
const ACCENT = 'var(--dsw-alias-brand-primary)'

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

function decorate(restores: Restore[]): void {
  for (const node of queryAll('button[role="menuitemradio"]')) {
    const element = node as HTMLElement
    try {
      if (element.dataset[PATCHED_FLAG] !== undefined) continue
      // The label is the handle; match it exactly so a model or effort whose
      // name merely contains the word is left alone.
      if ((element.textContent ?? '').trim() !== ULTRACODE_LABEL) continue

      restores.push({ element, color: element.style.color, fontWeight: element.style.fontWeight })
      element.dataset[PATCHED_FLAG] = 'true'
      element.style.color = ACCENT
      element.style.fontWeight = '600'
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
        entry.element.style.color = entry.color
        entry.element.style.fontWeight = entry.fontWeight
      } catch {
        // The node may already be gone with the closed picker.
      }
    }
    restores.length = 0
  }
}
