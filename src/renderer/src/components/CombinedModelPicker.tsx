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
      width="11"
      height="11"
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
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [focusedColumn, setFocusedColumn] = useState<CombinedModelPickerColumn>('model')
  const [providerHighlight, setProviderHighlight] = useState(0)
  const [modelHighlight, setModelHighlight] = useState(0)
  const [reasoningHighlight, setReasoningHighlight] = useState(0)
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
      setReasoningHighlight(resetState.reasoningIndex)
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

  // Keep the reasoning row highlight current without disturbing the provider
  // and model browse columns.
  useEffect(() => {
    if (!open) return
    const reasoningIdx = Math.max(
      0,
      reasoningOptions.findIndex((option) => option.value === selectedReasoning)
    )
    setReasoningHighlight(reasoningIdx)
  }, [open, reasoningOptions, selectedReasoning])

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
          setReasoningHighlight((idx) =>
            Math.min(Math.max(0, reasoningOptions.length - 1), idx + 1)
          )
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (focusedColumn === 'provider') {
          setProviderHighlight((idx) => Math.max(0, idx - 1))
        } else if (focusedColumn === 'model') {
          setModelHighlight((idx) => Math.max(0, idx - 1))
        } else {
          setReasoningHighlight((idx) => Math.max(0, idx - 1))
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
          const option = reasoningOptions[reasoningHighlight]
          if (option && !option.disabled) onSelectReasoning(option.value)
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
    reasoningHighlight,
    onSelectModel,
    onSelectReasoning,
    visibleModelOptions,
    disabled
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
          {reasoningOptions.map((option, idx) => (
            <button
              key={option.value}
              type="button"
              className={`composer-combined-picker-row ${option.value === selectedReasoning ? 'is-selected' : ''} ${option.value === 'ultracode' ? 'is-ultracode' : ''} ${option.disabled ? 'is-disabled' : ''} ${idx === reasoningHighlight && focusedColumn === 'reasoning' ? 'is-highlighted' : ''}`}
              data-reasoning-value={option.value}
              disabled={Boolean(disabled || option.disabled)}
              title={option.disabled ? option.disabledReason || 'Unavailable for this model' : undefined}
              onMouseEnter={() => {
                setFocusedColumn('reasoning')
                setReasoningHighlight(idx)
              }}
              onClick={() => {
                if (disabled || option.disabled) return
                onSelectReasoning(option.value)
              }}
            >
              <span className="composer-combined-picker-row-label">{option.label}</span>
              {option.value === selectedReasoning && (
                <span className="composer-combined-picker-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          ))}
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
                <span>Fast mode</span>
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
                <span className="composer-combined-picker-trigger-separator" aria-hidden>
                  {' · '}
                </span>
                <span className="composer-combined-picker-trigger-fast-reasoning">
                  <span className="composer-combined-picker-trigger-fast">{claudeChipSegments.fast}</span>
                  {claudeChipSegments.reasoning && (
                    <span className="composer-combined-picker-trigger-suffix">
                      {claudeChipSegments.reasoning}
                    </span>
                  )}
                </span>
              </span>
            ) : claudeChipSegments.reasoning ? (
              <span className="composer-combined-picker-trigger-tail">
                <span className="composer-combined-picker-trigger-separator" aria-hidden>
                  {' · '}
                </span>
                <span className="composer-combined-picker-trigger-suffix">
                  {claudeChipSegments.reasoning}
                </span>
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span className="composer-combined-picker-trigger-primary">{chipPieces.primary}</span>
            {chipPieces.suffix && (
              <span className="composer-combined-picker-trigger-suffix">{chipPieces.suffix}</span>
            )}
          </>
        )}
      </button>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
