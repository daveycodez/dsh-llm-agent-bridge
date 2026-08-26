/**
 * Ambient declarations for the two specifiers that have no types available at
 * build time in this standalone package.
 *
 * Neither is bundled: `@deepseek-ai/dsh-client-ui-primitives` is marked
 * external and resolved by the web shell's module loader at runtime, and the
 * CSS module is rewritten by the build into an inlined, self-injecting shim.
 * Declaring them here keeps `tsc` honest about their shapes without adding a
 * dependency on the harness monorepo — which is not published as a whole, and
 * whose packages this plugin must not carry a second copy of.
 *
 * The `Tooltip` signature mirrors the primitive's own contract; a `label`
 * thunk is re-read only while the bubble is visible, which is what makes it
 * usable as a revalidation hook.
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement } from 'react'

  export interface TooltipProps {
    /** Bubble text, or a resolver evaluated only while the bubble is visible. */
    readonly label: string | (() => string)
    /** Placement relative to the anchor. */
    readonly side?: 'top' | 'right' | 'bottom'
    /** Hover delay in milliseconds; keyboard focus stays immediate. */
    readonly delayMs?: number
    /** Suppress the bubble without remounting the anchor. */
    readonly disabled?: boolean
    /** Width cap in pixels, for labels the default half-viewport cap would over-widen. */
    readonly maxWidth?: number
    /** A single anchor element; its own ref is forwarded alongside the tooltip's. */
    readonly children: ReactElement
  }

  export function Tooltip(props: TooltipProps): ReactElement
}

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
