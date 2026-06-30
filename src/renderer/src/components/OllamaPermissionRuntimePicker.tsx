/*
 * OllamaPermissionRuntimePicker — one Ollama-only composer control that folds:
 *   - permission mode / participant permission preset
 *   - Ollama tool-control tier + run profile
 *   - workspace / participant tool grants
 *
 * CombinedPermissionsPicker stays generic for every non-Ollama provider. This
 * component exists because Ollama's local runtime tier works alongside the
 * normal permissions posture and was consuming a second horizontal chip.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AgenticServiceId,
  AgenticServicesSettings,
  ComposerStyle,
  OllamaRunProfileId,
  OllamaToolControlTier,
  ProviderId
} from '../../../main/store/types'
import {
  OLLAMA_RUN_PROFILE_OPTIONS,
  OLLAMA_TOOL_CONTROL_TIERS
} from '../../../shared/ollamaTierTables'
import type { WorkspacePolicyService } from '../lib/workspacePolicyServices'
import type { PermissionOption } from './CombinedPermissionsPicker'
import { shouldGateOllamaTier4 } from './OllamaTierPicker'

type FocusedColumn = 'permission' | 'runtime' | 'grants'

type RuntimeRow =
  | {
      kind: 'tier'
      value: OllamaToolControlTier
      label: string
      helper: string
    }
  | {
      kind: 'profile'
      value: OllamaRunProfileId
      label: string
      helper: string
    }

interface OllamaPermissionRuntimePickerProps {
  provider: ProviderId
  composerStyle: ComposerStyle
  permissionOptions: PermissionOption[]
  selectedPermission: string
  onSelectPermission: (value: string) => void
  grantServices: WorkspacePolicyService[]
  enabledGrantIds: Set<AgenticServiceId>
  agenticServices: AgenticServicesSettings
  onToggleGrant: (service: AgenticServiceId, enabled: boolean) => void
  grantScopeLabel?: 'workspace' | 'participant'
  onApplyToAllParticipants?: () => void
  selectedTier: OllamaToolControlTier
  onSelectTier: (tier: OllamaToolControlTier) => void
  selectedRunProfile: OllamaRunProfileId
  onSelectRunProfile: (profile: OllamaRunProfileId) => void
  tier4Granted?: boolean
  onRequestTier4Ack?: () => void
  tier4Unavailable?: boolean
  disabled?: boolean
  repositionOnScroll?: boolean
}

function shortTierLabel(tier: OllamaToolControlTier): string {
  const option = OLLAMA_TOOL_CONTROL_TIERS.find((item) => item.value === tier)
  return option?.label.split(' · ')[0] || 'Tier 1'
}

export function formatOllamaPermissionRuntimeChip(input: {
  permissionLabel: string
  selectedTier: OllamaToolControlTier
  grantsCount: number
}): { primary: string; suffix: string } {
  const pieces = [shortTierLabel(input.selectedTier)]
  if (input.grantsCount > 0) {
    pieces.push(`${input.grantsCount} grant${input.grantsCount === 1 ? '' : 's'}`)
  }
  return {
    primary: input.permissionLabel,
    suffix: pieces.join(' · ')
  }
}

export function OllamaPermissionRuntimePicker({
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
  onApplyToAllParticipants,
  selectedTier,
  onSelectTier,
  selectedRunProfile,
  onSelectRunProfile,
  tier4Granted,
  onRequestTier4Ack,
  tier4Unavailable,
  disabled,
  repositionOnScroll
}: OllamaPermissionRuntimePickerProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [focusedColumn, setFocusedColumn] = useState<FocusedColumn>('permission')
  const [permissionHighlight, setPermissionHighlight] = useState(0)
  const [runtimeHighlight, setRuntimeHighlight] = useState(0)
  const [grantHighlight, setGrantHighlight] = useState(0)

  const selectedPermissionOption = permissionOptions.find(
    (option) => option.value === selectedPermission
  ) || permissionOptions[0] || { value: selectedPermission, label: selectedPermission }
  const grantsCount = useMemo(
    () => grantServices.filter((service) => enabledGrantIds.has(service.id)).length,
    [grantServices, enabledGrantIds]
  )
  const chipPieces = useMemo(
    () =>
      formatOllamaPermissionRuntimeChip({
        permissionLabel: selectedPermissionOption.label,
        selectedTier,
        grantsCount
      }),
    [selectedPermissionOption.label, selectedTier, grantsCount]
  )
  const runtimeRows = useMemo<RuntimeRow[]>(
    () => [
      ...OLLAMA_TOOL_CONTROL_TIERS.map((tier) => ({
        kind: 'tier' as const,
        value: tier.value,
        label: tier.label,
        helper: tier.helper
      })),
      ...OLLAMA_RUN_PROFILE_OPTIONS.map((profile) => ({
        kind: 'profile' as const,
        value: profile.value,
        label: profile.label,
        helper: profile.helper
      }))
    ],
    []
  )
  const columnOrder: FocusedColumn[] =
    grantServices.length > 0 ? ['permission', 'runtime', 'grants'] : ['permission', 'runtime']

  const tier4Gated = (value: OllamaToolControlTier): boolean =>
    shouldGateOllamaTier4({ tier: value, tier4Granted, tier4Unavailable })

  const chooseTier = (tier: OllamaToolControlTier): void => {
    if (tier4Gated(tier)) {
      onRequestTier4Ack?.()
      setOpen(false)
      return
    }
    onSelectTier(tier)
  }

  const chooseRuntimeRow = (row: RuntimeRow | undefined): void => {
    if (!row) return
    if (row.kind === 'tier') {
      chooseTier(row.value)
      return
    }
    onSelectRunProfile(row.value)
  }

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const computePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const popoverWidth = grantServices.length > 0 ? 640 : 440
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8))
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

  useEffect(() => {
    if (!open) return
    const permissionIdx = Math.max(
      0,
      permissionOptions.findIndex((option) => option.value === selectedPermission)
    )
    const selectedRuntimeIdx = Math.max(
      0,
      runtimeRows.findIndex((row) =>
        row.kind === 'tier' ? row.value === selectedTier : row.value === selectedRunProfile
      )
    )
    const frame = window.requestAnimationFrame(() => {
      setPermissionHighlight(permissionIdx)
      setRuntimeHighlight(selectedRuntimeIdx)
      setGrantHighlight(0)
      setFocusedColumn('permission')
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, permissionOptions, selectedPermission, runtimeRows, selectedTier, selectedRunProfile])

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

  useEffect(() => {
    if (!open) return
    const handleArrowKey = (event: KeyboardEvent): void => {
      const columnIndex = columnOrder.indexOf(focusedColumn)
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setFocusedColumn(columnOrder[Math.min(columnOrder.length - 1, columnIndex + 1)])
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setFocusedColumn(columnOrder[Math.max(0, columnIndex - 1)])
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (focusedColumn === 'permission') {
          setPermissionHighlight((idx) => Math.min(permissionOptions.length - 1, idx + 1))
        } else if (focusedColumn === 'runtime') {
          setRuntimeHighlight((idx) => Math.min(runtimeRows.length - 1, idx + 1))
        } else {
          setGrantHighlight((idx) => Math.min(grantServices.length - 1, idx + 1))
        }
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (focusedColumn === 'permission') {
          setPermissionHighlight((idx) => Math.max(0, idx - 1))
        } else if (focusedColumn === 'runtime') {
          setRuntimeHighlight((idx) => Math.max(0, idx - 1))
        } else {
          setGrantHighlight((idx) => Math.max(0, idx - 1))
        }
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (focusedColumn === 'permission') {
          const option = permissionOptions[permissionHighlight]
          if (option) onSelectPermission(option.value)
        } else if (focusedColumn === 'runtime') {
          chooseRuntimeRow(runtimeRows[runtimeHighlight])
        } else {
          const service = grantServices[grantHighlight]
          if (service) onToggleGrant(service.id, !enabledGrantIds.has(service.id))
        }
      }
    }
    document.addEventListener('keydown', handleArrowKey, true)
    return () => {
      document.removeEventListener('keydown', handleArrowKey, true)
    }
  }, [
    open,
    columnOrder,
    focusedColumn,
    permissionOptions,
    runtimeRows,
    grantServices,
    permissionHighlight,
    runtimeHighlight,
    grantHighlight,
    enabledGrantIds,
    onSelectPermission,
    onToggleGrant,
    onSelectRunProfile,
    onSelectTier,
    tier4Granted,
    tier4Unavailable
  ])

  const parityIneffective = shouldGateOllamaTier4({
    tier: selectedTier,
    tier4Granted,
    tier4Unavailable
  })

  const popoverContent = open && position && (
    <div
      ref={popoverRef}
      className={`composer-combined-picker-popover composer-ollama-permission-runtime-popover provider-${provider} shell-${composerStyle}`}
      style={{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        transform: 'translateY(-100%)'
      }}
      role="dialog"
      aria-label="Choose Ollama permissions, runtime, and tool grants"
    >
      <div
        className={`composer-combined-picker-column composer-combined-picker-permissions ${focusedColumn === 'permission' ? 'is-focused' : ''}`}
      >
        <div className="composer-combined-picker-column-header">Permissions</div>
        {permissionOptions.map((option, idx) => (
          <button
            key={option.value}
            type="button"
            data-permission-value={option.value}
            className={`composer-combined-picker-row ${option.value === selectedPermission ? 'is-selected' : ''} ${idx === permissionHighlight && focusedColumn === 'permission' ? 'is-highlighted' : ''}`}
            onMouseEnter={() => {
              setFocusedColumn('permission')
              setPermissionHighlight(idx)
            }}
            onClick={() => onSelectPermission(option.value)}
          >
            <span className="composer-combined-picker-row-label">{option.label}</span>
            {option.value === selectedPermission && (
              <span className="composer-combined-picker-check" aria-hidden>
                ✓
              </span>
            )}
          </button>
        ))}
        {onApplyToAllParticipants ? (
          <button
            type="button"
            className="composer-combined-picker-apply-all"
            onClick={() => {
              onApplyToAllParticipants()
              setOpen(false)
            }}
            title="Copy this participant's permission mode and tool grants to every ensemble participant"
          >
            Apply to all participants
          </button>
        ) : null}
      </div>
      <div
        className={`composer-combined-picker-column composer-combined-picker-ollama-runtime ${focusedColumn === 'runtime' ? 'is-focused' : ''}`}
      >
        <div className="composer-combined-picker-column-header">Ollama Runtime</div>
        <div className="composer-combined-picker-column-note">
          {grantScopeLabel === 'participant'
            ? 'Participant tier and run profile'
            : 'Chat-scoped tier and run profile'}
        </div>
        <div className="composer-combined-picker-section-label">Tool tier</div>
        {OLLAMA_TOOL_CONTROL_TIERS.map((option, idx) => {
          const isSelected = option.value === selectedTier
          const gated = tier4Gated(option.value)
          return (
            <button
              key={option.value}
              type="button"
              data-ollama-tier={option.value}
              className={`composer-combined-picker-row composer-combined-picker-row-grant ${isSelected ? 'is-selected' : ''} ${idx === runtimeHighlight && focusedColumn === 'runtime' ? 'is-highlighted' : ''}`}
              onMouseEnter={() => {
                setFocusedColumn('runtime')
                setRuntimeHighlight(idx)
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
                      ? 'Unavailable in general chats'
                      : 'Requires workspace parity acknowledgement'
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
        <div className="composer-combined-picker-section-label">Run profile</div>
        {OLLAMA_RUN_PROFILE_OPTIONS.map((profile, offset) => {
          const idx = OLLAMA_TOOL_CONTROL_TIERS.length + offset
          const isSelected = profile.value === selectedRunProfile
          return (
            <button
              key={profile.value}
              type="button"
              data-ollama-run-profile={profile.value}
              className={`composer-combined-picker-row composer-combined-picker-row-grant ${isSelected ? 'is-selected' : ''} ${idx === runtimeHighlight && focusedColumn === 'runtime' ? 'is-highlighted' : ''}`}
              onMouseEnter={() => {
                setFocusedColumn('runtime')
                setRuntimeHighlight(idx)
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
        className="composer-combined-picker-trigger composer-ollama-permission-runtime-trigger composer-ollama-tier-trigger"
        data-composer-control="permission"
        data-provider={provider}
        data-permission-value={selectedPermission}
        data-ollama-tier={selectedTier}
        data-ollama-run-profile={selectedRunProfile}
        data-ollama-tier-ineffective={parityIneffective ? 'true' : undefined}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          parityIneffective
            ? tier4Unavailable
              ? 'Tier 4 is selected but unavailable in general chats; Ollama runs read-only.'
              : 'Tier 4 is selected but this workspace has not been granted provider parity; Ollama runs read-only.'
            : 'Ollama permissions, runtime, and tool grants'
        }
      >
        <span className="composer-combined-picker-trigger-primary">{chipPieces.primary}</span>
        {chipPieces.suffix && (
          <span className="composer-combined-picker-trigger-suffix">{chipPieces.suffix}</span>
        )}
        {parityIneffective && (
          <span
            className="composer-ollama-tier-warning"
            aria-label="Tier 4 not active for this workspace"
          >
            ⚠
          </span>
        )}
      </button>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
