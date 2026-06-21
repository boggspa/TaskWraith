/**
 * Node-builtin-FREE registry of selectable APP-ICON variants + the WWDC26
 * limited-time availability gate.
 *
 * Both the main process (sanitizer + dock applier) and the renderer (Settings
 * picker) import this module, so it MUST stay free of node builtins (a node
 * import reachable from the renderer blanks the window — see MEMORY.md). Mirrors
 * the discipline of `retiredProviders` / `remoteWorkspaceDefaults`.
 *
 * The Swift twin `ios/TaskWraithKit/Sources/TaskWraithUI/AppIconAvailability.swift`
 * mirrors `WWDC26_AVAILABLE_UNTIL_MS` + `WWDC26_AVAILABILITY` and is kept in sync
 * by a drift-guard test (`iconVariants.test.ts`).
 *
 * INVARIANT: the availability gate is consulted ONLY on OFFER surfaces (the
 * Settings picker list + the sanitizer's accept-check for a NEW selection). The
 * APPLY path (dock swap / iOS setAlternateIconName / startup re-apply) must NEVER
 * consult it — that is what lets an already-chosen WWDC26 icon be grandfathered
 * past the cutoff instead of being yanked out from under the user.
 */

export type AppIconVariant = 'regular' | 'wwdc26' | 'monoline' | 'glass'

export const DEFAULT_APP_ICON_VARIANT: AppIconVariant = 'regular'

export interface AppIconVariantMeta {
  id: AppIconVariant
  label: string
  description: string
  /** Only offered while within the limited-time window (see the gate below). */
  limitedTime?: boolean
}

export const APP_ICON_VARIANTS: readonly AppIconVariantMeta[] = [
  { id: 'regular', label: 'Regular', description: 'The classic TaskWraith ghost.' },
  {
    id: 'wwdc26',
    label: 'WWDC26',
    description: 'Limited-edition metallic glass ghost.',
    limitedTime: true
  },
  { id: 'monoline', label: 'Monoline', description: 'Minimalist outline ghost.' },
  { id: 'glass', label: 'Glass', description: 'Frosted Liquid Glass ghost.' }
]

/** True when `value` is a valid, currently-known variant id. */
export function isAppIconVariant(value: unknown): value is AppIconVariant {
  return value === 'regular' || value === 'wwdc26' || value === 'monoline' || value === 'glass'
}

// --- WWDC26 limited-time availability gate ------------------------------------
//
// Single editable source of truth for the cutoff. To change the rule, edit
// EITHER constant below (and the Swift twin — the drift-guard test will fail if
// they diverge). 2026-09-01T00:00:00Z: WWDC26 is OFFERED strictly before this
// instant, hidden on/after it.
export const WWDC26_AVAILABLE_UNTIL_MS = Date.UTC(2026, 8, 1) // month 8 = September

/**
 * Master switch to make the rule trivially changeable / removable:
 *   'auto'   — honour the cutoff date (default)
 *   'always' — always offer WWDC26 (extend the promo / make it permanent)
 *   'never'  — never offer WWDC26 (retire it early)
 */
export type Wwdc26Availability = 'auto' | 'always' | 'never'
export const WWDC26_AVAILABILITY: Wwdc26Availability = 'auto'

/** Whether the WWDC26 variant may be OFFERED at the given wall-clock time. */
export function isWwdc26IconAvailable(nowMs: number): boolean {
  if (WWDC26_AVAILABILITY === 'always') return true
  if (WWDC26_AVAILABILITY === 'never') return false
  return nowMs < WWDC26_AVAILABLE_UNTIL_MS
}

/**
 * The variants to OFFER in a picker at the given time. The limited-time gate is
 * applied here (an OFFER surface) only — never on apply/persist/startup.
 */
export function availableIconVariants(nowMs: number): AppIconVariantMeta[] {
  return APP_ICON_VARIANTS.filter((v) => (v.id === 'wwdc26' ? isWwdc26IconAvailable(nowMs) : true))
}
