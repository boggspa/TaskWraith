/**
 * Node-builtin-FREE registry of selectable APP-ICON variants.
 *
 * Both the main process (sanitizer + dock applier) and the renderer (Settings
 * picker) import this module, so it MUST stay free of node builtins (a node
 * import reachable from the renderer blanks the window — see MEMORY.md). Mirrors
 * the discipline of `retiredProviders` / `remoteWorkspaceDefaults`.
 *
 * The Swift twin is `ios/TaskWraithKit/Sources/TaskWraithUI/AppIconVariant.swift`;
 * `iconVariants.test.ts` drift-guards the variant set against it.
 *
 * 2026-08: Monoline (v2 art) is the default and the packaged build icon on every
 * platform; its dark face is the sculpted-glass "Regular" v2 render, mirroring
 * the iOS primary appiconset (Default = Monoline 2, Dark = Regular v2). The
 * limited-time WWDC26 variant is retired — a persisted `wwdc26` value fails
 * `isAppIconVariant` and every consumer falls back to the default.
 */

export type AppIconVariant = 'regular' | 'monoline' | 'glass' | 'lightMonoline'

export const DEFAULT_APP_ICON_VARIANT: AppIconVariant = 'monoline'

export interface AppIconVariantMeta {
  id: AppIconVariant
  label: string
  description: string
}

export const APP_ICON_VARIANTS: readonly AppIconVariantMeta[] = [
  { id: 'monoline', label: 'Monoline', description: 'Outline ghost with a sculpted dark face.' },
  { id: 'regular', label: 'Regular', description: 'The sculpted glass ghost.' },
  { id: 'glass', label: 'Glass', description: 'Frosted Liquid Glass ghost.' },
  {
    id: 'lightMonoline',
    label: 'Light Monoline',
    description: 'Bright monoline ghost on a soft light base.'
  }
]

/** True when `value` is a valid, currently-known variant id. */
export function isAppIconVariant(value: unknown): value is AppIconVariant {
  return (
    value === 'regular' || value === 'monoline' || value === 'glass' || value === 'lightMonoline'
  )
}

/** The variants to OFFER in a picker. All variants are always offered. */
export function availableIconVariants(): readonly AppIconVariantMeta[] {
  return APP_ICON_VARIANTS
}
