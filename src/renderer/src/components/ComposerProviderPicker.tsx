/*
 * ComposerProviderPicker — replaces the composer's plain native
 * provider <select> with the same rich body-portaled popover the
 * other composer controls use (model / reasoning, permissions, the
 * "+"/attach menu). Modelled structurally on ComposerPlusPicker: a
 * trigger that keeps the composer's `.composer-picker-label` chrome
 * + `data-composer-control="provider"` hook (so every shell's
 * existing provider-control positioning / theming applies unchanged)
 * plus a portaled popover that reuses the shared
 * `composer-combined-picker-popover` + `composer-plus-picker-*`
 * classes and a `shell-${composerStyle}` class.
 *
 * Using `shell-${composerStyle}` is what makes this ONE fix for all
 * shells — the per-shell popover theming (grok / cursor monochrome,
 * obsidian / alabaster theme-immunity, etc.) is already defined in
 * main.css against `.composer-combined-picker-popover.shell-*` and
 * applies automatically. There are deliberately NO per-shell
 * branches in this component and NO per-shell CSS.
 *
 * Behaviour parity with the old <select>:
 *   - Available providers come from the canonical live-provider contract.
 *     Readiness and discovery state may inform warnings elsewhere, but never
 *     hide a statically live provider from this picker.
 *   - The active provider carries a checkmark.
 *   - Selection calls `onSelect(providerId)` — wired by App.tsx to
 *     the same `handleComposerProviderChange` the <select> used, so
 *     the chat-level vs ensemble-participant retargeting is unchanged.
 *   - `disabled` mirrors the old <select>'s disabled expression.
 *   - `title` reflects "Selected participant provider" vs "Provider".
 *
 * Popover positioning + click-outside / Escape handling are cloned
 * from ComposerPlusPicker.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { AppSettings, ComposerStyle, ProviderId } from '../../../main/store/types'
import {
  isLiveSelectableProvider,
  LIVE_SELECTABLE_PROVIDER_IDS
} from '../../../shared/retiredProviders'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { getProviderOfferUnavailableReason } from '../lib/providerLabels'
import { getProviderName } from './Sidebar'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'

interface ComposerProviderPickerProps {
  /**
   * The provider the trigger should reflect + the row that carries
   * the checkmark. In a solo chat this is the chat-level provider; in
   * an ensemble chat with a participant selected it's that
   * participant's provider (App.tsx resolves this before passing it).
   */
  provider: ProviderId
  composerStyle: ComposerStyle
  /** Legacy readiness hint retained for caller compatibility; it does not hide Grok. */
  grokAvailable: boolean
  /** Legacy readiness hint retained for caller compatibility; it does not hide Cursor. */
  cursorAvailable: boolean
  /** Cached main-process discovery result; reading it never starts provider probes. */
  configuredProviderSnapshot?: ConfiguredProviderPickerSnapshot
  /** Same handler the old <select>'s onChange called. */
  onSelect: (provider: ProviderId) => void
  providerRunPauses?: AppSettings['providerRunPauses']
  disabled?: boolean
  /**
   * Active model id — used to resolve Ollama display-brand hue + label
   * overrides on the trigger (matches @-mention / ensemble chip tinting).
   */
  activeModelId?: string | null
  /**
   * "Selected participant provider" (ensemble binding) or "Provider"
   * (solo). Used for the trigger title + aria-label and the popover
   * aria-label.
   */
  title: string
  /**
   * When true, the open popover re-anchors to the trigger on scroll/resize.
   * Default false keeps the composer's behaviour byte-identical; Settings →
   * Roster passes true because its pickers live inside a scrolling list.
   */
  repositionOnScroll?: boolean
}

interface ProviderRow {
  id: ProviderId
  label: string
  description: string
  pauseLabel?: string
  rerouteLabel?: string
}

export interface ConfiguredProviderPickerSnapshot {
  ready: boolean
  providerIds: readonly ProviderId[]
}

export interface ProviderPickerAvailability {
  snapshot: ConfiguredProviderPickerSnapshot
  /** Legacy discovery fallback retained for compatibility; it never hides static live rows. */
  pendingFallbackProvider?: ProviderId
}

/**
 * One-line descriptors mirroring the model picker's muted sub-label
 * style. Optional flavour — the rows still read fine without them —
 * but they bring the popover up to the visual richness of the other
 * composer pickers.
 */
const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  gemini: 'Google Gemini CLI',
  codex: 'OpenAI Codex CLI',
  claude: 'Anthropic Claude Code',
  kimi: 'Moonshot Kimi CLI',
  grok: 'xAI Grok CLI',
  cursor: 'Cursor Agent CLI',
  ollama: 'Local Ollama HTTP',
  antigravity: 'Antigravity CLI',
  pi: 'Pi CLI (BYOK)',
  mistral: 'Mistral Vibe CLI',
  muse: 'Muse Code CLI'
}

/** User-facing offer-policy reason for a retired or not-yet-configured provider. */
export function providerRunUnavailableReason(provider: ProviderId): string | null {
  // AntiGravity's real admission authority is the consent/key union enforced by
  // App and main at dispatch. The configured-provider model catalogue is a
  // presentation cache that intentionally goes empty while refreshing, so it
  // must not create a sticky composer warning or disable an otherwise admitted
  // AGY / Gemini API lane.
  if (provider === 'antigravity' || isLiveSelectableProvider(provider)) return null
  return `${getProviderOfferUnavailableReason(provider)} Choose a currently offered provider to continue.`
}

/**
 * Resolve the visible provider rows. Every canonical live provider remains
 * selectable regardless of readiness/discovery hints; those signals belong in
 * warnings and setup guidance, not provider admission. A retired id (Gemini)
 * never renders even when seeded. AntiGravity remains the sole conditional
 * row, admitted only by the configured-provider snapshot. Exported so the
 * popover body can be unit-tested via SSR without a DOM (the live popover only
 * mounts after a click + layout effect).
 */
export function resolveProviderRows(
  _grokAvailable: boolean,
  _cursorAvailable: boolean,
  providerRunPauses?: AppSettings['providerRunPauses'],
  availability?: ProviderPickerAvailability
): ProviderRow[] {
  // Selecting a live provider is how a user reaches its setup/sign-in path.
  // Runtime availability, authentication, model discovery, or another stronger
  // management layer may produce an honest warning, but must not remove the
  // provider row. AntiGravity is deliberately different: it is not statically
  // live and remains behind its configured/consent snapshot.
  const antigravityAdmitted = Boolean(availability?.snapshot.providerIds.includes('antigravity'))
  const ids: ProviderId[] = [...LIVE_SELECTABLE_PROVIDER_IDS]
  if (antigravityAdmitted) {
    // Keep the conditional remote lane adjacent to the other remote providers
    // while preserving the canonical order of every static live provider.
    const insertionIndex = ids.indexOf('ollama')
    ids.splice(insertionIndex < 0 ? ids.length : insertionIndex, 0, 'antigravity')
  }
  return ids.map((id) => {
    const pauseInfo = getProviderPauseInfo(providerRunPauses, id)
    return {
      id,
      label: getProviderName(id),
      description: PROVIDER_DESCRIPTIONS[id],
      ...(pauseInfo || {})
    }
  })
}

/**
 * Presentational popover body — the sectioned provider rows with
 * icon + label + sub-label + active checkmark. Split out from the
 * stateful picker (à la GrokCreditsMeterView) so it can be rendered
 * directly in tests; the picker wraps this in the body portal.
 */
export function ComposerProviderPickerRows({
  rows,
  activeProvider,
  onSelect
}: {
  rows: ProviderRow[]
  activeProvider: ProviderId
  onSelect: (provider: ProviderId) => void
}): React.JSX.Element {
  return (
    <div className="composer-plus-picker-section">
      <div className="composer-combined-picker-column-header">Provider</div>
      {rows.map((row) => {
        const active = row.id === activeProvider
        return (
          <button
            key={row.id}
            type="button"
            data-provider-value={row.id}
            className={`composer-combined-picker-row composer-plus-picker-row ${
              active ? 'is-selected' : ''
            } ${row.pauseLabel ? 'is-paused' : ''}`}
            onClick={() => onSelect(row.id)}
            title={[row.description, row.pauseLabel, row.rerouteLabel].filter(Boolean).join('\n')}
            aria-pressed={active}
          >
            <span className="composer-plus-picker-row-icon" aria-hidden>
              <ProviderBrandLogoIcon provider={row.id} />
            </span>
            <span className="composer-plus-picker-row-copy">
              <span className="composer-combined-picker-row-label">{row.label}</span>
              <span className="composer-combined-picker-row-sub">
                {row.pauseLabel ? `${row.pauseLabel} · ${row.rerouteLabel}` : row.description}
              </span>
            </span>
            {row.pauseLabel && (
              <span className="composer-provider-paused-pill" aria-hidden>
                Paused
              </span>
            )}
            {active && (
              <span className="composer-combined-picker-check" aria-hidden>
                ✓
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function ComposerProviderPicker({
  provider,
  composerStyle,
  grokAvailable,
  cursorAvailable,
  configuredProviderSnapshot = { ready: false, providerIds: [] },
  onSelect,
  providerRunPauses,
  disabled,
  activeModelId,
  title,
  repositionOnScroll
}: ComposerProviderPickerProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  const rows = resolveProviderRows(
    grokAvailable,
    cursorAvailable,
    providerRunPauses,
    {
      snapshot: configuredProviderSnapshot,
      pendingFallbackProvider: provider
    }
  )
  const activePauseInfo = getProviderPauseInfo(providerRunPauses, provider)
  const providerHueClass = resolveProviderHueClass(provider, activeModelId)
  const displayLabel = resolveProviderBrandLabel(provider, activeModelId) ?? getProviderName(provider)
  const triggerStyle = {
    '--composer-provider-accent': `var(--provider-${providerHueClass}-color, currentColor)`
  } as CSSProperties

  // Position the popover above the trigger (cloned from
  // ComposerPlusPicker).
  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340))
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
    window.addEventListener('scroll', computePosition, true)
    window.addEventListener('resize', computePosition)
    return () => {
      cancelled = true
      window.removeEventListener('scroll', computePosition, true)
      window.removeEventListener('resize', computePosition)
    }
  }, [open, rows.length, repositionOnScroll])

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
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [open])

  const handleSelect = (id: ProviderId): void => {
    if (disabled) {
      setOpen(false)
      return
    }
    onSelect(id)
    setOpen(false)
  }

  const popover =
    open && position
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-plus-picker-popover provider-${provider} shell-${composerStyle}`}
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              transform: 'translateY(-100%)'
            }}
            role="dialog"
            aria-label={title}
          >
            <ComposerProviderPickerRows
              rows={rows}
              activeProvider={provider}
              onSelect={handleSelect}
            />
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-picker-label composer-provider-button provider-${providerHueClass}`}
        data-composer-control="provider"
        data-provider-value={provider}
        style={triggerStyle}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (disabled) return
          setOpen((current) => !current)
        }}
        disabled={disabled}
      >
        <span className="composer-provider-button-icon" aria-hidden="true">
          <ProviderBrandLogoIcon provider={provider} />
        </span>
        <span className="composer-provider-button-label">{displayLabel}</span>
        {activePauseInfo && (
          <span className="composer-provider-button-paused" aria-label={activePauseInfo.pauseLabel}>
            Paused
          </span>
        )}
      </button>
      {popover}
    </>
  )
}

function getProviderPauseInfo(
  providerRunPauses: AppSettings['providerRunPauses'] | undefined,
  provider: ProviderId
): Pick<ProviderRow, 'pauseLabel' | 'rerouteLabel'> | null {
  const pause = providerRunPauses?.[provider]
  if (!pause?.paused) return null
  if (pause.until) {
    const until = Date.parse(pause.until)
    if (!Number.isFinite(until) || until <= Date.now()) return null
  }
  return {
    pauseLabel: pause.until ? `Paused until ${new Date(pause.until).toLocaleString()}` : 'Paused',
    rerouteLabel:
      pause.reroute?.provider && pause.reroute.provider !== provider
        ? `reroutes to ${getProviderName(pause.reroute.provider)}`
        : 'no automatic reroute'
  }
}
