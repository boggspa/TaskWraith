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

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderId, ComposerStyle } from '../../../main/store/types'
import {
  formatComposerModelChip,
  reasoningDisplayLabel,
  resolveClaudeShellModelLabel
} from '../lib/composerChipFormat'
import { OLLAMA_DISPLAY_BRANDS, resolveOllamaDisplayBrand } from '../lib/ollamaDisplayBrand'
import { CodexFastBoltIcon } from './icons/CodexFastBoltIcon'

export interface CombinedModelPickerModelOption {
  id: string
  label: string
  disabled?: boolean
  disabledReason?: string
  /** 1.0.7-mini — ISO date (YYYY-MM-DD) when the provider is retiring this
   * model. When present, the picker row renders a small clock + ordinal-
   * date pill in red to flag the deprecation without baking it into the
   * label string (which previously flashed on first paint then resolved
   * away via modelDisplayName, and wasn't machine-readable). Optional;
   * non-retiring models pass undefined. */
  retiresAt?: string
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

export interface CombinedModelPickerReasoningOption {
  /** Internal token (e.g. 'low' | 'medium' | 'high' | 'xhigh' | 'off'). */
  value: string
  /** Human-readable label as it should appear in the popover row. */
  label: string
  disabled?: boolean
  disabledReason?: string
}

interface CombinedModelPickerProps {
  provider: ProviderId
  composerStyle: ComposerStyle
  modelOptions: CombinedModelPickerModelOption[]
  selectedModelId: string
  onSelectModel: (modelId: string) => void
  /**
   * Reasoning options for the current provider. Pass an empty array
   * to hide the reasoning column entirely (e.g. Gemini today).
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
  /**
   * Set of model IDs that support the paid Fast tier (Codex GPT-5.5
   * + GPT-5.4; Claude Opus 4.7 + Opus 4.6). Used both to (1) render a
   * lightning bolt next to capable model labels and (2) gate the
   * "Fast Mode" toggle below the Reasoning column. Pass an empty set
   * to hide the toggle row entirely (e.g. Gemini / Kimi).
   */
  fastModeCapableModelIds?: Set<string>
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
}

type CombinedModelPickerColumn = 'provider' | 'model' | 'reasoning'

type OllamaProviderGroup = {
  id: string
  label: string
  providerClass: string
  models: CombinedModelPickerModelOption[]
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
function FastBoltIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 12 12"
      fill="currentColor"
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

// Sparkle positions (within the top sparkle layer) + staggered twinkle delays.
// Dense + top-heavy; the layer's mask fades them out toward the middle.
const LADDER_SPARKLES: ReadonlyArray<{ left: string; top: string; delay: string }> = [
  { left: '30%', top: '4%', delay: '0s' },
  { left: '64%', top: '8%', delay: '0.6s' },
  { left: '18%', top: '12%', delay: '1.9s' },
  { left: '48%', top: '15%', delay: '1.1s' },
  { left: '78%', top: '19%', delay: '2.8s' },
  { left: '34%', top: '23%', delay: '0.4s' },
  { left: '60%', top: '27%', delay: '2.2s' },
  { left: '22%', top: '31%', delay: '1.5s' },
  { left: '72%', top: '35%', delay: '3.4s' },
  { left: '44%', top: '39%', delay: '0.9s' },
  { left: '30%', top: '44%', delay: '4s' },
  { left: '64%', top: '48%', delay: '2.5s' },
  { left: '48%', top: '54%', delay: '3s' },
  { left: '24%', top: '60%', delay: '0.2s' },
  { left: '70%', top: '64%', delay: '4.3s' },
  { left: '44%', top: '72%', delay: '1.7s' }
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
 * belong on the ladder. Kimi has no reasoning axis, so its off/on thinking flag
 * rides the bottom two stops (Off / Light) — mirroring the iOS ladder's
 * synthetic Kimi binding.
 */
export function ladderIndexForOption(provider: ProviderId, value: string): number | null {
  if (provider === 'kimi') {
    const token = value.trim().toLowerCase()
    if (token === 'off') return 0
    if (token === 'on') return 1
    return null
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

function ReasoningLadderSlider({
  provider,
  ladder,
  selectedReasoning,
  onSelectReasoning,
  disabled,
  onInteract
}: {
  provider: ProviderId
  ladder: LadderModel
  selectedReasoning: string
  onSelectReasoning: (value: string) => void
  disabled?: boolean
  onInteract: () => void
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  // During a drag the thumb tracks the finger via LOCAL state and commits ONLY
  // on release — so a whole drag fires one onSelectReasoning (one persist + one
  // parent re-render / ensemble notice), not one per stop crossed. Keyboard/
  // click paths still commit directly.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const currentIndex = clampedLadderIndex(provider, selectedReasoning, ladder)
  const displayIndex = dragIndex ?? currentIndex
  const currentLabel = ladder.labelByIndex[displayIndex] ?? '—'
  // Shimmer + sparkles only ignite once the thumb reaches the top (Ultra/
  // Ultracode) — they emerge with effort, like the coloured fill below.
  const atUltracode = displayIndex === LADDER_MAX_INDEX
  const interactive = !disabled && ladder.enabledIndices.length > 0

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
      onMouseEnter={onInteract}
      // The popover's `--accent` is the generic theme accent (only shell-grok/
      // shell-cursor re-point it, to monochrome) — it is NOT the provider brand
      // hue. Bind a scoped `--ladder-accent` to the provider's `:root` brand
      // colour so the track/shimmer/sparkles emerge in that hue, falling back to
      // the theme accent for any unknown provider.
      style={
        {
          '--ladder-accent': `var(--provider-${provider}-color, var(--accent))`
        } as React.CSSProperties
      }
    >
      <div
        className="composer-combined-picker-ladder-value"
        data-ultracode={displayIndex === 6 ? 'true' : undefined}
      >
        {currentLabel}
      </div>
      <div
        ref={trackRef}
        className="composer-combined-picker-ladder-track"
        data-dragging={dragIndex !== null ? 'true' : undefined}
        role="slider"
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={LADDER_MAX_INDEX}
        aria-valuenow={displayIndex}
        aria-valuetext={currentLabel}
        aria-disabled={interactive ? undefined : true}
        title={
          interactive ? undefined : ladder.disabledReason ?? 'Reasoning is fixed for this model'
        }
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
          style={{ height: ladderStopBottom(displayIndex) }}
          aria-hidden
        />
        {atUltracode && (
          <>
            <div className="composer-combined-picker-ladder-shimmer" aria-hidden />
            <div className="composer-combined-picker-ladder-sparkles" aria-hidden>
              {LADDER_SPARKLES.map((sparkle, index) => (
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
          style={{ bottom: ladderStopBottom(displayIndex) }}
          aria-hidden
        />
      </div>
    </div>
  )
}

/** The chip's reasoning suffix ("Ultra" / "Ultracode" …). At the Ultracode tier
 * it carries the provider-hued shimmer sweep (CSS, keyed off the trigger's
 * data-selected-reasoning) plus a twinkling sparkle overlay. */
function TriggerReasoningSuffix({
  text,
  sparkle
}: {
  text: string
  sparkle: boolean
}): React.JSX.Element {
  return (
    <span className="composer-combined-picker-trigger-suffix">
      {text}
      {sparkle && (
        <span className="composer-combined-picker-trigger-sparkles" aria-hidden>
          {CHIP_SPARKLES.map((s, index) => (
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
  reasoningOptions,
  selectedReasoning,
  onSelectReasoning,
  codexReasoningEffort,
  claudeReasoningEffort,
  grokReasoningEffort,
  cursorReasoningEffort,
  kimiThinkingEnabled,
  fastModeCapableModelIds,
  fastModeEnabled,
  onToggleFastMode,
  disabled,
  repositionOnScroll
}: CombinedModelPickerProps): React.JSX.Element {
  const fastModeCapable = Boolean(
    fastModeCapableModelIds && fastModeCapableModelIds.has(selectedModelId)
  )
  const fastModeRowVisible = Boolean(
    fastModeCapableModelIds && fastModeCapableModelIds.size > 0 && onToggleFastMode
  )
  const ladder = useMemo(
    () => buildLadderModel(provider, reasoningOptions),
    [provider, reasoningOptions]
  )
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [focusedColumn, setFocusedColumn] = useState<CombinedModelPickerColumn>('model')
  const [providerHighlight, setProviderHighlight] = useState(0)
  const [modelHighlight, setModelHighlight] = useState(0)
  const [activeOllamaProviderId, setActiveOllamaProviderId] = useState<string | null>(null)
  const resetSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  const ollamaProviderGroups = useMemo(
    () => (provider === 'ollama' ? buildOllamaProviderGroups(modelOptions) : []),
    [modelOptions, provider]
  )
  const isOllamaProviderPicker = provider === 'ollama' && ollamaProviderGroups.length > 0

  const selectedModelOption = modelOptions.find((option) => option.id === selectedModelId) ||
    // Show the real id when it isn't in the list (e.g. a server-hydrated or
    // since-dropped model id from a saved preset) rather than silently
    // mislabeling it as the first option. Fall back to the first option only
    // when no id is set at all.
    (selectedModelId ? { id: selectedModelId, label: selectedModelId } : modelOptions[0]) || {
      id: selectedModelId,
      label: selectedModelId
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
      ollamaProviderGroups.find((group) => group.id === activeId) ||
      ollamaProviderGroups[0] ||
      null
    )
  }, [
    activeOllamaProviderId,
    isOllamaProviderPicker,
    ollamaProviderGroups,
    selectedOllamaProviderId
  ])

  const visibleModelOptions =
    isOllamaProviderPicker && activeOllamaProviderGroup
      ? activeOllamaProviderGroup.models
      : modelOptions

  const useClaudeShellChipLayout = composerStyle === 'claude'
  const showShellFastLabel =
    (useClaudeShellChipLayout || provider === 'cursor') && fastModeEnabled && fastModeCapable
  const showCodexShellFastBolt = composerStyle === 'codex' && fastModeEnabled && fastModeCapable
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
        kimiThinkingEnabled
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
      kimiThinkingEnabled
    ]
  )

  // Split chip text into "model" and "reasoning" pieces so we can
  // style them differently (model normal, reasoning muted/dimmed —
  // mirrors real Codex's `5.5 Extra High` rendering where "Extra
  // High" reads softer than "5.5").
  const chipPieces = useMemo(() => {
    if (!reasoningSuffix) return { primary: chipText, suffix: '' }
    if (chipText.endsWith(reasoningSuffix)) {
      const primary = chipText.slice(0, chipText.length - reasoningSuffix.length).trimEnd()
      // Trim trailing separator (`·` or space) so the suffix renders
      // as its own visual unit with its own styling.
      const cleaned = primary.replace(/[\s·]+$/, '')
      return { primary: cleaned, suffix: reasoningSuffix }
    }
    return { primary: chipText, suffix: '' }
  }, [chipText, reasoningSuffix])

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
      const popoverWidth = isOllamaProviderPicker ? 500 : reasoningOptions.length > 0 ? 360 : 200
      const left = Math.max(8, rect.right - popoverWidth)
      // Anchor ABOVE the chip with a small gap.
      const top = rect.top - 8
      setPosition({ left, top })
    }
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) computePosition()
    })
    if (!repositionOnScroll) {
      return () => {
        cancelled = true
      }
    }
    // Re-anchor to the trigger while the user scrolls the surrounding list.
    window.addEventListener('scroll', computePosition, true)
    window.addEventListener('resize', computePosition)
    return () => {
      cancelled = true
      window.removeEventListener('scroll', computePosition, true)
      window.removeEventListener('resize', computePosition)
    }
  }, [isOllamaProviderPicker, open, reasoningOptions.length, repositionOnScroll])

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
    const resetState = resolveCombinedModelPickerResetState({
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
    modelOptions,
    ollamaProviderGroups,
    open,
    selectedModelId,
    selectedOllamaProviderId,
    reasoningOptions,
    selectedReasoning
  ])

  // Click-outside + Escape dismiss.
  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
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
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (focusedColumn === 'provider') {
          setProviderHighlight((idx) => Math.min(ollamaProviderGroups.length - 1, idx + 1))
        } else if (focusedColumn === 'model') {
          setModelHighlight((idx) =>
            Math.min(Math.max(0, visibleModelOptions.length - 1), idx + 1)
          )
        } else {
          // Reasoning ladder: down = lower effort. The slider commits on move.
          const enabled = ladder.enabledIndices
          if (enabled.length > 0 && !disabled) {
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
          if (enabled.length > 0 && !disabled) {
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
        } else if (focusedColumn === 'model' && reasoningOptions.length > 0) {
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
          const option = visibleModelOptions[modelHighlight]
          if (option && !option.disabled) onSelectModel(option.id)
        } else {
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
    ollamaProviderGroups,
    reasoningOptions,
    modelHighlight,
    providerHighlight,
    onSelectModel,
    onSelectReasoning,
    visibleModelOptions,
    disabled,
    ladder,
    provider,
    selectedReasoning
  ])

  const popoverContent = open && position && (
    <div
      ref={popoverRef}
      className={`composer-combined-picker-popover provider-${provider} shell-${composerStyle} ${
        isOllamaProviderPicker ? 'is-ollama-model-picker' : ''
      }`}
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        transform: 'translateY(-100%)'
      }}
      role="dialog"
      aria-label="Choose model and reasoning level"
    >
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
        className={`composer-combined-picker-column composer-combined-picker-models ${focusedColumn === 'model' ? 'is-focused' : ''}`}
      >
        <div className="composer-combined-picker-column-header">Model</div>
        {visibleModelOptions.length === 0 && (
          <div
            className="composer-combined-picker-row"
            style={{ cursor: 'default', color: 'var(--text-tertiary)', fontStyle: 'italic' }}
          >
            <span className="composer-combined-picker-row-label">Loading models&hellip;</span>
          </div>
        )}
        {visibleModelOptions.map((option, idx) => {
          const supportsFast = Boolean(
            fastModeCapableModelIds && fastModeCapableModelIds.has(option.id)
          )
          return (
            <button
              key={option.id}
              type="button"
              className={`composer-combined-picker-row ${option.id === selectedModelId ? 'is-selected' : ''} ${option.disabled ? 'is-disabled' : ''} ${idx === modelHighlight && focusedColumn === 'model' ? 'is-highlighted' : ''}`}
              disabled={Boolean(disabled || option.disabled)}
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
                // Keep the popover open so the user can also tweak
                // reasoning without re-clicking the chip. Real Codex
                // behaves the same way.
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
              {option.id === selectedModelId && (
                <span className="composer-combined-picker-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          )
        })}
      </div>
      {reasoningOptions.length > 0 && (
        <div
          className={`composer-combined-picker-column composer-combined-picker-reasoning ${focusedColumn === 'reasoning' ? 'is-focused' : ''}`}
        >
          <div className="composer-combined-picker-column-header">Reasoning</div>
          <ReasoningLadderSlider
            provider={provider}
            ladder={ladder}
            selectedReasoning={selectedReasoning}
            onSelectReasoning={onSelectReasoning}
            disabled={disabled}
            onInteract={() => setFocusedColumn('reasoning')}
          />
          {/*
            Fast Mode toggle. Tucked under the Reasoning column so
            it reads as a Reasoning-adjacent capability rather than
            a separate concept. Visible only for Codex + Claude
            (the providers with capable models); the row stays
            visible but disabled when the selected model isn't
            in `fastModeCapableModelIds` so the user understands
            the affordance exists but doesn't apply to this model.
          */}
          {fastModeRowVisible && (
            <button
              type="button"
              className={`composer-combined-picker-row composer-combined-picker-fast-toggle ${fastModeEnabled ? 'is-selected' : ''}`}
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
        </div>
      )}
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-combined-picker-trigger"
        data-composer-control="model"
        data-provider={provider}
        data-selected-reasoning={selectedReasoning || ''}
        data-fast-mode-active={fastModeEnabled && fastModeCapable ? 'true' : 'false'}
        // Provider brand hue for the Ultra/Ultracode shimmer + sparkles (the
        // popover's --accent is generic — see the ladder's --ladder-accent).
        style={
          {
            '--chip-accent': `var(--provider-${provider}-color, var(--accent))`
          } as React.CSSProperties
        }
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Model and reasoning"
      >
        {showCodexShellFastBolt && (
          <CodexFastBoltIcon className="composer-combined-picker-trigger-fast-bolt" />
        )}
        {claudeChipSegments ? (
          <>
            <span className="composer-combined-picker-trigger-primary">{claudeChipSegments.model}</span>
            {claudeChipSegments.fast ? (
              <span className="composer-combined-picker-trigger-tail">
                {/* No dot glyph — a couple of non-breaking spaces stand in as
                    the model/reasoning gap (nbsp so it survives whitespace
                    collapsing). */}
                <span className="composer-combined-picker-trigger-separator" aria-hidden>
                  {'  '}
                </span>
                <span className="composer-combined-picker-trigger-fast-reasoning">
                  <span className="composer-combined-picker-trigger-fast">{claudeChipSegments.fast}</span>
                  {claudeChipSegments.reasoning && (
                    <TriggerReasoningSuffix
                      text={claudeChipSegments.reasoning}
                      sparkle={selectedReasoning === 'ultracode'}
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
                  sparkle={selectedReasoning === 'ultracode'}
                />
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="composer-combined-picker-trigger-primary">{chipPieces.primary}</span>
            {chipPieces.suffix && (
              <TriggerReasoningSuffix
                text={chipPieces.suffix}
                sparkle={selectedReasoning === 'ultracode'}
              />
            )}
          </>
        )}
      </button>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
