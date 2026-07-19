/*
 * CombinedPermissionsPicker — replaces the standalone Default-approval
 * native <select> + the standalone "Tool Grants" pill in the above-bar
 * with one combined chip + a two-column popover (Permission mode on
 * the left, Tool Grants on the right).
 *
 * Mirrors CombinedModelPicker's structure but the Tool-Grants column
 * is multi-select (checkboxes), unlike the reasoning column which is
 * single-select. The chip text shows the active permission mode plus
 * a `(N)` suffix when N tool grants are enabled, so the user can see
 * grant state at a glance without opening the popover.
 *
 * Wires to existing renderer state (no new IPC, no new types):
 *   - permissionOptions / selectedPermission / onSelectPermission
 *   - grantServices / enabledGrantIds / onToggleGrant
 *
 * Tool-Grants column is hidden when:
 *   - workspace is global (no workspace path to scope grants to), OR
 *   - `grantServices` is empty
 * In both cases the popover degrades cleanly to a single-column
 * permission picker.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AgenticServiceId,
  AgenticServicesSettings,
  ComposerStyle,
  ProviderId
} from '../../../main/store/types'
import { permissionOptionCanBeSelected } from '../lib/chatPopoutAuthority'
import type { WorkspacePolicyService } from '../lib/workspacePolicyServices'

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
  /**
   * Workspace policy services for the Tool-Grants column. Pass an
   * empty array to hide the column entirely (e.g. for global chats
   * without a workspace path to scope grants to).
   */
  grantServices: WorkspacePolicyService[]
  enabledGrantIds: Set<AgenticServiceId>
  /** Global agentic-service policy — used to render row sub-labels. */
  agenticServices: AgenticServicesSettings
  onToggleGrant: (service: AgenticServiceId, enabled: boolean) => void
  grantScopeLabel?: 'workspace' | 'participant'
  disabled?: boolean
  /** Explain why the whole permission surface is unavailable. */
  disabledReason?: string
  /** Ensemble-only: copy the current permission preset + grants to every participant. */
  onApplyToAllParticipants?: () => void
  /**
   * Special high-authority lane elevation. When present, selecting the
   * `full_access` row opens the caller-owned confirmation flow instead of
   * directly writing the preset.
   */
  onStartTrustedSession?: () => void
  /** Downgrade the selected lane out of Trusted Session. */
  onStopTrustedSession?: () => void
  /**
   * When true, the open popover re-anchors to the trigger on scroll/resize.
   * Default false keeps the composer's behaviour byte-identical; Settings →
   * Roster passes true because its pickers live inside a scrolling list.
   */
  repositionOnScroll?: boolean
}

export function CombinedPermissionsPicker({
  provider,
  composerStyle,
  permissionOptions,
  selectedPermission,
  onSelectPermission,
  grantServices,
  enabledGrantIds,
  agenticServices,
  onToggleGrant,
  grantScopeLabel = 'workspace',
  disabled,
  disabledReason,
  onApplyToAllParticipants,
  onStartTrustedSession,
  onStopTrustedSession,
  repositionOnScroll
}: CombinedPermissionsPickerProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [focusedColumn, setFocusedColumn] = useState<'permission' | 'grants'>('permission')
  const [permissionHighlight, setPermissionHighlight] = useState(0)
  const [grantHighlight, setGrantHighlight] = useState(0)

  const selectedOption = permissionOptions.find((option) => option.value === selectedPermission) ||
    permissionOptions[0] || { value: selectedPermission, label: selectedPermission }

  const grantsCount = useMemo(
    () => grantServices.filter((service) => enabledGrantIds.has(service.id)).length,
    [grantServices, enabledGrantIds]
  )

  // Split chip text into "primary" (permission) and muted "suffix"
  // (grants count). Mirrors CombinedModelPicker's two-span layout.
  const chipPieces = useMemo(() => {
    if (grantsCount > 0 && grantServices.length > 0) {
      return {
        primary: selectedOption.label,
        suffix: `${grantsCount} grant${grantsCount === 1 ? '' : 's'}`
      }
    }
    return { primary: selectedOption.label, suffix: '' }
  }, [selectedOption.label, grantsCount, grantServices.length])

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
  }, [open, grantServices.length, repositionOnScroll])

  // Reset highlights when the popover opens.
  useEffect(() => {
    if (!open) return
    const permIdx = Math.max(
      0,
      permissionOptions.findIndex((option) => option.value === selectedPermission)
    )
    const frame = window.requestAnimationFrame(() => {
      setPermissionHighlight(permIdx)
      setGrantHighlight(0)
      setFocusedColumn('permission')
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
        if (focusedColumn === 'permission') {
          setPermissionHighlight((idx) => Math.min(permissionOptions.length - 1, idx + 1))
        } else {
          setGrantHighlight((idx) => Math.min(grantServices.length - 1, idx + 1))
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (focusedColumn === 'permission') {
          setPermissionHighlight((idx) => Math.max(0, idx - 1))
        } else {
          setGrantHighlight((idx) => Math.max(0, idx - 1))
        }
      } else if (event.key === 'ArrowRight' && grantServices.length > 0) {
        event.preventDefault()
        setFocusedColumn('grants')
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setFocusedColumn('permission')
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (focusedColumn === 'permission') {
          choosePermissionOption(permissionOptions[permissionHighlight])
        } else {
          const service = grantServices[grantHighlight]
          if (service) {
            const isOn = enabledGrantIds.has(service.id)
            onToggleGrant(service.id, !isOn)
          }
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
    permissionOptions,
    grantServices,
    permissionHighlight,
    grantHighlight,
    enabledGrantIds,
    choosePermissionOption,
    onToggleGrant
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
      aria-label="Choose permission mode and tool grants"
    >
      <div
        className={`composer-combined-picker-column composer-combined-picker-permissions ${focusedColumn === 'permission' ? 'is-focused' : ''}`}
      >
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
              className={`composer-combined-picker-row ${option.value === selectedPermission ? 'is-selected' : ''} ${idx === permissionHighlight && focusedColumn === 'permission' ? 'is-highlighted' : ''}`}
              onMouseEnter={() => {
                setFocusedColumn('permission')
                setPermissionHighlight(idx)
              }}
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
                ? 'Trusted Session must be enabled per participant.'
                : "Copy this participant's permission mode and tool grants to every ensemble participant"
            }
          >
            {selectedPermission === 'full_access'
              ? 'Apply to all disabled for Trusted Session'
              : 'Apply to all participants'}
          </button>
        ) : null}
      </div>
      {grantServices.length > 0 && (
        <div
          className={`composer-combined-picker-column composer-combined-picker-grants ${focusedColumn === 'grants' ? 'is-focused' : ''}`}
        >
          <div className="composer-combined-picker-column-header">Tool Grants</div>
          {grantServices.map((service, idx) => {
            const checked = enabledGrantIds.has(service.id)
            const policy = agenticServices[service.id]
            const subLabel =
              policy === 'deny'
                ? 'Blocked globally'
                : checked
                  ? `Allowed for this ${grantScopeLabel}`
                  : `Global policy: ${policy}`
            return (
              <button
                key={service.id}
                type="button"
                className={`composer-combined-picker-row composer-combined-picker-row-grant ${checked ? 'is-selected' : ''} ${idx === grantHighlight && focusedColumn === 'grants' ? 'is-highlighted' : ''}`}
                onMouseEnter={() => {
                  setFocusedColumn('grants')
                  setGrantHighlight(idx)
                }}
                onClick={() => onToggleGrant(service.id, !checked)}
                title={service.help}
              >
                <span className="composer-combined-picker-row-grant-checkbox" aria-hidden>
                  {checked ? '☑' : '☐'}
                </span>
                <span className="composer-combined-picker-row-grant-body">
                  <span className="composer-combined-picker-row-label">{service.label}</span>
                  <span className="composer-combined-picker-row-sub">{subLabel}</span>
                </span>
              </button>
            )
          })}
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
        data-composer-control="permission"
        data-permission-value={selectedPermission}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={disabledReason || 'Permission mode and tool grants'}
        aria-label={disabledReason || 'Choose permission mode and tool grants'}
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
