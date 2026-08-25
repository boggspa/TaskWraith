/*
 * CombinedPermissionsPicker — the shared permission-mode chip and popover.
 *
 * Tool-specific access now follows the selected permission ladder, so this
 * surface intentionally presents only Plan / Ask / Accept Edits / elevated
 * permission modes. Durable grants remain enforced and revocable elsewhere;
 * they are no longer a second composer-time decision layer.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle, ProviderId } from '../../../main/store/types'
import { permissionOptionCanBeSelected } from '../lib/chatPopoutAuthority'

export interface PermissionOption {
  /** Internal token, usually a PermissionPresetId. */
  value: string
  /** Human-readable label as it appears in the popover row + chip. */
  label: string
  /** Optional explanatory copy under the row label. */
  description?: string
  /** Render this row as a high-risk permission action. */
  danger?: boolean
  /** Keep the row visible while making an authority-only action unavailable. */
  disabled?: boolean
  /** Concise explanation shown beneath and on hover for a disabled row. */
  disabledReason?: string
}

interface CombinedPermissionsPickerProps {
  provider: ProviderId
  composerStyle: ComposerStyle
  permissionOptions: PermissionOption[]
  selectedPermission: string
  onSelectPermission: (value: string) => void
  disabled?: boolean
  /** Explain why the whole permission surface is unavailable. */
  disabledReason?: string
  /** Ensemble-only: copy the current permission settings to every participant. */
  onApplyToAllParticipants?: () => void
  /**
   * Special high-authority lane elevation. When present, selecting the
   * `full_access` row opens the caller-owned confirmation flow instead of
   * directly writing the preset.
   */
  onStartTrustedSession?: () => void
  /** Downgrade the selected lane out of Full Access. */
  onStopTrustedSession?: () => void
  /**
   * When true, the open popover re-anchors to the trigger on scroll/resize.
   * Default false keeps the composer's behaviour byte-identical; Settings →
   * Roster passes true because its pickers live inside a scrolling list.
   */
  repositionOnScroll?: boolean
  /** Optional class on the body-portaled surface for caller-specific layering. */
  popoverClassName?: string
}

export function CombinedPermissionsPicker({
  provider,
  composerStyle,
  permissionOptions,
  selectedPermission,
  onSelectPermission,
  disabled,
  disabledReason,
  onApplyToAllParticipants,
  onStartTrustedSession,
  onStopTrustedSession,
  repositionOnScroll,
  popoverClassName
}: CombinedPermissionsPickerProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [permissionHighlight, setPermissionHighlight] = useState(0)

  const selectedOption = permissionOptions.find((option) => option.value === selectedPermission) ||
    permissionOptions[0] || { value: selectedPermission, label: selectedPermission }

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
    const permIdx = Math.max(
      0,
      permissionOptions.findIndex((option) => option.value === selectedPermission)
    )
    const frame = window.requestAnimationFrame(() => {
      setPermissionHighlight(permIdx)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, permissionOptions, selectedPermission])

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

  // Arrow navigation.
  const choosePermissionOption = useCallback(
    (option: PermissionOption | undefined): void => {
      if (!permissionOptionCanBeSelected(option)) return
      if (option.value === 'full_access' && onStartTrustedSession) {
        if (selectedPermission === 'full_access' && onStopTrustedSession) {
          onStopTrustedSession()
        } else if (selectedPermission !== 'full_access') {
          onStartTrustedSession()
        }
        setOpen(false)
        return
      }
      onSelectPermission(option.value)
      setOpen(false)
    },
    [onSelectPermission, onStartTrustedSession, onStopTrustedSession, selectedPermission]
  )

  useEffect(() => {
    if (!open) return
    const handleArrowKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPermissionHighlight((idx) => Math.min(permissionOptions.length - 1, idx + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPermissionHighlight((idx) => Math.max(0, idx - 1))
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        choosePermissionOption(permissionOptions[permissionHighlight])
      }
    }
    document.addEventListener('keydown', handleArrowKey, true)
    return () => {
      document.removeEventListener('keydown', handleArrowKey, true)
    }
  }, [open, permissionOptions, permissionHighlight, choosePermissionOption])

  const popoverContent = open && position && (
    <div
      ref={popoverRef}
      className={`composer-combined-picker-popover provider-${provider} shell-${composerStyle}${
        popoverClassName ? ` ${popoverClassName}` : ''
      }`}
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        transform: 'translateY(-100%)'
      }}
      role="dialog"
      aria-label="Choose permission mode"
    >
      <div className="composer-combined-picker-column composer-combined-picker-permissions is-focused">
        <div className="composer-combined-picker-column-header">Permissions</div>
        {permissionOptions.map((option, idx) => {
          const isTrustedSession = option.value === 'full_access'
          const optionDescription = option.disabledReason || option.description
          return (
            <button
              key={option.value}
              type="button"
              data-permission-value={option.value}
              data-danger={option.danger || isTrustedSession ? 'true' : undefined}
              className={`composer-combined-picker-row ${option.value === selectedPermission ? 'is-selected' : ''} ${idx === permissionHighlight ? 'is-highlighted' : ''}`}
              onMouseEnter={() => setPermissionHighlight(idx)}
              onClick={() => choosePermissionOption(option)}
              disabled={option.disabled}
              title={option.disabledReason}
            >
              <span className="composer-combined-picker-row-body">
                <span className="composer-combined-picker-row-label">{option.label}</span>
                {optionDescription && (
                  <span className="composer-combined-picker-row-sub">{optionDescription}</span>
                )}
              </span>
              {option.value === selectedPermission && (
                <span className="composer-combined-picker-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          )
        })}
        {onApplyToAllParticipants ? (
          <button
            type="button"
            className="composer-combined-picker-apply-all"
            onClick={() => {
              if (selectedPermission === 'full_access') return
              onApplyToAllParticipants()
              setOpen(false)
            }}
            disabled={selectedPermission === 'full_access'}
            title={
              selectedPermission === 'full_access'
                ? 'Full Access must be enabled per participant.'
                : "Copy this participant's permission settings to every ensemble participant"
            }
          >
            {selectedPermission === 'full_access'
              ? 'Apply to all disabled for Full Access'
              : 'Apply to all participants'}
          </button>
        ) : null}
      </div>
    </div>
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-combined-picker-trigger"
        data-composer-control="permission"
        data-permission-value={selectedPermission}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={disabledReason || 'Permission mode'}
        aria-label={disabledReason || 'Choose permission mode'}
      >
        <span className="composer-combined-picker-trigger-primary">{selectedOption.label}</span>
      </button>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
