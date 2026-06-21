/*
 * OllamaTierPicker — the composer's per-chat Ollama tool-control picker.
 *
 * Replaces the static "T4 · Ollama parity" badge with a two-pane popover that
 * mirrors CombinedPermissionsPicker's visual structure (same
 * `composer-combined-picker-*` classes) but with DEPENDENT panes:
 *
 *   LEFT  (parent) — Ollama Tier: the 4-step tool-control ladder
 *                    (read_only … provider_parity). Single-select.
 *   RIGHT (child)  — Run Profile: the run-profile presets whose `.tier` matches
 *                    the selected tier. Single-select. Today the mapping is 1:1
 *                    (each tier has exactly one profile), so the child "echoes"
 *                    the parent; it stays a real picker so custom profiles can
 *                    fan out per tier later.
 *
 * This component is purely presentational — it reports raw selections and never
 * persists anything. The parent (App.tsx composer ctx) owns the per-chat write
 * AND the tier↔profile coupling: on a tier change it persists the new tier and
 * resets the run profile to that tier's default so the two never desync.
 *
 * Tier 4 (provider_parity) is special: it only takes effect once the active
 * workspace has been granted parity (otherwise the runtime silently downgrades
 * to read_only — see MEMORY.md ollama-edit-tiers). When `tier4Granted` is false
 * the Tier-4 row shows a lock hint and clicking it calls `onRequestTier4Ack`
 * (the parent opens the ack/grant flow) instead of selecting outright.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle, OllamaRunProfileId, OllamaToolControlTier, ProviderId } from '../../../main/store/types'
import {
  OLLAMA_RUN_PROFILE_OPTIONS,
  OLLAMA_TOOL_CONTROL_TIERS
} from '../../../shared/ollamaTierTables'

interface OllamaTierPickerProps {
  /** Always 'ollama' — kept for `provider-${provider}` CSS class parity. */
  provider: ProviderId
  composerStyle: ComposerStyle
  selectedTier: OllamaToolControlTier
  onSelectTier: (tier: OllamaToolControlTier) => void
  /** Effective run profile (chat override if it matches the tier, else the tier default). */
  selectedRunProfile: OllamaRunProfileId
  onSelectRunProfile: (profile: OllamaRunProfileId) => void
  /**
   * Whether the active workspace has been granted Tier-4 parity. When false (and
   * `onRequestTier4Ack` is provided) clicking Tier 4 opens the ack flow instead
   * of selecting. Undefined ⇒ no gating (select normally).
   */
  tier4Granted?: boolean
  onRequestTier4Ack?: () => void
  /** Global chats have no workspace to grant — Tier 4 can never be active. */
  tier4Unavailable?: boolean
  disabled?: boolean
  /** Re-anchor the popover to the trigger on scroll/resize (off by default). */
  repositionOnScroll?: boolean
}

/** The run profiles available for a given tier (dependent child column). */
function runProfilesForTier(tier: OllamaToolControlTier) {
  return OLLAMA_RUN_PROFILE_OPTIONS.filter((profile) => profile.tier === tier)
}

/**
 * The security-critical routing decision: must picking `tier` be gated behind the
 * Tier-4 acknowledgement flow? Tier 4 (provider parity) grants a LOCAL model the
 * full tool surface (edits + shell), and only takes effect once the chat's
 * workspace has been granted parity — without a grant the runtime SILENTLY
 * downgrades to read_only (MEMORY.md ollama-edit-tiers). So an ungranted (or
 * global-chat, no-workspace-to-grant) Tier-4 pick must NEVER be written
 * directly; it routes to the ack/grant flow instead. Exported pure so the gate
 * is unit-tested directly rather than only through DOM interaction.
 */
export function shouldGateOllamaTier4(input: {
  tier: OllamaToolControlTier
  tier4Granted?: boolean
  tier4Unavailable?: boolean
}): boolean {
  // Fail closed: only an EXPLICIT grant (tier4Granted === true) lets parity
  // through. Unknown grant state (undefined) gates too, so the picker can never
  // write ungranted parity by default.
  return (
    input.tier === 'provider_parity' &&
    (Boolean(input.tier4Unavailable) || !input.tier4Granted)
  )
}

export function OllamaTierPicker({
  provider,
  composerStyle,
  selectedTier,
  onSelectTier,
  selectedRunProfile,
  onSelectRunProfile,
  tier4Granted,
  onRequestTier4Ack,
  tier4Unavailable,
  disabled,
  repositionOnScroll
}: OllamaTierPickerProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [focusedColumn, setFocusedColumn] = useState<'tiers' | 'profiles'>('tiers')
  const [tierHighlight, setTierHighlight] = useState(0)
  const [profileHighlight, setProfileHighlight] = useState(0)

  const selectedTierOption =
    OLLAMA_TOOL_CONTROL_TIERS.find((tier) => tier.value === selectedTier) ||
    OLLAMA_TOOL_CONTROL_TIERS[0]

  // Child column: profiles for the SELECTED tier. The active profile is the
  // chat override when it belongs to this tier, otherwise the tier's first
  // (default) profile — defensive against a stale cross-tier profile id.
  const childProfiles = useMemo(() => runProfilesForTier(selectedTier), [selectedTier])
  const effectiveProfileValue = useMemo(() => {
    const match = childProfiles.find((profile) => profile.value === selectedRunProfile)
    return match?.value ?? childProfiles[0]?.value
  }, [childProfiles, selectedRunProfile])

  // Tier-4 needs a per-workspace grant to actually take effect.
  const tier4Gated = (value: OllamaToolControlTier): boolean =>
    shouldGateOllamaTier4({ tier: value, tier4Granted, tier4Unavailable })

  // Split "Tier 3 · Approved shell" into a compact chip: primary "Tier 3",
  // suffix "Approved shell". Fall back to the whole label if the separator
  // ever changes.
  const chipPieces = useMemo(() => {
    const parts = selectedTierOption.label.split(' · ')
    return parts.length === 2
      ? { primary: parts[0], suffix: parts[1] }
      : { primary: selectedTierOption.label, suffix: '' }
  }, [selectedTierOption.label])

  // Selecting a tier — gate Tier 4 behind the ack flow when ungranted. A gated
  // pick is NEVER written through onSelectTier (that would persist ungranted
  // provider_parity, which silently downgrades at runtime); it routes to the ack
  // flow, or no-ops if no handler is wired (the inert/standalone case).
  const chooseTier = (tier: OllamaToolControlTier): void => {
    if (tier4Gated(tier)) {
      onRequestTier4Ack?.()
      setOpen(false)
      return
    }
    onSelectTier(tier)
  }

  // If the composer locks (e.g. a run starts) while the popover is open, close
  // it — the rows themselves ignore `disabled`, which only gates the trigger.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  // Position the popover above-left of the chip when opened.
  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const left = Math.max(8, rect.left)
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
  }, [open, repositionOnScroll])

  // Reset highlights when the popover opens.
  useEffect(() => {
    if (!open) return
    const tierIdx = Math.max(
      0,
      OLLAMA_TOOL_CONTROL_TIERS.findIndex((tier) => tier.value === selectedTier)
    )
    const profileIdx = Math.max(
      0,
      childProfiles.findIndex((profile) => profile.value === effectiveProfileValue)
    )
    const frame = window.requestAnimationFrame(() => {
      setTierHighlight(tierIdx)
      setProfileHighlight(profileIdx)
      setFocusedColumn('tiers')
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, selectedTier, childProfiles, effectiveProfileValue])

  // Click-outside + Escape dismiss.
  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent): void => {
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

  // Arrow navigation.
  useEffect(() => {
    if (!open) return
    const handleArrowKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (focusedColumn === 'tiers') {
          setTierHighlight((idx) => Math.min(OLLAMA_TOOL_CONTROL_TIERS.length - 1, idx + 1))
        } else {
          setProfileHighlight((idx) => Math.min(childProfiles.length - 1, idx + 1))
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (focusedColumn === 'tiers') {
          setTierHighlight((idx) => Math.max(0, idx - 1))
        } else {
          setProfileHighlight((idx) => Math.max(0, idx - 1))
        }
      } else if (event.key === 'ArrowRight' && childProfiles.length > 0) {
        event.preventDefault()
        setFocusedColumn('profiles')
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setFocusedColumn('tiers')
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (focusedColumn === 'tiers') {
          const option = OLLAMA_TOOL_CONTROL_TIERS[tierHighlight]
          if (option) chooseTier(option.value)
        } else {
          const profile = childProfiles[profileHighlight]
          if (profile) onSelectRunProfile(profile.value)
        }
      }
    }
    document.addEventListener('keydown', handleArrowKey, true)
    return () => {
      document.removeEventListener('keydown', handleArrowKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusedColumn, childProfiles, tierHighlight, profileHighlight, selectedTier, tier4Granted, tier4Unavailable])

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
      aria-label="Choose Ollama tool-control tier and run profile"
    >
      <div
        className={`composer-combined-picker-column composer-combined-picker-ollama-tiers ${focusedColumn === 'tiers' ? 'is-focused' : ''}`}
      >
        <div className="composer-combined-picker-column-header">Ollama Tier</div>
        {OLLAMA_TOOL_CONTROL_TIERS.map((option, idx) => {
          const isSelected = option.value === selectedTier
          const gated = tier4Gated(option.value)
          return (
            <button
              key={option.value}
              type="button"
              data-ollama-tier={option.value}
              className={`composer-combined-picker-row composer-combined-picker-row-grant ${isSelected ? 'is-selected' : ''} ${idx === tierHighlight && focusedColumn === 'tiers' ? 'is-highlighted' : ''}`}
              onMouseEnter={() => {
                setFocusedColumn('tiers')
                setTierHighlight(idx)
              }}
              onClick={() => chooseTier(option.value)}
              title={option.helper}
            >
              <span className="composer-combined-picker-row-grant-body">
                <span className="composer-combined-picker-row-label">
                  {option.label}
                  {gated ? ' 🔒' : ''}
                </span>
                <span className="composer-combined-picker-row-sub">
                  {gated
                    ? tier4Unavailable
                      ? 'Unavailable in global chats — open a workspace thread.'
                      : 'Requires workspace parity acknowledgement.'
                    : option.helper}
                </span>
              </span>
              {isSelected && (
                <span className="composer-combined-picker-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div
        className={`composer-combined-picker-column composer-combined-picker-ollama-profiles ${focusedColumn === 'profiles' ? 'is-focused' : ''}`}
      >
        <div className="composer-combined-picker-column-header">Run Profile</div>
        {childProfiles.map((profile, idx) => {
          const isSelected = profile.value === effectiveProfileValue
          return (
            <button
              key={profile.value}
              type="button"
              data-ollama-run-profile={profile.value}
              className={`composer-combined-picker-row composer-combined-picker-row-grant ${isSelected ? 'is-selected' : ''} ${idx === profileHighlight && focusedColumn === 'profiles' ? 'is-highlighted' : ''}`}
              onMouseEnter={() => {
                setFocusedColumn('profiles')
                setProfileHighlight(idx)
              }}
              onClick={() => onSelectRunProfile(profile.value)}
              title={profile.helper}
            >
              <span className="composer-combined-picker-row-grant-body">
                <span className="composer-combined-picker-row-label">{profile.label}</span>
                <span className="composer-combined-picker-row-sub">{profile.helper}</span>
              </span>
              {isSelected && (
                <span className="composer-combined-picker-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-combined-picker-trigger composer-ollama-tier-trigger"
        data-composer-control="ollama-tier"
        data-ollama-tier={selectedTier}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Ollama tool-control tier and run profile for this chat"
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
