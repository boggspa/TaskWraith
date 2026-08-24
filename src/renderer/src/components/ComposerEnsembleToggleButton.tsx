import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRecord, ComposerStyle, EnsembleParticipant } from '../../../main/store/types'
import type { EnsembleUserRosterMutation } from '../../../main/EnsembleUserRosterMutation'
import type { ParticipantPickerConfiguredProviderSnapshot } from './ParticipantPickerCluster'
import {
  computeComposerPlanPopoverPosition,
  type ComposerPlanPopoverPosition
} from './ComposerPlanPopoverButton'
import {
  resolveComposerSurfacePopoverPosition,
  type ComposerSurfacePopoverPosition
} from '../lib/composerSurfacePopover'
import { ComposerEnsembleRosterPopover } from './ComposerEnsembleRosterPopover'
import { ProviderGlyph } from './icons/ProviderGlyph'

interface ComposerEnsembleToggleButtonProps {
  enabled: boolean
  visible: boolean
  onToggle: (enabled: boolean) => void
  chat?: ChatRecord | null
  selectedParticipantId?: string | null
  onSelectParticipant?: (participantId: string) => void
  onPatchParticipant?: (participantId: string, patch: Partial<EnsembleParticipant>) => void
  onLiveRosterMutation?: (mutation: EnsembleUserRosterMutation) => void
  configuredProviderSnapshot?: ParticipantPickerConfiguredProviderSnapshot
  grokAvailable?: boolean
  cursorAvailable?: boolean
  composerStyle?: string
  disabled?: boolean
  title?: string
}

type ComposerEnsemblePopoverPosition =
  | ({ kind: 'toggle' } & ComposerPlanPopoverPosition)
  | ({ kind: 'roster' } & ComposerSurfacePopoverPosition)

export function ComposerEnsembleToggleButton({
  enabled,
  visible,
  onToggle,
  chat,
  selectedParticipantId,
  onSelectParticipant,
  onPatchParticipant,
  onLiveRosterMutation,
  configuredProviderSnapshot,
  grokAvailable,
  cursorAvailable,
  composerStyle = 'default',
  disabled = false,
  title: overrideTitle
}: ComposerEnsembleToggleButtonProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<ComposerEnsemblePopoverPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const updatePosition = useCallback((): void => {
    if (typeof window === 'undefined') return
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const surface = trigger.closest('.composer-surface') as HTMLElement | null
    const surfaceRect = surface?.getBoundingClientRect()
    if (enabled && chat?.ensemble) {
      setPosition({
        kind: 'roster',
        ...resolveComposerSurfacePopoverPosition({
          triggerRect: rect,
          surfaceRect: surfaceRect || rect,
          viewportWidth: window.innerWidth,
          widthFloor: 620
        })
      })
      return
    }
    const popoverHeight = popoverRef.current?.offsetHeight || 118
    setPosition({
      kind: 'toggle',
      ...computeComposerPlanPopoverPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width: 236, height: popoverHeight }
      )
    })
  }, [chat?.ensemble, enabled])

  const closePopover = useCallback((restoreFocus = true): void => {
    setOpen(false)
    if (restoreFocus && typeof window !== 'undefined') {
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    updatePosition()
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePopover()
    }
    const handlePointer = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      // Provider/model/reasoning and permission pickers are intentionally
      // portaled above the compact roster editor. Treat the nested picker as
      // part of this dialog, otherwise choosing a row in it would collapse the
      // roster beneath the user's pointer.
      if (target instanceof Element && target.closest('.composer-combined-picker-popover')) return
      closePopover(false)
    }
    const handleReposition = (): void => updatePosition()
    window.addEventListener('keydown', handleKey)
    window.addEventListener('mousedown', handlePointer)
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [closePopover, open, updatePosition])

  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  if (!visible) return null

  const title = overrideTitle || (enabled ? 'Ensemble on' : 'Ensemble off')
  const rosterWorkspace = enabled && Boolean(chat?.ensemble)
  const selectMode = (nextEnabled: boolean): void => {
    setOpen(false)
    if (nextEnabled !== enabled) onToggle(nextEnabled)
  }

  const popover =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-ensemble-toggle-popover shell-${composerStyle}${
              rosterWorkspace ? ' has-roster' : ''
            }${position?.kind === 'toggle' && position.placement === 'below' ? ' is-below' : ''}`}
            role="dialog"
            aria-label="Ensemble"
            style={
              position
                ? position.kind === 'roster'
                  ? {
                      left: `${position.left}px`,
                      top: `${position.top}px`,
                      width: `${position.width}px`,
                      height: 'min(50vh, 820px)',
                      transform: 'translateY(-100%)'
                    }
                  : {
                      left: `${position.left}px`,
                      top: `${position.top}px`,
                      width: `${position.width}px`
                    }
                : { left: '0px', top: '0px', visibility: 'hidden' }
            }
          >
            <div className="composer-ensemble-toggle-popover-header">
              <span className="composer-ensemble-toggle-popover-title">
                {rosterWorkspace ? 'Ensemble roster' : 'Ensemble'}
              </span>
            </div>
            <div
              className="segmented-control segmented-control--compact composer-ensemble-toggle-segmented"
              role="radiogroup"
              aria-label="Ensemble mode"
            >
              <button
                type="button"
                className={`segmented-control-segment ${enabled ? 'is-active' : ''}`}
                onClick={() => selectMode(true)}
                role="radio"
                aria-checked={enabled}
              >
                On
              </button>
              <button
                type="button"
                className={`segmented-control-segment ${enabled ? '' : 'is-active'}`}
                onClick={() => selectMode(false)}
                role="radio"
                aria-checked={!enabled}
              >
                Off
              </button>
            </div>
            {rosterWorkspace ? (
              <ComposerEnsembleRosterPopover
                chat={chat}
                selectedParticipantId={selectedParticipantId}
                onSelectParticipant={onSelectParticipant}
                onPatchParticipant={onPatchParticipant}
                onLiveRosterMutation={onLiveRosterMutation}
                composerStyle={composerStyle as ComposerStyle}
                configuredProviderSnapshot={configuredProviderSnapshot}
                grokAvailable={grokAvailable}
                cursorAvailable={cursorAvailable}
              />
            ) : null}
          </div>,
          document.body
        )
      : null

  return (
    <span className="composer-ensemble-toggle-control-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-ensemble-toggle-button composer-hint-pill${enabled ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        data-hint-label="Ensemble"
        onClick={() => setOpen((value) => !value)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
      >
        <ProviderGlyph provider="ensemble" />
      </button>
      {popover}
    </span>
  )
}
