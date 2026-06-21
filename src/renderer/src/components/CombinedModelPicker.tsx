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
import { formatComposerModelChip, reasoningDisplayLabel } from '../lib/composerChipFormat'

export interface CombinedModelPickerModelOption {
  id: string
  label: string
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

/**
 * Inline lightning-bolt icon used as the "supports Fast tier"
 * affordance next to capable model labels and as the icon for
 * the toggle row beneath the Reasoning column.
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
  const [focusedColumn, setFocusedColumn] = useState<'model' | 'reasoning'>('model')
  const [modelHighlight, setModelHighlight] = useState(0)
  const [reasoningHighlight, setReasoningHighlight] = useState(0)

  const selectedModelOption = modelOptions.find((option) => option.id === selectedModelId) ||
    modelOptions[0] || { id: selectedModelId, label: selectedModelId }

  const chipText = useMemo(
    () =>
      formatComposerModelChip({
        provider,
        composerStyle,
        modelId: selectedModelOption.id,
        modelLabel: selectedModelOption.label,
        codexReasoningEffort,
        claudeReasoningEffort,
        kimiThinkingEnabled
      }),
    [
      provider,
      composerStyle,
      selectedModelOption.id,
      selectedModelOption.label,
      codexReasoningEffort,
      claudeReasoningEffort,
      kimiThinkingEnabled
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
        kimiThinkingEnabled
      }),
    [
      provider,
      composerStyle,
      selectedModelOption.id,
      selectedModelOption.label,
      codexReasoningEffort,
      claudeReasoningEffort,
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
      const popoverWidth = reasoningOptions.length > 0 ? 360 : 200
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
  }, [open, reasoningOptions.length, repositionOnScroll])

  // Reset highlights when the popover opens.
  useEffect(() => {
    if (!open) return
    const modelIdx = Math.max(
      0,
      modelOptions.findIndex((option) => option.id === selectedModelId)
    )
    const reasoningIdx = Math.max(
      0,
      reasoningOptions.findIndex((option) => option.value === selectedReasoning)
    )
    const frame = window.requestAnimationFrame(() => {
      setModelHighlight(modelIdx)
      setReasoningHighlight(reasoningIdx)
      setFocusedColumn('model')
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, modelOptions, selectedModelId, reasoningOptions, selectedReasoning])

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
        if (focusedColumn === 'model') {
          setModelHighlight((idx) => Math.min(modelOptions.length - 1, idx + 1))
        } else {
          setReasoningHighlight((idx) => Math.min(reasoningOptions.length - 1, idx + 1))
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (focusedColumn === 'model') {
          setModelHighlight((idx) => Math.max(0, idx - 1))
        } else {
          setReasoningHighlight((idx) => Math.max(0, idx - 1))
        }
      } else if (event.key === 'ArrowRight' && reasoningOptions.length > 0) {
        event.preventDefault()
        setFocusedColumn('reasoning')
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setFocusedColumn('model')
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (focusedColumn === 'model') {
          const option = modelOptions[modelHighlight]
          if (option) onSelectModel(option.id)
        } else {
          const option = reasoningOptions[reasoningHighlight]
          if (option) onSelectReasoning(option.value)
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
    modelOptions,
    reasoningOptions,
    modelHighlight,
    reasoningHighlight,
    onSelectModel,
    onSelectReasoning
  ])

  const popoverContent = open && position && (
    <div
      ref={popoverRef}
      className={`composer-combined-picker-popover provider-${provider} shell-${composerStyle}`}
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        transform: 'translateY(-100%)'
      }}
      role="dialog"
      aria-label="Choose model and reasoning level"
    >
      <div
        className={`composer-combined-picker-column composer-combined-picker-models ${focusedColumn === 'model' ? 'is-focused' : ''}`}
      >
        <div className="composer-combined-picker-column-header">Model</div>
        {modelOptions.length === 0 && (
          <div
            className="composer-combined-picker-row"
            style={{ cursor: 'default', color: 'var(--text-tertiary)', fontStyle: 'italic' }}
          >
            <span className="composer-combined-picker-row-label">Loading models&hellip;</span>
          </div>
        )}
        {modelOptions.map((option, idx) => {
          const supportsFast = Boolean(
            fastModeCapableModelIds && fastModeCapableModelIds.has(option.id)
          )
          return (
            <button
              key={option.id}
              type="button"
              className={`composer-combined-picker-row ${option.id === selectedModelId ? 'is-selected' : ''} ${idx === modelHighlight && focusedColumn === 'model' ? 'is-highlighted' : ''}`}
              onMouseEnter={() => {
                setFocusedColumn('model')
                setModelHighlight(idx)
              }}
              onClick={() => {
                onSelectModel(option.id)
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
                  <FastBoltIcon />
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
              className={`composer-combined-picker-row ${option.value === selectedReasoning ? 'is-selected' : ''} ${idx === reasoningHighlight && focusedColumn === 'reasoning' ? 'is-highlighted' : ''}`}
              onMouseEnter={() => {
                setFocusedColumn('reasoning')
                setReasoningHighlight(idx)
              }}
              onClick={() => {
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
                if (!fastModeCapable) return
                onToggleFastMode?.()
              }}
              disabled={!fastModeCapable}
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
                <FastBoltIcon />
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
        data-fast-mode-active={fastModeEnabled && fastModeCapable ? 'true' : 'false'}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Model and reasoning"
      >
        <span className="composer-combined-picker-trigger-primary">{chipPieces.primary}</span>
        {chipPieces.suffix && (
          <span className="composer-combined-picker-trigger-suffix">{chipPieces.suffix}</span>
        )}
      </button>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
