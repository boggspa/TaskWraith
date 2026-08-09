/*
 * CombinedModelPicker — replaces the per-provider native <select>
 * model + reasoning controls with one chip + a two-column popover
 * (Model on the left, Reasoning on the right). Modelled after real
 * Codex's nested model + reasoning menu.
 *
 * Wires to existing renderer state (no new IPC, no new types):
 *   - selectedModelId / onSelectModel — model picker state
 *   - reasoningOptions / selectedReasoning / onSelectReasoning —
 *     per-provider reasoning state, with provider-aware label
 *     mapping handled by `composerChipFormat`.
 *
 * Chip text comes from `formatComposerModelChip(ctx)` — per-shell
 * native format when the shell + provider align, TaskWraith default
 * otherwise.
 *
 * Popover positioning + keyboard nav cloned from AgentMentionMenu:
 *   - Portaled to document.body so it escapes any transformed
 *     ancestor.
 *   - ArrowUp / ArrowDown navigates the focused column.
 *   - ArrowLeft / ArrowRight switches columns (when both visible).
 *   - Enter commits highlighted item.
 *   - Escape dismisses.
 *   - Click-outside dismisses.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderId, ComposerStyle } from '../../../main/store/types'
import {
  formatComposerModelChip,
  reasoningDisplayLabel,
  resolveClaudeShellModelLabel
} from '../lib/composerChipFormat'
import {
  OLLAMA_DISPLAY_BRANDS,
  resolveOllamaDisplayBrand,
  resolveProviderBrandLabel,
  resolveProviderHueClass
} from '../lib/ollamaDisplayBrand'
import { humaniseModelId } from '../lib/modelDisplayName'
import type {
  CombinedModelPickerModelOption,
  CombinedModelPickerReasoningOption
} from '../lib/combinedModelPickerTypes'
import { CodexFastBoltIcon } from './icons/CodexFastBoltIcon'
import { ModelApiKeyIndicator } from './ModelApiKeyIndicator'
import { modelRequiresApiKey } from '../../../shared/apiKeyModelIndicator'
import { PillButton } from './PillButton'
import { getProviderName } from './Sidebar'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'

export type {
  CombinedModelPickerModelOption,
  CombinedModelPickerReasoningOption
} from '../lib/combinedModelPickerTypes'

export function modelPickerHueClass(
  provider: string | undefined | null,
  modelId?: string | null,
  modelLabel?: string | null
): string {
  return resolveProviderHueClass(provider, modelId, modelLabel)
}

function modelPickerAccentStyle(
  provider: string | undefined | null,
  modelId?: string | null,
  modelLabel?: string | null
): React.CSSProperties {
  const hueClass = modelPickerHueClass(provider, modelId, modelLabel)
  return {
    '--model-row-accent': `var(--provider-${hueClass}-color, var(--accent))`
  } as React.CSSProperties
}

/**
 * Empty-state text for a provider group with no rows.
 *
 * This read "Loading models…" for every provider, which was never true: it is
 * the EMPTY state, not a pending one, and nothing is still in flight by the
 * time it renders. It sent someone hunting a phantom load when the real
 * situation was "this seat has no models, and here is why" — which is exactly
 * how an empty Pi group survived long enough to be reported as a bug.
 *
 * Pi and Ollama get a specific cause because theirs is knowable: Pi's catalog
 * is filtered to upstreams with a stored key, and Ollama's comes from local
 * discovery. Every other seat keeps a neutral line rather than inventing a
 * reason we do not actually have.
 */
export function emptyProviderModelsLabel(provider?: string | null): string {
  const id = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  if (id === 'pi') return 'No models — add an upstream API key in Settings → Providers → Pi'
  if (id === 'ollama') return 'No local models found — pull one with the Ollama CLI'
  return 'No models available'
}

/** Format an ISO date (YYYY-MM-DD) as an English ordinal day + month name,
 * e.g. '2026-06-02' → '2nd June'. Returns the input unchanged on a malformed
 * value so a bad date can never crash the picker. Pure + side-effect free. */
function formatRetirementLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!match) return iso
  const month = Number.parseInt(match[2], 10) - 1
  const day = Number.parseInt(match[3], 10)
  if (!Number.isInteger(month) || month < 0 || month > 11) return iso
  if (!Number.isInteger(day) || day < 1 || day > 31) return iso
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ]
  const ordinal = (n: number): string => {
    if (n >= 11 && n <= 13) return `${n}th`
    const last = n % 10
    if (last === 1) return `${n}st`
    if (last === 2) return `${n}nd`
    if (last === 3) return `${n}rd`
    return `${n}th`
  }
  return `${ordinal(day)} ${months[month]}`
}

/** Small clock glyph for the retirement pill. 11×11 reads cleanly at the
 * picker row's small font size without dominating the row layout. */
function RetirementClockIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.4" />
      <path d="M8 4.6 V8 L10.2 9.4" />
    </svg>
  )
}

/**
 * One provider section in the unified catalog. The caller owns availability
 * and ordering; the picker renders the groups verbatim so every surface uses
 * the same provider order as the existing provider picker.
 */
export interface CombinedModelPickerProviderGroup {
  provider: ProviderId
  label?: string
  modelOptions: CombinedModelPickerModelOption[]
  fastModeCapableModelIds?: ReadonlySet<string>
  pauseLabel?: string
  rerouteLabel?: string
}

export interface CombinedModelPickerCustomTrigger {
  className: string
  content: ReactNode
  title: string
  ariaLabel: string
}

export interface CombinedModelPickerConfirmAction {
  label: string
  onConfirm: () => void
  disabled?: boolean
}

export function CombinedModelPickerConfirmButton({
  action,
  disabled = false,
  onConfirmed
}: {
  action: CombinedModelPickerConfirmAction
  disabled?: boolean
  onConfirmed?: () => void
}): React.JSX.Element {
  const buttonDisabled = Boolean(disabled || action.disabled)
  return (
    <PillButton
      variant="secondary"
      size="compact"
      className="composer-combined-picker-confirm"
      disabled={buttonDisabled}
      onClick={() => {
        if (buttonDisabled) return
        action.onConfirm()
        onConfirmed?.()
      }}
    >
      {action.label}
    </PillButton>
  )
}

interface CombinedModelPickerProps {
  provider: ProviderId
  composerStyle: ComposerStyle
  modelOptions: CombinedModelPickerModelOption[]
  selectedModelId: string
  onSelectModel: (modelId: string) => void
  /**
   * Ordered provider catalogs for the all-models view. Omit to retain the
   * legacy provider-scoped picker (used by compatibility/test surfaces).
   */
  providerGroups?: CombinedModelPickerProviderGroup[]
  /** Atomic cross-provider selection. Required when providerGroups is set. */
  onSelectProviderModel?: (provider: ProviderId, modelId: string) => void
  /**
   * Reasoning options for the current provider. An empty or fixed catalog
   * renders the shared disabled placeholder ladder.
   */
  reasoningOptions: CombinedModelPickerReasoningOption[]
  selectedReasoning: string
  onSelectReasoning: (value: string) => void
  /** Codex reasoning effort token (so the chip text can format it). */
  codexReasoningEffort?: string
  /** Claude reasoning effort token (so the chip text can format it). */
  claudeReasoningEffort?: string
  /** Grok reasoning effort token (so the chip text can format it). */
  grokReasoningEffort?: string
  /** Cursor Grok reasoning effort token (so the chip text can format it). */
  cursorReasoningEffort?: string
  /** Kimi thinking flag (so the chip text can format it). */
  kimiThinkingEnabled?: boolean
  /** K3 thinking effort (low/high/max). */
  kimiReasoningEffort?: string
  /**
   * Set of model IDs that support the paid Fast tier (Codex GPT-5.5
   * + GPT-5.4; Claude Opus 4.7 + Opus 4.6). Used both to (1) render a
   * lightning bolt next to capable model labels and (2) gate the
   * "Fast Mode" toggle below the Reasoning column. Pass an empty set
   * to hide the toggle row entirely (e.g. Gemini / Kimi).
   */
  fastModeCapableModelIds?: ReadonlySet<string>
  /**
   * Current fast-mode state. Renders the toggle as "on" when true.
   */
  fastModeEnabled?: boolean
  /**
   * Flip fast mode. Invoked from the toggle's onClick; the caller
   * decides which provider's state to mutate (Codex's serviceTier,
   * Claude's claudeFastMode, etc.) and is also responsible for
   * persisting to chat metadata.
   */
  onToggleFastMode?: () => void
  disabled?: boolean
  /**
   * When true, the open popover re-anchors to the trigger on scroll/resize
   * (capture). Default false keeps the composer's behaviour byte-identical
   * (the composer trigger is viewport-pinned). Settings → Roster passes true
   * because its pickers live inside a scrolling list.
   */
  repositionOnScroll?: boolean
  /** Alternate trigger chrome, used by the Ensemble add-participant `+`. */
  customTrigger?: CombinedModelPickerCustomTrigger
  /** Optional footer action for draft-based picker flows. */
  confirmAction?: CombinedModelPickerConfirmAction
  /** Optional full-width content above the existing picker columns. */
  topContent?: ReactNode
  /** Internal surface hook for a caller-specific popover layout. */
  popoverClassName?: string
  /** Accessible name override for caller-specific picker compositions. */
  dialogAriaLabel?: string
  onOpenChange?: (open: boolean) => void
  /**
   * Fires as the popover closes, carrying the row the user last
   * highlighted — by hover or by keyboard, the two share `modelHighlight`.
   *
   * Deliberately reports the highlight unconditionally rather than
   * trying to detect "closed without selecting" in here. Both a click
   * and a keyboard Enter land on the highlighted row, so a selection
   * and a dismissal look identical at this layer; the caller can tell
   * them apart for free by comparing the reported row against whatever
   * model is actually selected once the close has settled. Comparing
   * outcomes beats tracking intent, and it can't race the parent's
   * selection state the way an internal flag would.
   *
   * Note the picker re-homes `modelHighlight` onto the selected model
   * every time it opens, so opening and immediately closing reports the
   * already-selected row — which the caller reads as "no signal".
   */
  onCloseWithHighlight?: (highlighted: UnifiedModelEntry | null) => void
}

type CombinedModelPickerColumn = 'provider' | 'model' | 'reasoning'

type OllamaProviderGroup = {
  id: string
  label: string
  providerClass: string
  models: CombinedModelPickerModelOption[]
}

export type UnifiedModelEntry = {
  provider: ProviderId
  option: CombinedModelPickerModelOption
}

export function flattenUnifiedProviderModels(
  groups: readonly CombinedModelPickerProviderGroup[]
): UnifiedModelEntry[] {
  return groups.flatMap((group) =>
    group.modelOptions.map((option) => ({ provider: group.provider, option }))
  )
}

export type CombinedModelPickerResetState = {
  providerIndex: number
  activeOllamaProviderId: string | null
  modelIndex: number
  reasoningIndex: number
  focusedColumn: CombinedModelPickerColumn
}

export function getCombinedModelPickerResetSignature(params: {
  provider: ProviderId
  isOllamaProviderPicker: boolean
  selectedModelId: string
}): string {
  return `${params.provider}\u0000${params.isOllamaProviderPicker ? 'ollama' : 'standard'}\u0000${params.selectedModelId}`
}

export function resolveCombinedPickerPosition(params: {
  triggerRect: Pick<DOMRect, 'right' | 'top' | 'bottom'>
  popoverWidth: number
  popoverHeight: number
  viewportWidth: number
  viewportHeight: number
  viewportMargin?: number
  triggerGap?: number
}): { left: number; top: number } {
  const viewportMargin = params.viewportMargin ?? 8
  const triggerGap = params.triggerGap ?? 8
  const left = Math.max(
    viewportMargin,
    Math.min(
      params.triggerRect.right - params.popoverWidth,
      params.viewportWidth - params.popoverWidth - viewportMargin
    )
  )
  const topAbove = params.triggerRect.top - triggerGap - params.popoverHeight
  const topBelow = params.triggerRect.bottom + triggerGap
  const top =
    topAbove >= viewportMargin
      ? topAbove
      : topBelow + params.popoverHeight <= params.viewportHeight - viewportMargin
        ? topBelow
        : Math.max(
            viewportMargin,
            Math.min(topAbove, params.viewportHeight - params.popoverHeight - viewportMargin)
          )
  return { left, top }
}

const OLLAMA_CUSTOM_PROVIDER_GROUP = {
  id: 'custom',
  label: 'Custom',
  providerClass: 'ollama'
}

function buildOllamaProviderGroups(
  options: readonly CombinedModelPickerModelOption[]
): OllamaProviderGroup[] {
  const groups = new Map<string, OllamaProviderGroup>()
  for (const brand of OLLAMA_DISPLAY_BRANDS) {
    groups.set(brand.id, {
      id: brand.id,
      label: brand.providerLabel,
      providerClass: brand.providerClass,
      models: []
    })
  }

  for (const option of options) {
    const brand = resolveOllamaDisplayBrand(option.id, option.label)
    const groupId = brand?.providerClass || OLLAMA_CUSTOM_PROVIDER_GROUP.id
    const existing = groups.get(groupId)
    if (existing) {
      existing.models.push(option)
      continue
    }
    groups.set(groupId, {
      ...OLLAMA_CUSTOM_PROVIDER_GROUP,
      models: [option]
    })
  }

  return [...groups.values()].filter((group) => group.models.length > 0)
}

export function resolveCombinedModelPickerResetState(params: {
  isOllamaProviderPicker: boolean
  ollamaProviderGroups: readonly OllamaProviderGroup[]
  modelOptions: readonly CombinedModelPickerModelOption[]
  selectedModelId: string
  selectedOllamaProviderId: string | null
  reasoningOptions: readonly CombinedModelPickerReasoningOption[]
  selectedReasoning: string
}): CombinedModelPickerResetState {
  const providerIndex = params.isOllamaProviderPicker
    ? Math.max(
        0,
        params.ollamaProviderGroups.findIndex(
          (group) => group.id === params.selectedOllamaProviderId
        )
      )
    : 0
  const initialModelOptions = params.isOllamaProviderPicker
    ? params.ollamaProviderGroups[providerIndex]?.models || []
    : params.modelOptions
  const modelIndex = Math.max(
    0,
    initialModelOptions.findIndex((option) => option.id === params.selectedModelId)
  )
  const reasoningIndex = Math.max(
    0,
    params.reasoningOptions.findIndex((option) => option.value === params.selectedReasoning)
  )

  return {
    providerIndex,
    activeOllamaProviderId: params.ollamaProviderGroups[providerIndex]?.id || null,
    modelIndex,
    reasoningIndex,
    focusedColumn: params.isOllamaProviderPicker ? 'provider' : 'model'
  }
}

/**
 * Accent-filled bolt for non-Codex shells (Claude picker rows, etc.).
 * Codex shell uses {@link CodexFastBoltIcon} for the real monoline glyph.
 */
function FastBoltIcon({ className }: { className?: string } = {}): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 12 12"
      fill="currentColor"
      className={className}
      aria-hidden
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <path d="M7 1 2.2 6.8h2.5L3.6 11 9 4.6H6.4L7 1z" />
    </svg>
  )
}

/*
 * Reasoning ladder — a vertical 7-stop gradient slider that replaces the old
 * hierarchical reasoning row list, ported from the iOS composer's
 * `ReasoningLadder` (ios/.../TWSharedViews.swift). Bottom (index 0, Off) climbs
 * to top (index 6, Ultracode); the thumb snaps only to the stops the current
 * model actually supports. Provider synonyms (extra→xhigh, light→low) and
 * Kimi's binary thinking flag (off/on → Off/Light) map onto the same ladder.
 */
const LADDER_STOPS: ReadonlyArray<{ index: number; effort: string; label: string }> = [
  { index: 0, effort: 'off', label: 'Off' },
  { index: 1, effort: 'low', label: 'Light' },
  { index: 2, effort: 'medium', label: 'Medium' },
  { index: 3, effort: 'high', label: 'High' },
  { index: 4, effort: 'xhigh', label: 'Extra' },
  { index: 5, effort: 'max', label: 'Max' },
  { index: 6, effort: 'ultracode', label: 'Ultracode' }
]
const LADDER_MAX_INDEX = 6
// Top/bottom padding of the track's usable travel. Kept a touch above the
// thumb's half-height (15px thumb → 7.5px) so the extreme stops still leave a
// little rail showing above/below the thumb.
const LADDER_TRACK_INSET = 11

// Reasoning efforts that carry the provider-hued shimmer sweep + sparkles on
// the compact trigger chip. The ladder itself uses a separate Low→Ultra taper.
const TOP_TIER_SPARKLE_EFFORTS: ReadonlySet<string> = new Set(['max', 'ultracode'])
// Extra (xhigh) wears the same treatment at a fraction of the intensity — a
// gentler sweep (CSS, keyed off data-selected-reasoning) plus a smaller,
// dimmer sparkle field. Tiers below it are hue-only (pure CSS, no overlay).
const FAINT_SPARKLE_EFFORTS: ReadonlySet<string> = new Set(['xhigh'])
// Every-other CHIP_SPARKLES pick so the 4-dot faint field still spans the
// whole suffix (the array is ordered left→right; a plain slice(0,4) would
// cluster every dot left of 54% and read as a glitch).
const FAINT_SPARKLE_INDICES: ReadonlyArray<number> = [0, 2, 4, 6]

export type ChipSparkleTier = 'full' | 'faint' | null

/**
 * Split the formatted chip text into model / reasoning / trailing-"Fast"
 * pieces so each gets its own span (the reasoning suffix carries the tiered
 * provider-hue treatment; the Fast tail must NOT — it isn't a reasoning
 * level). Cursor (and the default shell's cursor format) appends " Fast"
 * AFTER the reasoning ("Cursor Grok 4.5 · High Fast"), which used to defeat
 * the plain endsWith split and dissolve the suffix span entirely.
 */
export function splitChipReasoningPieces(
  chipText: string,
  reasoningSuffix: string
): { primary: string; suffix: string; tail: string } {
  if (!reasoningSuffix) return { primary: chipText, suffix: '', tail: '' }
  const strip = (value: string): string => value.trimEnd().replace(/[\s·]+$/, '')
  if (chipText.endsWith(reasoningSuffix)) {
    // Trim trailing separator (`·` or space) so the suffix renders
    // as its own visual unit with its own styling.
    return {
      primary: strip(chipText.slice(0, chipText.length - reasoningSuffix.length)),
      suffix: reasoningSuffix,
      tail: ''
    }
  }
  const fastTail = `${reasoningSuffix} Fast`
  if (chipText.endsWith(fastTail)) {
    return {
      primary: strip(chipText.slice(0, chipText.length - fastTail.length)),
      suffix: reasoningSuffix,
      tail: 'Fast'
    }
  }
  return { primary: chipText, suffix: '', tail: '' }
}

/** Sparkle overlay tier for the trigger chip's reasoning suffix. Max and
 * Ultra/Ultracode keep the full field; Extra (xhigh) gets the faint one;
 * everything below (High/Medium/Low/Thinking/Off) renders no overlay — those
 * tiers are signalled by progressively stronger provider hue in CSS alone. */
export function chipReasoningSparkleTier(selectedReasoning: string): ChipSparkleTier {
  const value = selectedReasoning.trim().toLowerCase()
  if (TOP_TIER_SPARKLE_EFFORTS.has(value)) return 'full'
  if (FAINT_SPARKLE_EFFORTS.has(value)) return 'faint'
  return null
}

// Sparkle positions (within the Low→Ultra effect zone) + staggered twinkle
// delays. The first few points deliberately span the whole zone; higher effort
// reveals progressively more points between them, increasing density without
// changing the slow twinkle speed.
const LADDER_SPARKLES: ReadonlyArray<{ left: string; top: string; delay: string }> = [
  { left: '30%', top: '4%', delay: '0s' },
  { left: '66%', top: '47%', delay: '1.9s' },
  { left: '24%', top: '76%', delay: '0.6s' },
  { left: '74%', top: '18%', delay: '2.8s' },
  { left: '32%', top: '68%', delay: '1.1s' },
  { left: '62%', top: '73%', delay: '3.4s' },
  { left: '18%', top: '31%', delay: '0.4s' },
  { left: '78%', top: '78%', delay: '2.2s' },
  { left: '47%', top: '56%', delay: '1.5s' },
  { left: '55%', top: '10%', delay: '4s' },
  { left: '28%', top: '50%', delay: '0.9s' },
  { left: '58%', top: '70%', delay: '2.5s' },
  { left: '20%', top: '14%', delay: '3s' },
  { left: '72%', top: '37%', delay: '0.2s' },
  { left: '40%', top: '64%', delay: '4.3s' },
  { left: '46%', top: '27%', delay: '1.7s' }
]

// Sparkles scattered over the composer chip's "Ultra/Ultracode" suffix text.
const CHIP_SPARKLES: ReadonlyArray<{ left: string; top: string; delay: string }> = [
  { left: '8%', top: '12%', delay: '0s' },
  { left: '26%', top: '68%', delay: '1.6s' },
  { left: '40%', top: '22%', delay: '0.7s' },
  { left: '54%', top: '74%', delay: '2.6s' },
  { left: '68%', top: '28%', delay: '1.1s' },
  { left: '82%', top: '62%', delay: '3.3s' },
  { left: '93%', top: '18%', delay: '2.1s' },
  { left: '16%', top: '84%', delay: '3.8s' }
]

function normalizeLadderEffort(effort: string): string {
  const value = effort.trim().toLowerCase()
  if (value === 'extra') return 'xhigh'
  if (value === 'light') return 'low'
  return value
}

/**
 * Map a reasoning-option value onto a ladder index, or null when it doesn't
 * belong on the ladder. K2.7 Coding's fixed `on` value rides the first active
 * stop; K3's Low/High/Max values use the ordinary effort ladder.
 */
export function ladderIndexForOption(provider: ProviderId, value: string): number | null {
  if (provider === 'kimi') {
    const token = value.trim().toLowerCase()
    if (token === 'off') return 0
    if (token === 'on') return 1
  }
  const normalized = normalizeLadderEffort(value)
  const stop = LADDER_STOPS.find((entry) => entry.effort === normalized)
  return stop ? stop.index : null
}

export interface LadderModel {
  /** Enabled ladder indices, ascending. */
  enabledIndices: number[]
  enabledSet: Set<number>
  /** ladder index → the reasoning-option value that lands there. */
  valueByIndex: Record<number, string>
  /** ladder index → the provider's display label for that stop. */
  labelByIndex: Record<number, string>
  /** First disabled option's reason, surfaced as the track tooltip (mirrors the
   * old per-row `disabledReason` when reasoning is fixed for a model). */
  disabledReason?: string
}

export interface UnavailableReasoningPresentation {
  index: number
  label: string
  disabledReason: string
}

export interface ReasoningLadderAvailability {
  mutable: boolean
  unavailablePresentation?: UnavailableReasoningPresentation
}

const CURSOR_IMPLICIT_MEDIUM_MODELS = new Set(['composer-2.5', 'composer-2.5-fast'])

export function resolveReasoningLadderAvailability(
  provider: ProviderId,
  modelId: string,
  ladder: LadderModel
): ReasoningLadderAvailability {
  if (ladder.enabledIndices.length > 1) return { mutable: true }
  // A single enabled stop is the locked aesthetic (Kimi always-On, Mistral
  // Medium High, live catalogs that expose exactly one effort, …). Pin the
  // thumb + label at that stop rather than collapsing to the empty-rail dash.
  if (ladder.enabledIndices.length === 1) {
    const index = ladder.enabledIndices[0]
    const fallbackLabel =
      provider === 'kimi' ? 'On' : LADDER_STOPS[index]?.label || '—'
    const fallbackReason =
      provider === 'kimi'
        ? 'Thinking is always on and cannot be disabled for this model.'
        : 'Reasoning is fixed for this model'
    return {
      mutable: false,
      unavailablePresentation: {
        index,
        label: ladder.labelByIndex[index] || fallbackLabel,
        disabledReason: ladder.disabledReason || fallbackReason
      }
    }
  }
  const cursorImplicitMedium =
    provider === 'cursor' && CURSOR_IMPLICIT_MEDIUM_MODELS.has(modelId.trim().toLowerCase())
  return {
    mutable: false,
    unavailablePresentation: cursorImplicitMedium
      ? {
          index: 2,
          label: 'Medium',
          disabledReason: 'Cursor Composer 2.5 uses implicit Medium reasoning; it is not configurable.'
        }
      : {
          index: 0,
          label: '—',
          disabledReason: 'Reasoning is not configurable for this model.'
        }
  }
}

export interface ReasoningLadderFxProfile {
  active: boolean
  /** Linear Low→Ultra intensity ramp, 1/6 through 1. */
  strength: number
  /** More points appear as effort rises; every point keeps the same cadence. */
  sparkleCount: number
  /** Additional staggered sweeps raise shimmer density without speeding it up. */
  shimmerBandCount: number
}

/**
 * Visual treatment for a ladder stop. Off is deliberately still; every stop
 * from Low/Thinking upward participates in the provider-hued effect and ramps
 * linearly to the full Ultra treatment.
 */
export function reasoningLadderFxProfile(index: number): ReasoningLadderFxProfile {
  const clampedIndex = Math.max(0, Math.min(LADDER_MAX_INDEX, Math.round(index)))
  if (clampedIndex === 0) {
    return { active: false, strength: 0, sparkleCount: 0, shimmerBandCount: 0 }
  }
  const strength = clampedIndex / LADDER_MAX_INDEX
  return {
    active: true,
    strength,
    sparkleCount: Math.max(1, Math.round(LADDER_SPARKLES.length * strength)),
    shimmerBandCount: Math.max(1, Math.round(3 * strength))
  }
}

export function buildLadderModel(
  provider: ProviderId,
  options: readonly CombinedModelPickerReasoningOption[]
): LadderModel {
  const enabledIndices: number[] = []
  const valueByIndex: Record<number, string> = {}
  const labelByIndex: Record<number, string> = {}
  let disabledReason: string | undefined
  for (const option of options) {
    if (option.disabled) {
      if (!disabledReason && option.disabledReason) disabledReason = option.disabledReason
      continue
    }
    const index = ladderIndexForOption(provider, option.value)
    if (index == null) continue
    if (valueByIndex[index] === undefined) {
      enabledIndices.push(index)
      valueByIndex[index] = option.value
      labelByIndex[index] = option.label
      // Locked single-stop catalogs (e.g. Mistral Medium High) carry the
      // fixed-reason tooltip on the enabled option itself — keep it for the
      // inert ladder presentation.
      if (!disabledReason && option.disabledReason) disabledReason = option.disabledReason
    }
  }
  enabledIndices.sort((a, b) => a - b)
  return {
    enabledIndices,
    enabledSet: new Set(enabledIndices),
    valueByIndex,
    labelByIndex,
    disabledReason
  }
}

/** Nearest enabled stop to a raw index; ties break to the HIGHER stop (matches iOS). */
export function nearestEnabledLadderIndex(raw: number, enabled: readonly number[]): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const index of enabled) {
    // `enabled` is ascending, so `<=` lets the higher stop win an exact tie.
    const distance = Math.abs(index - raw)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

/**
 * The stop the thumb sits on: the current effort's stop when it's enabled, else
 * the nearest enabled stop (a carried-over disabled effort must never park the
 * thumb on a disabled stop), else the lowest enabled stop.
 */
export function clampedLadderIndex(
  provider: ProviderId,
  effort: string,
  ladder: LadderModel
): number {
  const raw = ladderIndexForOption(provider, effort)
  if (raw != null && ladder.enabledSet.has(raw)) return raw
  if (raw != null) {
    const nearest = nearestEnabledLadderIndex(raw, ladder.enabledIndices)
    if (nearest != null) return nearest
  }
  return ladder.enabledIndices[0] ?? 0
}

/** Bottom-offset (from the track's bottom edge) for a ladder index, 0..1 of usable. */
function ladderStopBottom(index: number): string {
  return `calc(${LADDER_TRACK_INSET}px + (100% - ${LADDER_TRACK_INSET * 2}px) * ${
    index / LADDER_MAX_INDEX
  })`
}

export function ReasoningLadderSlider({
  provider,
  modelId,
  ladder,
  selectedReasoning,
  onSelectReasoning,
  disabled,
  unavailablePresentation,
  onInteract
}: {
  provider: ProviderId
  modelId?: string
  ladder: LadderModel
  selectedReasoning: string
  onSelectReasoning: (value: string) => void
  disabled?: boolean
  unavailablePresentation?: UnavailableReasoningPresentation
  onInteract: () => void
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  // During a drag the thumb tracks the finger via LOCAL state and commits ONLY
  // on release — so a whole drag fires one onSelectReasoning (one persist + one
  // parent re-render / ensemble notice), not one per stop crossed. Keyboard/
  // click paths still commit directly.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const interactive =
    !disabled && !unavailablePresentation && ladder.enabledIndices.length > 1
  const currentIndex =
    unavailablePresentation?.index ?? clampedLadderIndex(provider, selectedReasoning, ladder)
  const displayIndex = interactive && dragIndex != null ? dragIndex : currentIndex
  const providerHueClass = modelPickerHueClass(provider, modelId)
  // A locked nonzero stop is still meaningful reasoning state (K2.7's On,
  // Mistral Medium's High, Cursor Composer's implicit Medium, or a live
  // catalog's one-value offer). Keep its provider colour field and slow FX
  // without making the slider focusable or draggable. The `—` placeholder
  // remains neutral because it has no reasoning state to represent.
  const showFixedReasoningFx = Boolean(unavailablePresentation) && currentIndex > 0
  const showReasoningFx = interactive || showFixedReasoningFx
  const currentLabel =
    unavailablePresentation?.label ??
    ladder.labelByIndex[displayIndex] ??
    LADDER_STOPS[displayIndex]?.label ??
    '—'
  // Provider hue, pulse, shimmer, and sparkles begin at Low/Thinking (index 1)
  // and taper smoothly to full intensity/density at Ultra/Ultracode (index 6).
  const fxProfile = reasoningLadderFxProfile(showReasoningFx ? displayIndex : 0)
  const fillHeight = ladderStopBottom(displayIndex)
  const fxTier = showReasoningFx
    ? displayIndex === LADDER_MAX_INDEX
      ? 'ultracode'
      : displayIndex === 5
        ? 'max'
        : null
    : null

  const indexFromClientY = (clientY: number): number | null => {
    const el = trackRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const usable = Math.max(1, rect.height - LADDER_TRACK_INSET * 2)
    const frac = Math.max(0, Math.min(1, 1 - (clientY - rect.top - LADDER_TRACK_INSET) / usable))
    return nearestEnabledLadderIndex(Math.round(frac * LADDER_MAX_INDEX), ladder.enabledIndices)
  }

  return (
    <div
      className="composer-combined-picker-ladder"
      data-disabled={interactive ? undefined : 'true'}
      onMouseEnter={interactive ? onInteract : undefined}
      // The popover's `--accent` is the generic theme accent (only shell-grok/
      // shell-cursor re-point it, to monochrome) — it is NOT the provider brand
      // hue. Bind a scoped `--ladder-accent` to the provider's `:root` brand
      // colour so the track/shimmer/sparkles emerge in that hue, falling back to
      // the theme accent for any unknown provider.
      style={
        {
          '--ladder-accent': showReasoningFx
            ? `var(--provider-${providerHueClass}-color, var(--accent))`
            : 'var(--text-secondary)'
        } as React.CSSProperties
      }
    >
      <div
        className="composer-combined-picker-ladder-value"
        data-ultracode={displayIndex === 6 ? 'true' : undefined}
        data-tier={fxTier ?? undefined}
      >
        {currentLabel}
      </div>
      <div
        ref={trackRef}
        className="composer-combined-picker-ladder-track"
        data-dragging={dragIndex !== null ? 'true' : undefined}
        data-fx-active={fxProfile.active ? 'true' : undefined}
        style={
          {
            '--ladder-fx-strength': fxProfile.strength,
            '--ladder-fill-height': fillHeight
          } as React.CSSProperties
        }
        role="slider"
        tabIndex={interactive ? 0 : -1}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={LADDER_MAX_INDEX}
        aria-valuenow={displayIndex}
        aria-valuetext={currentLabel}
        aria-disabled={interactive ? undefined : true}
        title={
          interactive
            ? undefined
            : (ladder.disabledReason ??
              unavailablePresentation?.disabledReason ??
              'Reasoning is fixed for this model')
        }
        onFocus={interactive ? onInteract : undefined}
        onPointerDown={(event) => {
          if (!interactive) return
          onInteract()
          draggingRef.current = true
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* setPointerCapture can throw on stale pointer ids; ignore. */
          }
          const idx = indexFromClientY(event.clientY)
          if (idx != null) setDragIndex(idx)
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return
          const idx = indexFromClientY(event.clientY)
          if (idx != null) setDragIndex(idx)
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return
          draggingRef.current = false
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch {
            /* releasePointerCapture can throw if capture was already lost. */
          }
          const idx = indexFromClientY(event.clientY) ?? dragIndex
          const value = idx != null ? ladder.valueByIndex[idx] : undefined
          if (value != null && value !== selectedReasoning) onSelectReasoning(value)
          setDragIndex(null)
        }}
        onPointerCancel={() => {
          draggingRef.current = false
          setDragIndex(null)
        }}
      >
        <div className="composer-combined-picker-ladder-rail" aria-hidden />
        {/* Coloured gradient fill, clipped to BELOW the thumb — the hue emerges
            as effort climbs; above the thumb stays the neutral empty rail. */}
        <div
          className="composer-combined-picker-ladder-fill"
          style={{ height: fillHeight }}
          aria-hidden
        />
        {fxProfile.active && (
          <>
            <div className="composer-combined-picker-ladder-pulse" aria-hidden />
            <div className="composer-combined-picker-ladder-shimmer" aria-hidden>
              {Array.from({ length: fxProfile.shimmerBandCount }, (_, index) => (
                <span
                  key={index}
                  className="composer-combined-picker-ladder-shimmer-band"
                  style={{
                    animationDelay: `${(-3.2 * index) / fxProfile.shimmerBandCount}s`
                  }}
                />
              ))}
            </div>
            <div className="composer-combined-picker-ladder-sparkles" aria-hidden>
              {LADDER_SPARKLES.slice(0, fxProfile.sparkleCount).map((sparkle, index) => (
                <span
                  key={index}
                  className="composer-combined-picker-ladder-sparkle"
                  style={{ left: sparkle.left, top: sparkle.top, animationDelay: sparkle.delay }}
                />
              ))}
            </div>
          </>
        )}
        <span
          className="composer-combined-picker-ladder-thumb"
          style={{ bottom: fillHeight }}
          aria-hidden
        />
      </div>
    </div>
  )
}

/** The chip's reasoning suffix ("Ultra" / "Max" / "Extra" …). The hue/shimmer
 * treatment rides CSS keyed off the trigger's data-selected-reasoning; this
 * component only adds the twinkling sparkle overlay — the full field at
 * Max/Ultra, a smaller dimmer one at Extra, none below.
 * Exported for the seat-change transcript row, which renders the SAME suffix
 * element with a CharOdometer as `children` so the tiers stay one visual. */
export function TriggerReasoningSuffix({
  text,
  sparkle,
  children
}: {
  text: string
  sparkle: ChipSparkleTier
  children?: React.ReactNode
}): React.JSX.Element {
  const sparkles =
    sparkle === 'full'
      ? CHIP_SPARKLES
      : sparkle === 'faint'
        ? FAINT_SPARKLE_INDICES.map((index) => CHIP_SPARKLES[index])
        : []
  return (
    <span className="composer-combined-picker-trigger-suffix">
      {children ?? text}
      {sparkles.length > 0 && (
        <span
          className={`composer-combined-picker-trigger-sparkles${
            sparkle === 'faint' ? ' is-faint' : ''
          }`}
          aria-hidden
        >
          {sparkles.map((s, index) => (
            <span
              key={index}
              className="composer-combined-picker-trigger-sparkle"
              style={{ left: s.left, top: s.top, animationDelay: s.delay }}
            />
          ))}
        </span>
      )}
    </span>
  )
}

export function CombinedModelPicker({
  provider,
  composerStyle,
  modelOptions,
  selectedModelId,
  onSelectModel,
  providerGroups,
  onSelectProviderModel,
  reasoningOptions,
  selectedReasoning,
  onSelectReasoning,
  codexReasoningEffort,
  claudeReasoningEffort,
  grokReasoningEffort,
  cursorReasoningEffort,
  kimiThinkingEnabled,
  kimiReasoningEffort,
  fastModeCapableModelIds,
  fastModeEnabled,
  onToggleFastMode,
  disabled,
  repositionOnScroll,
  customTrigger,
  confirmAction,
  topContent,
  popoverClassName,
  dialogAriaLabel,
  onOpenChange,
  onCloseWithHighlight
}: CombinedModelPickerProps): React.JSX.Element {
  const unifiedProviderGroups = providerGroups || []
  const isUnifiedProviderPicker = unifiedProviderGroups.length > 0
  const selectedProviderGroup = isUnifiedProviderPicker
    ? unifiedProviderGroups.find((group) => group.provider === provider)
    : undefined
  const selectedFastModeCapableModelIds =
    selectedProviderGroup?.fastModeCapableModelIds || fastModeCapableModelIds
  const fastModeCapable = Boolean(
    selectedFastModeCapableModelIds && selectedFastModeCapableModelIds.has(selectedModelId)
  )
  const fastModeRowVisible = Boolean(
    selectedFastModeCapableModelIds && selectedFastModeCapableModelIds.size > 0 && onToggleFastMode
  )
  const showReasoningSidecar = true
  const hasTopContent = Boolean(topContent)
  const ladder = useMemo(
    () => buildLadderModel(provider, reasoningOptions),
    [provider, reasoningOptions]
  )
  const reasoningAvailability = useMemo(
    () => resolveReasoningLadderAvailability(provider, selectedModelId, ladder),
    [ladder, provider, selectedModelId]
  )
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const onOpenChangeRef = useRef(onOpenChange)
  const onCloseWithHighlightRef = useRef(onCloseWithHighlight)
  const unifiedModelRowRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [focusedColumn, setFocusedColumn] = useState<CombinedModelPickerColumn>('model')
  const [providerHighlight, setProviderHighlight] = useState(0)
  const [modelHighlight, setModelHighlight] = useState(0)
  const [activeOllamaProviderId, setActiveOllamaProviderId] = useState<string | null>(null)
  const resetSignatureRef = useRef<string | null>(null)

  const unifiedModelEntries = useMemo<UnifiedModelEntry[]>(
    () => flattenUnifiedProviderModels(unifiedProviderGroups),
    [unifiedProviderGroups]
  )

  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    onCloseWithHighlightRef.current = onCloseWithHighlight
  }, [onCloseWithHighlight])

  /**
   * Snapshot of the highlighted row. Kept in a ref so the close effect
   * below doesn't need `modelHighlight` as a dep — listing it there
   * would re-run the close check on every arrow-key press.
   *
   * This effect is declared BEFORE the open/close effect on purpose:
   * effects fire in declaration order within a commit, so when a
   * highlight move and a close land together the snapshot is already
   * current by the time the close reads it.
   */
  const highlightSnapshotRef = useRef<UnifiedModelEntry | null>(null)
  useEffect(() => {
    highlightSnapshotRef.current = isUnifiedProviderPicker
      ? (unifiedModelEntries[modelHighlight] ?? null)
      : null
  }, [isUnifiedProviderPicker, unifiedModelEntries, modelHighlight])

  const wasOpenRef = useRef(false)
  useEffect(() => {
    onOpenChangeRef.current?.(open)
    // The highlight-reset effect only runs while open, so `modelHighlight`
    // still holds the last row the user was on by the time we get here.
    if (wasOpenRef.current && !open) {
      onCloseWithHighlightRef.current?.(highlightSnapshotRef.current)
    }
    wasOpenRef.current = open
  }, [open])

  useEffect(() => {
    if (!open || !isUnifiedProviderPicker || focusedColumn !== 'model') return
    const frame = window.requestAnimationFrame(() => {
      unifiedModelRowRefs.current
        .get(modelHighlight)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusedColumn, isUnifiedProviderPicker, modelHighlight, open])

  const ollamaProviderGroups = useMemo(
    () =>
      !isUnifiedProviderPicker && provider === 'ollama'
        ? buildOllamaProviderGroups(modelOptions)
        : [],
    [isUnifiedProviderPicker, modelOptions, provider]
  )
  const isOllamaProviderPicker = provider === 'ollama' && ollamaProviderGroups.length > 0

  const selectedModelOption = modelOptions.find((option) => option.id === selectedModelId) ||
    // Show the real id when it isn't in the list (e.g. a server-hydrated or
    // since-dropped model id from a saved preset) rather than silently
    // mislabeling it as the first option. Fall back to the first option only
    // when no id is set at all.
    //
    // The id is humanised, not printed raw: this branch is reached whenever the
    // option list is empty — for Pi that is simply "no upstream key configured
    // yet" — and it was rendering the bare wire id, so the trigger read
    // "Pi mistral/devstral-2512". `humaniseModelId` returns the id unchanged
    // when it knows nothing about it, so an unrecognised id is no worse off.
    (selectedModelId
      ? { id: selectedModelId, label: humaniseModelId(provider, selectedModelId) }
      : modelOptions[0]) || {
      id: selectedModelId,
      label: humaniseModelId(provider, selectedModelId)
    }

  const selectedOllamaProviderId = useMemo(() => {
    if (!isOllamaProviderPicker) return null
    return (
      ollamaProviderGroups.find((group) =>
        group.models.some((option) => option.id === selectedModelOption.id)
      )?.id ||
      ollamaProviderGroups[0]?.id ||
      null
    )
  }, [isOllamaProviderPicker, ollamaProviderGroups, selectedModelOption.id])

  const activeOllamaProviderGroup = useMemo(() => {
    if (!isOllamaProviderPicker) return null
    const activeId = activeOllamaProviderId || selectedOllamaProviderId
    return (
      ollamaProviderGroups.find((group) => group.id === activeId) || ollamaProviderGroups[0] || null
    )
  }, [
    activeOllamaProviderId,
    isOllamaProviderPicker,
    ollamaProviderGroups,
    selectedOllamaProviderId
  ])

  const visibleModelOptions = isUnifiedProviderPicker
    ? unifiedModelEntries.map((entry) => entry.option)
    : isOllamaProviderPicker && activeOllamaProviderGroup
      ? activeOllamaProviderGroup.models
      : modelOptions

  const useClaudeShellChipLayout = composerStyle === 'claude'
  const showShellFastLabel =
    (useClaudeShellChipLayout || provider === 'cursor') && fastModeEnabled && fastModeCapable
  // Fast tier active → lightning bolt left of the model label, on EVERY shell
  // (Codex/Claude/Cursor toggles). The Codex shell keeps its bespoke monoline
  // glyph; everything else uses the app's accent-filled bolt.
  const showTriggerFastBolt = Boolean(fastModeEnabled && fastModeCapable)
  const useCodexMonolineFastBolt = composerStyle === 'codex'

  const chipText = useMemo(
    () =>
      formatComposerModelChip({
        provider,
        composerStyle,
        modelId: selectedModelOption.id,
        modelLabel: selectedModelOption.label,
        codexReasoningEffort,
        claudeReasoningEffort,
        grokReasoningEffort,
        cursorReasoningEffort,
        kimiThinkingEnabled,
        kimiReasoningEffort,
        shellFastModeActive: showShellFastLabel
      }),
    [
      provider,
      composerStyle,
      selectedModelOption.id,
      selectedModelOption.label,
      codexReasoningEffort,
      claudeReasoningEffort,
      grokReasoningEffort,
      cursorReasoningEffort,
      kimiThinkingEnabled,
      kimiReasoningEffort,
      showShellFastLabel
    ]
  )

  const reasoningSuffix = useMemo(
    () =>
      reasoningDisplayLabel({
        provider,
        composerStyle,
        modelId: selectedModelOption.id,
        modelLabel: selectedModelOption.label,
        codexReasoningEffort,
        claudeReasoningEffort,
        grokReasoningEffort,
        cursorReasoningEffort,
        kimiThinkingEnabled,
        kimiReasoningEffort
      }),
    [
      provider,
      composerStyle,
      selectedModelOption.id,
      selectedModelOption.label,
      codexReasoningEffort,
      claudeReasoningEffort,
      grokReasoningEffort,
      cursorReasoningEffort,
      kimiThinkingEnabled,
      kimiReasoningEffort
    ]
  )

  // Split chip text into "model" and "reasoning" pieces so we can
  // style them differently (model normal, reasoning muted/dimmed —
  // mirrors real Codex's `5.5 Extra High` rendering where "Extra
  // High" reads softer than "5.5").
  const chipPieces = useMemo(
    () => splitChipReasoningPieces(chipText, reasoningSuffix),
    [chipText, reasoningSuffix]
  )

  const claudeChipSegments = useMemo(() => {
    if (!useClaudeShellChipLayout) return null
    return {
      model: resolveClaudeShellModelLabel(
        provider,
        selectedModelOption.label,
        selectedModelOption.id,
        Boolean(showShellFastLabel)
      ),
      fast: showShellFastLabel ? 'Fast' : '',
      reasoning: reasoningSuffix
    }
  }, [
    useClaudeShellChipLayout,
    provider,
    selectedModelOption.id,
    selectedModelOption.label,
    showShellFastLabel,
    reasoningSuffix
  ])
  const providerDisplayLabel =
    resolveProviderBrandLabel(provider, selectedModelOption.id) ||
    selectedProviderGroup?.label ||
    getProviderName(provider)
  const providerHueClass = modelPickerHueClass(
    provider,
    selectedModelOption.id,
    selectedModelOption.label
  )

  // Position the popover above-right of the chip when opened.
  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const popoverWidth = hasTopContent
        ? 520
        : isUnifiedProviderPicker
          ? 420
          : isOllamaProviderPicker
            ? 500
            : showReasoningSidecar
              ? 360
              : 200
      const measuredPopover = popoverRef.current?.getBoundingClientRect()
      const effectiveWidth = measuredPopover?.width || popoverWidth
      const effectiveHeight =
        measuredPopover?.height ||
        Math.min(hasTopContent ? 570 : 322, Math.max(1, window.innerHeight - 16))
      setPosition(
        resolveCombinedPickerPosition({
          triggerRect: rect,
          popoverWidth: effectiveWidth,
          popoverHeight: effectiveHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        })
      )
    }
    let cancelled = false
    let remeasureFrame: number | null = null
    queueMicrotask(() => {
      if (cancelled) return
      computePosition()
      remeasureFrame = window.requestAnimationFrame(() => {
        if (!cancelled) computePosition()
      })
    })
    if (!repositionOnScroll) {
      return () => {
        cancelled = true
        if (remeasureFrame != null) window.cancelAnimationFrame(remeasureFrame)
      }
    }
    // Re-anchor to the trigger while the user scrolls the surrounding list.
    window.addEventListener('scroll', computePosition, true)
    window.addEventListener('resize', computePosition)
    return () => {
      cancelled = true
      if (remeasureFrame != null) window.cancelAnimationFrame(remeasureFrame)
      window.removeEventListener('scroll', computePosition, true)
      window.removeEventListener('resize', computePosition)
    }
  }, [
    isOllamaProviderPicker,
    isUnifiedProviderPicker,
    hasTopContent,
    open,
    showReasoningSidecar,
    repositionOnScroll
  ])

  // Reset model/provider highlights only when the popover opens or the committed
  // model/provider selection changes. Parent catalog refreshes recreate
  // modelOptions/ollamaProviderGroups while the picker is open; those updates
  // must not snap Ollama browsing back to the selected model's provider.
  useEffect(() => {
    if (!open) {
      resetSignatureRef.current = null
      return
    }
    const resetSignature = getCombinedModelPickerResetSignature({
      provider,
      isOllamaProviderPicker,
      selectedModelId
    })
    if (resetSignatureRef.current === resetSignature) return
    resetSignatureRef.current = resetSignature
    const resetState = isUnifiedProviderPicker
      ? {
          providerIndex: 0,
          activeOllamaProviderId: null,
          modelIndex: Math.max(
            0,
            unifiedModelEntries.findIndex(
              (entry) => entry.provider === provider && entry.option.id === selectedModelId
            )
          ),
          reasoningIndex: 0,
          focusedColumn: 'model' as CombinedModelPickerColumn
        }
      : resolveCombinedModelPickerResetState({
          isOllamaProviderPicker,
          ollamaProviderGroups,
          modelOptions,
          selectedModelId,
          selectedOllamaProviderId,
          reasoningOptions,
          selectedReasoning
        })
    const frame = window.requestAnimationFrame(() => {
      setProviderHighlight(resetState.providerIndex)
      setActiveOllamaProviderId(resetState.activeOllamaProviderId)
      setModelHighlight(resetState.modelIndex)
      setFocusedColumn(resetState.focusedColumn)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    isOllamaProviderPicker,
    isUnifiedProviderPicker,
    modelOptions,
    ollamaProviderGroups,
    open,
    selectedModelId,
    selectedOllamaProviderId,
    reasoningOptions,
    selectedReasoning,
    unifiedModelEntries,
    provider
  ])

  // Click-outside + Escape dismiss.
  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.composer-textarea-context-menu')) {
        return
      }
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [open])

  // Arrow navigation when popover is open.
  useEffect(() => {
    if (!open) return
    const handleArrowKey = (event: KeyboardEvent) => {
      const target = event.target
      const targetInsidePopover =
        target instanceof Node && Boolean(popoverRef.current?.contains(target))
      if (target !== triggerRef.current && !targetInsidePopover) return
      if (
        target instanceof Element &&
        targetInsidePopover &&
        target.closest('button, input, select, textarea, [contenteditable="true"]')
      ) {
        // Once focus has moved into an interactive child, let its native
        // keyboard behavior win. This covers the Add-participant detail fields
        // as well as the existing confirm and Fast buttons.
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (focusedColumn === 'provider') {
          setProviderHighlight((idx) => Math.min(ollamaProviderGroups.length - 1, idx + 1))
        } else if (focusedColumn === 'model') {
          setModelHighlight((idx) => Math.min(Math.max(0, visibleModelOptions.length - 1), idx + 1))
        } else {
          // Reasoning ladder: down = lower effort. The slider commits on move.
          const enabled = ladder.enabledIndices
          if (reasoningAvailability.mutable && !disabled) {
            const pos = enabled.indexOf(clampedLadderIndex(provider, selectedReasoning, ladder))
            const value = ladder.valueByIndex[enabled[Math.max(0, pos - 1)]]
            if (value) onSelectReasoning(value)
          }
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (focusedColumn === 'provider') {
          setProviderHighlight((idx) => Math.max(0, idx - 1))
        } else if (focusedColumn === 'model') {
          setModelHighlight((idx) => Math.max(0, idx - 1))
        } else {
          // Reasoning ladder: up = higher effort.
          const enabled = ladder.enabledIndices
          if (reasoningAvailability.mutable && !disabled) {
            const cur = enabled.indexOf(clampedLadderIndex(provider, selectedReasoning, ladder))
            const pos = cur < 0 ? 0 : cur
            const value = ladder.valueByIndex[enabled[Math.min(enabled.length - 1, pos + 1)]]
            if (value) onSelectReasoning(value)
          }
        }
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (focusedColumn === 'provider') {
          setFocusedColumn('model')
        } else if (focusedColumn === 'model' && reasoningAvailability.mutable) {
          setFocusedColumn('reasoning')
        }
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (focusedColumn === 'reasoning') {
          setFocusedColumn('model')
        } else if (focusedColumn === 'model' && isOllamaProviderPicker) {
          setFocusedColumn('provider')
        }
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (disabled) return
        if (focusedColumn === 'provider') {
          const option = ollamaProviderGroups[providerHighlight]
          if (option) {
            setActiveOllamaProviderId(option.id)
            setModelHighlight(0)
            setFocusedColumn('model')
          }
        } else if (focusedColumn === 'model') {
          const unifiedEntry = isUnifiedProviderPicker ? unifiedModelEntries[modelHighlight] : null
          const option = unifiedEntry?.option || visibleModelOptions[modelHighlight]
          if (option && !option.disabled) {
            if (unifiedEntry) {
              onSelectProviderModel?.(unifiedEntry.provider, option.id)
            } else {
              onSelectModel(option.id)
            }
          }
        } else {
          if (!reasoningAvailability.mutable) return
          // Reasoning ladder: Enter confirms exactly what the thumb shows (the
          // clamped stop), never a stale row index. Up/Down/drag already commit
          // on every move, so this is effectively a no-op re-commit.
          const value = ladder.valueByIndex[clampedLadderIndex(provider, selectedReasoning, ladder)]
          if (value) onSelectReasoning(value)
        }
      }
    }
    document.addEventListener('keydown', handleArrowKey, true)
    return () => {
      document.removeEventListener('keydown', handleArrowKey, true)
    }
  }, [
    open,
    focusedColumn,
    isOllamaProviderPicker,
    isUnifiedProviderPicker,
    ollamaProviderGroups,
    reasoningOptions,
    reasoningAvailability,
    showReasoningSidecar,
    modelHighlight,
    providerHighlight,
    onSelectModel,
    onSelectProviderModel,
    onSelectReasoning,
    visibleModelOptions,
    disabled,
    ladder,
    provider,
    selectedReasoning,
    unifiedModelEntries
  ])

  const popoverContent = open && position && (
    <div
      ref={popoverRef}
      className={`composer-combined-picker-popover provider-${provider} shell-${composerStyle} ${
        isOllamaProviderPicker ? 'is-ollama-model-picker' : ''
      } ${isUnifiedProviderPicker ? 'is-unified-provider-picker' : ''} ${
        hasTopContent ? 'has-top-content' : ''
      } ${popoverClassName || ''}`}
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`
      }}
      role="dialog"
      aria-label={dialogAriaLabel || 'Choose provider, model, reasoning level, and speed'}
    >
      {hasTopContent && (
        <div className="composer-combined-picker-top-content">{topContent}</div>
      )}
      {isOllamaProviderPicker && (
        <div
          className={`composer-combined-picker-column composer-combined-picker-providers ${focusedColumn === 'provider' ? 'is-focused' : ''}`}
        >
          <div className="composer-combined-picker-column-header">Provider</div>
          {ollamaProviderGroups.map((group, idx) => {
            const active = group.id === activeOllamaProviderGroup?.id
            return (
              <button
                key={group.id}
                type="button"
                className={`composer-combined-picker-row composer-combined-picker-provider-row ${active ? 'is-selected' : ''} ${idx === providerHighlight && focusedColumn === 'provider' ? 'is-highlighted' : ''}`}
                data-ollama-provider-class={group.providerClass}
                data-provider-hue={group.providerClass}
                style={{
                  '--model-row-accent': `var(--provider-${group.providerClass}-color, var(--accent))`
                } as React.CSSProperties}
                disabled={disabled}
                onMouseEnter={() => {
                  setFocusedColumn('provider')
                  setProviderHighlight(idx)
                }}
                onClick={() => {
                  if (disabled) return
                  setActiveOllamaProviderId(group.id)
                  setProviderHighlight(idx)
                  setModelHighlight(0)
                  setFocusedColumn('model')
                }}
              >
                <span className="composer-combined-picker-row-label">
                  <span className="composer-combined-picker-provider-swatch" aria-hidden />
                  <span>{group.label}</span>
                </span>
                <span className="composer-combined-picker-provider-count">
                  {group.models.length}
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div
        className={`composer-combined-picker-column composer-combined-picker-models ${
          isUnifiedProviderPicker ? 'is-unified-model-list' : ''
        } ${focusedColumn === 'model' ? 'is-focused' : ''}`}
      >
        {!isUnifiedProviderPicker && (
          <div className="composer-combined-picker-column-header">Model</div>
        )}
        {isUnifiedProviderPicker ? (
          unifiedProviderGroups.map((group, groupIndex) => {
            const modelOffset = unifiedProviderGroups
              .slice(0, groupIndex)
              .reduce((count, item) => count + item.modelOptions.length, 0)
            const groupSelected = group.provider === provider
            return (
              <section
                key={group.provider}
                className={`composer-combined-picker-provider-group ${
                  groupSelected ? 'is-current' : ''
                }`}
                data-provider={group.provider}
                style={
                  {
                    '--model-provider-accent': `var(--provider-${group.provider}-color, var(--accent))`
                  } as React.CSSProperties
                }
              >
                <div className="composer-combined-picker-provider-header">
                  <span className="composer-combined-picker-provider-header-icon" aria-hidden>
                    <ProviderBrandLogoIcon provider={group.provider} />
                  </span>
                  <span className="composer-combined-picker-provider-header-label">
                    {group.label || getProviderName(group.provider)}
                  </span>
                  {group.pauseLabel && (
                    <span
                      className="composer-provider-paused-pill"
                      title={[group.pauseLabel, group.rerouteLabel].filter(Boolean).join('\n')}
                    >
                      Paused
                    </span>
                  )}
                </div>
                {group.modelOptions.length === 0 && (
                  <div className="composer-combined-picker-empty-provider">
                    {emptyProviderModelsLabel(group.provider)}
                  </div>
                )}
                {group.modelOptions.map((option, optionIndex) => {
                  const rowIndex = modelOffset + optionIndex
                  const selected = group.provider === provider && option.id === selectedModelId
                  const supportsFast = Boolean(group.fastModeCapableModelIds?.has(option.id))
                  const rowHueClass = modelPickerHueClass(
                    group.provider,
                    option.id,
                    option.label
                  )
                  // Grouped view spans providers, so the lane is decided by THIS
                  // row's provider — not the picker's currently selected one.
                  const requiresApiKey = modelRequiresApiKey(group.provider, option.id)
                  return (
                    <button
                      ref={(node) => {
                        if (node) unifiedModelRowRefs.current.set(rowIndex, node)
                        else unifiedModelRowRefs.current.delete(rowIndex)
                      }}
                      key={`${group.provider}:${option.id}`}
                      type="button"
                      className={`composer-combined-picker-row ${
                        selected ? 'is-selected' : ''
                      } ${option.disabled ? 'is-disabled' : ''} ${
                        rowIndex === modelHighlight && focusedColumn === 'model'
                          ? 'is-highlighted'
                          : ''
                      }`}
                      data-provider-model={`${group.provider}:${option.id}`}
                      data-provider-hue={rowHueClass}
                      style={modelPickerAccentStyle(group.provider, option.id, option.label)}
                      disabled={Boolean(disabled || option.disabled)}
                      aria-pressed={selected}
                      title={option.disabled ? option.disabledReason || 'Unavailable' : undefined}
                      onMouseEnter={() => {
                        setFocusedColumn('model')
                        setModelHighlight(rowIndex)
                      }}
                      onClick={() => {
                        if (disabled || option.disabled) return
                        onSelectProviderModel?.(group.provider, option.id)
                      }}
                    >
                      <span className="composer-combined-picker-row-label">{option.label}</span>
                      {option.retiresAt && (
                        <span
                          className="composer-combined-picker-retirement-pill"
                          title={`Retiring ${formatRetirementLabel(option.retiresAt)}`}
                          aria-label={`Retiring ${formatRetirementLabel(option.retiresAt)}`}
                        >
                          <RetirementClockIcon />
                          <span className="composer-combined-picker-retirement-date">
                            {formatRetirementLabel(option.retiresAt)}
                          </span>
                        </span>
                      )}
                      {supportsFast && (
                        <span
                          className="composer-combined-picker-fast-indicator"
                          title="Supports Fast mode"
                          aria-label="Supports Fast mode"
                        >
                          {useCodexMonolineFastBolt ? (
                            <CodexFastBoltIcon className="codex-fast-bolt-icon" />
                          ) : (
                            <FastBoltIcon />
                          )}
                        </span>
                      )}
                      {requiresApiKey && <ModelApiKeyIndicator />}
                      {selected && (
                        <span className="composer-combined-picker-check" aria-hidden>
                          ✓
                        </span>
                      )}
                    </button>
                  )
                })}
              </section>
            )
          })
        ) : (
          <>
            {visibleModelOptions.length === 0 && (
              <div
                className="composer-combined-picker-row"
                style={{
                  cursor: 'default',
                  color: 'var(--text-tertiary)',
                  fontStyle: 'italic'
                }}
              >
                <span className="composer-combined-picker-row-label">
                  {emptyProviderModelsLabel(provider)}
                </span>
              </div>
            )}
            {visibleModelOptions.map((option, idx) => {
              const supportsFast = Boolean(
                fastModeCapableModelIds && fastModeCapableModelIds.has(option.id)
              )
              // Single-provider view: every row belongs to the picker's provider.
              const requiresApiKey = modelRequiresApiKey(provider, option.id)
              const rowHueClass = modelPickerHueClass(provider, option.id, option.label)
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`composer-combined-picker-row ${
                    option.id === selectedModelId ? 'is-selected' : ''
                  } ${option.disabled ? 'is-disabled' : ''} ${
                    idx === modelHighlight && focusedColumn === 'model' ? 'is-highlighted' : ''
                  }`}
                  data-provider-hue={rowHueClass}
                  style={modelPickerAccentStyle(provider, option.id, option.label)}
                  disabled={Boolean(disabled || option.disabled)}
                  aria-pressed={option.id === selectedModelId}
                  title={option.disabled ? option.disabledReason || 'Unavailable' : undefined}
                  onMouseEnter={() => {
                    setFocusedColumn('model')
                    setModelHighlight(idx)
                  }}
                  onClick={() => {
                    if (disabled || option.disabled) return
                    onSelectModel(option.id)
                    if (isOllamaProviderPicker) {
                      const parentGroup = ollamaProviderGroups.find((group) =>
                        group.models.some((model) => model.id === option.id)
                      )
                      if (parentGroup) setActiveOllamaProviderId(parentGroup.id)
                    }
                  }}
                >
                  <span className="composer-combined-picker-row-label">{option.label}</span>
                  {option.retiresAt && (
                    <span
                      className="composer-combined-picker-retirement-pill"
                      title={`Retiring ${formatRetirementLabel(option.retiresAt)}`}
                      aria-label={`Retiring ${formatRetirementLabel(option.retiresAt)}`}
                    >
                      <RetirementClockIcon />
                      <span className="composer-combined-picker-retirement-date">
                        {formatRetirementLabel(option.retiresAt)}
                      </span>
                    </span>
                  )}
                  {supportsFast && (
                    <span
                      className="composer-combined-picker-fast-indicator"
                      title="Supports Fast mode"
                      aria-label="Supports Fast mode"
                    >
                      {useCodexMonolineFastBolt ? (
                        <CodexFastBoltIcon className="codex-fast-bolt-icon" />
                      ) : (
                        <FastBoltIcon />
                      )}
                    </span>
                  )}
                  {requiresApiKey && <ModelApiKeyIndicator />}
                  {option.id === selectedModelId && (
                    <span className="composer-combined-picker-check" aria-hidden>
                      ✓
                    </span>
                  )}
                </button>
              )
            })}
          </>
        )}
      </div>
      {showReasoningSidecar && (
        <div
          className={`composer-combined-picker-column composer-combined-picker-reasoning ${focusedColumn === 'reasoning' ? 'is-focused' : ''}`}
        >
          <div className="composer-combined-picker-column-header">Reasoning</div>
          <ReasoningLadderSlider
            provider={provider}
            modelId={selectedModelOption.id}
            ladder={ladder}
            selectedReasoning={selectedReasoning}
            onSelectReasoning={onSelectReasoning}
            disabled={Boolean(disabled || !reasoningAvailability.mutable)}
            unavailablePresentation={reasoningAvailability.unavailablePresentation}
            onInteract={() => setFocusedColumn('reasoning')}
          />
          {/*
            Fast Mode toggle. Tucked under the Reasoning column so
            it reads as a Reasoning-adjacent capability rather than
            a separate concept. Visible for providers with capable
            models; the row stays
            visible but disabled when the selected model isn't
            in `fastModeCapableModelIds` so the user understands
            the affordance exists but doesn't apply to this model.
          */}
          {fastModeRowVisible && (
            <button
              type="button"
              className={`composer-combined-picker-row composer-combined-picker-fast-toggle ${fastModeEnabled ? 'is-selected' : ''}`}
              style={modelPickerAccentStyle(
                provider,
                selectedModelOption.id,
                selectedModelOption.label
              )}
              onClick={() => {
                if (disabled || !fastModeCapable) return
                onToggleFastMode?.()
              }}
              disabled={Boolean(disabled || !fastModeCapable)}
              aria-pressed={Boolean(fastModeEnabled && fastModeCapable)}
              title={
                fastModeCapable
                  ? fastModeEnabled
                    ? 'Disable Fast mode (uses standard tier)'
                    : 'Enable Fast mode (paid Fast tier)'
                  : 'Selected model does not support Fast mode'
              }
            >
              <span className="composer-combined-picker-row-label">
                {useCodexMonolineFastBolt ? (
                  <CodexFastBoltIcon className="codex-fast-bolt-icon" />
                ) : (
                  <FastBoltIcon />
                )}
                <span>Fast</span>
              </span>
              <span
                className={`composer-combined-picker-fast-switch ${fastModeEnabled && fastModeCapable ? 'is-on' : ''}`}
                aria-hidden
              >
                <span className="composer-combined-picker-fast-switch-thumb" />
              </span>
            </button>
          )}
          {confirmAction && (
            <CombinedModelPickerConfirmButton
              action={confirmAction}
              disabled={disabled}
              onConfirmed={() => setOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={customTrigger?.className || 'composer-combined-picker-trigger'}
        data-composer-control={customTrigger ? undefined : 'model'}
        data-provider={provider}
        data-provider-hue={providerHueClass}
        data-selected-reasoning={selectedReasoning || ''}
        data-fast-mode-active={fastModeEnabled && fastModeCapable ? 'true' : 'false'}
        // Provider brand hue for the Ultra/Ultracode shimmer + sparkles (the
        // popover's --accent is generic — see the ladder's --ladder-accent).
        style={
          {
            '--chip-accent': `var(--provider-${providerHueClass}-color, var(--accent))`
          } as React.CSSProperties
        }
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={customTrigger?.ariaLabel || 'Provider, model, reasoning, and speed'}
        title={customTrigger?.title || 'Provider, model, reasoning, and speed'}
      >
        {customTrigger ? (
          customTrigger.content
        ) : (
          <>
            {showTriggerFastBolt &&
              (useCodexMonolineFastBolt ? (
                <CodexFastBoltIcon className="composer-combined-picker-trigger-fast-bolt" />
              ) : (
                <FastBoltIcon className="composer-combined-picker-trigger-fast-bolt" />
              ))}
            <span className="composer-combined-picker-trigger-provider">
              <span className="composer-combined-picker-trigger-provider-icon" aria-hidden>
                <ProviderBrandLogoIcon provider={provider} accentProvider={providerHueClass} />
              </span>
              <span className="composer-combined-picker-trigger-provider-label">
                {providerDisplayLabel}
              </span>
              {selectedProviderGroup?.pauseLabel && (
                <span
                  className="composer-provider-button-paused"
                  title={selectedProviderGroup.pauseLabel}
                >
                  Paused
                </span>
              )}
            </span>
            {claudeChipSegments ? (
              <>
                <span className="composer-combined-picker-trigger-primary">
                  {claudeChipSegments.model}
                </span>
                {claudeChipSegments.fast ? (
                  <span className="composer-combined-picker-trigger-tail">
                    {/* No dot glyph — a couple of non-breaking spaces stand in as
                    the model/reasoning gap (nbsp so it survives whitespace
                    collapsing). */}
                    <span className="composer-combined-picker-trigger-separator" aria-hidden>
                      {'  '}
                    </span>
                    <span className="composer-combined-picker-trigger-fast-reasoning">
                      <span className="composer-combined-picker-trigger-fast">
                        {claudeChipSegments.fast}
                      </span>
                      {claudeChipSegments.reasoning && (
                        <TriggerReasoningSuffix
                          text={claudeChipSegments.reasoning}
                          sparkle={chipReasoningSparkleTier(selectedReasoning || '')}
                        />
                      )}
                    </span>
                  </span>
                ) : claudeChipSegments.reasoning ? (
                  <span className="composer-combined-picker-trigger-tail">
                    <span className="composer-combined-picker-trigger-separator" aria-hidden>
                      {'  '}
                    </span>
                    <TriggerReasoningSuffix
                      text={claudeChipSegments.reasoning}
                      sparkle={chipReasoningSparkleTier(selectedReasoning || '')}
                    />
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <span className="composer-combined-picker-trigger-primary">
                  {chipPieces.primary}
                </span>
                {chipPieces.suffix && (
                  <TriggerReasoningSuffix
                    text={chipPieces.suffix}
                    sparkle={chipReasoningSparkleTier(selectedReasoning || '')}
                  />
                )}
                {chipPieces.tail && (
                  <span
                    className="composer-combined-picker-trigger-fast"
                    style={provider === 'cursor' ? { marginLeft: 0 } : undefined}
                  >
                    {chipPieces.tail}
                  </span>
                )}
              </>
            )}
          </>
        )}
      </button>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
