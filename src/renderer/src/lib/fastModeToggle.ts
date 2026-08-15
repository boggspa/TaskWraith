import type { ProviderId } from '../../../main/store/types'
import {
  CURSOR_GROK_45_BASE_MODEL_ID,
  CURSOR_GROK_46_BASE_MODEL_ID,
  GROK_45_MODEL_ID,
  GROK_46_MODEL_ID,
  isCursorGrokModelId
} from '../../../shared/grok45Models'

/**
 * fastModeToggle — the single source of truth for "is Fast mode on, and what
 * does flipping it change".
 *
 * Two surfaces drive the same toggle and must never disagree: the Fast switch
 * inside the composer's Model + Reasoning popover, and the `/fast` slash
 * command. Fast is not one setting — Codex moves a service TIER string, Claude
 * and Kimi move a boolean flag (Kimi mirroring it into a tier), Cursor moves a
 * flag for its Grok models but swaps the MODEL for the composer-2.5 pair.
 * Encoding that once, as a descriptor the caller applies, is what keeps the
 * slash command honest when the picker's rules change.
 *
 * The helpers are pure: they read a snapshot and return what should change.
 * Applying it — live composer state vs. a bound ensemble participant, and
 * whether to persist the pick — stays with the caller, because those differ by
 * surface.
 */

/** Providers whose Fast switch is actually wired. */
const FAST_MODE_TOGGLE_PROVIDERS: ReadonlySet<string> = new Set([
  'codex',
  'claude',
  'kimi',
  'cursor'
])

/** Minimal model-option shape: only the speed-tier field matters here. */
export interface FastModeModelOption {
  id: string
  additionalSpeedTiers?: string[]
}

export interface FastModeSelection {
  provider: ProviderId
  /** The model id currently selected for `provider`. */
  selectedModel: string
  /** Codex's service tier — `'fast'` when Fast is on, `''`/other when off. */
  codexServiceTier?: string | null
  claudeFastMode?: boolean | null
  kimiFastMode?: boolean | null
  cursorFastMode?: boolean | null
}

/** What flipping Fast mode changes. Callers apply it in their own context. */
export type FastModeToggleDescriptor =
  | { kind: 'codex-tier'; serviceTier: string; fastModeEnabled: boolean }
  | {
      kind: 'flag'
      provider: 'claude' | 'kimi' | 'cursor'
      fastModeEnabled: boolean
      /** Kimi mirrors the flag into a service tier; the others omit it. */
      serviceTier?: string
    }
  | { kind: 'model'; model: string }

/** True when this provider has a Fast switch at all (model-independent). */
export function providerSupportsFastModeToggle(provider: ProviderId): boolean {
  return FAST_MODE_TOGGLE_PROVIDERS.has(provider)
}

/**
 * The model ids that expose a Fast switch for a provider. Codex/Claude/Kimi
 * declare it per model via `additionalSpeedTiers`; Cursor and Grok carry fixed
 * catalogues because their Fast variants are separate model ids.
 */
export function fastModeCapableModelIds(
  provider: ProviderId,
  models: readonly FastModeModelOption[] = []
): Set<string> {
  if (provider === 'codex' || provider === 'claude' || provider === 'kimi') {
    return new Set(
      models.filter((model) => model.additionalSpeedTiers?.includes('fast')).map((model) => model.id)
    )
  }
  if (provider === 'cursor') {
    return new Set([
      'composer-2.5',
      'composer-2.5-fast',
      CURSOR_GROK_46_BASE_MODEL_ID,
      CURSOR_GROK_45_BASE_MODEL_ID
    ])
  }
  if (provider === 'grok') {
    return new Set([GROK_46_MODEL_ID, GROK_45_MODEL_ID, 'grok-composer-2.5-fast'])
  }
  return new Set<string>()
}

/**
 * Whether Fast is offerable right now: the provider has a wired switch AND the
 * selected model supports it. Grok is deliberately excluded — its Fast variants
 * appear in {@link fastModeCapableModelIds} for the picker's glyphs, but no
 * toggle is wired for it, so offering `/fast` there would be a dead entry.
 */
export function fastModeToggleAvailable(
  selection: FastModeSelection,
  models: readonly FastModeModelOption[] = []
): boolean {
  if (!providerSupportsFastModeToggle(selection.provider)) return false
  return fastModeCapableModelIds(selection.provider, models).has(selection.selectedModel)
}

/** Whether Fast mode currently reads as ON for this selection. */
export function fastModeEnabledFor(selection: FastModeSelection): boolean {
  switch (selection.provider) {
    case 'codex':
      return selection.codexServiceTier === 'fast'
    case 'claude':
      return Boolean(selection.claudeFastMode)
    case 'kimi':
      return Boolean(selection.kimiFastMode)
    case 'cursor':
      return isCursorGrokModelId(selection.selectedModel)
        ? Boolean(selection.cursorFastMode)
        : selection.selectedModel === 'composer-2.5-fast'
    default:
      return false
  }
}

/**
 * What to change to flip Fast mode, or `null` when this provider has no wired
 * switch. Callers must still gate on {@link fastModeToggleAvailable} if they
 * care whether the SELECTED MODEL supports it — this function only encodes the
 * per-provider mechanics.
 */
export function nextFastModeToggle(
  selection: FastModeSelection
): FastModeToggleDescriptor | null {
  const enabled = fastModeEnabledFor(selection)
  switch (selection.provider) {
    case 'codex': {
      const serviceTier = enabled ? '' : 'fast'
      return { kind: 'codex-tier', serviceTier, fastModeEnabled: serviceTier === 'fast' }
    }
    case 'claude':
      return { kind: 'flag', provider: 'claude', fastModeEnabled: !enabled }
    case 'kimi':
      return {
        kind: 'flag',
        provider: 'kimi',
        fastModeEnabled: !enabled,
        serviceTier: !enabled ? 'fast' : 'standard'
      }
    case 'cursor':
      if (isCursorGrokModelId(selection.selectedModel)) {
        return { kind: 'flag', provider: 'cursor', fastModeEnabled: !enabled }
      }
      return {
        kind: 'model',
        model: selection.selectedModel === 'composer-2.5-fast' ? 'composer-2.5' : 'composer-2.5-fast'
      }
    default:
      return null
  }
}
