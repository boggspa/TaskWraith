import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRecord, ProviderId, ToolActivity } from '../../../main/store/types'
import {
  computeMergedTodosByLane,
  summarizeTodoProgress,
  TODO_SOLO_LANE,
  type TodoItem
} from '../../../main/TodoList'
import { getProviderLabel } from '../lib/providerLabels'
import { PlanSymbolIcon } from './AppChromeSymbols'
import { TodoChecklistCard } from './TodoChecklistCard'

export interface ComposerPlanLane {
  lane: string
  provider?: ProviderId
  role?: string
  order?: number
  todos: TodoItem[]
}

export interface ComposerPlanPopoverPosition {
  left: number
  top: number
  placement: 'above' | 'below'
}

interface ComposerPlanPopoverButtonProps {
  chat?: ChatRecord | null
  composerStyle?: string
}

function activeCount(todos: readonly TodoItem[]): number {
  return todos.filter((item) => item.status !== 'cancelled').length
}

function completedCount(todos: readonly TodoItem[]): number {
  return todos.filter((item) => item.status === 'completed').length
}

function providerFromLane(lane: string): ProviderId | undefined {
  switch (lane) {
    case 'codex':
    case 'claude':
    case 'kimi':
    case 'grok':
    case 'cursor':
    case 'ollama':
    case 'gemini':
      return lane as ProviderId
    default:
      return undefined
  }
}

export function composerPlanLaneLabel(lane: ComposerPlanLane): string {
  if (lane.lane === TODO_SOLO_LANE) return 'Plan'
  const providerLabel = lane.provider ? getProviderLabel(lane.provider) : ''
  if (lane.role && providerLabel) return `${lane.role} / ${providerLabel}`
  if (providerLabel) return providerLabel
  return lane.lane
}

function laneColorStyle(lane: ComposerPlanLane): CSSProperties {
  const colorLane = lane.provider || lane.lane
  return {
    '--composer-plan-lane-color': `var(--provider-${colorLane}-color, var(--accent))`
  } as CSSProperties
}

function buildLane(chat: ChatRecord | null | undefined, lane: string, todos: TodoItem[]): ComposerPlanLane {
  const participant = chat?.ensemble?.participants.find((item) => item.id === lane)
  const provider = participant?.provider || providerFromLane(lane)
  return {
    lane,
    ...(provider ? { provider } : {}),
    ...(participant?.role ? { role: participant.role } : {}),
    ...(typeof participant?.order === 'number' ? { order: participant.order } : {}),
    todos
  }
}

function compareLanes(a: ComposerPlanLane, b: ComposerPlanLane): number {
  if (a.order !== undefined || b.order !== undefined) {
    return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
  }
  return composerPlanLaneLabel(a).localeCompare(composerPlanLaneLabel(b))
}

function buildPersistedTodoLanes(chat?: ChatRecord | null): ComposerPlanLane[] {
  return Object.entries(chat?.chatTodos ?? {})
    .filter(([, todos]) => todos.length > 0)
    .map(([lane, todos]) => buildLane(chat, lane, todos))
    .sort(compareLanes)
}

export function buildComposerPlanLanes(chat?: ChatRecord | null): ComposerPlanLane[] {
  const activities: ToolActivity[] = []
  for (const message of chat?.messages ?? []) {
    for (const activity of message.toolActivities ?? []) {
      if (activity.parentToolCallId) continue
      activities.push(activity)
    }
  }
  if (activities.length === 0) return buildPersistedTodoLanes(chat)
  const byLane = computeMergedTodosByLane(
    activities,
    (activity) =>
      activity.metadata?.ensembleParticipantId ??
      activity.metadata?.ensembleProvider ??
      activity.metadata?.provider ??
      TODO_SOLO_LANE
  )
  const activityLanes = Object.entries(byLane)
    .filter(([, todos]) => todos.length > 0)
    .map(([lane, todos]) => buildLane(chat, lane, todos))
    .sort(compareLanes)
  return activityLanes.length > 0 ? activityLanes : buildPersistedTodoLanes(chat)
}

export function computeComposerPlanPopoverPosition(
  rect: Pick<DOMRect, 'left' | 'width' | 'top' | 'bottom'>,
  viewport: { width: number; height: number },
  popoverSize: { width: number; height: number } = { width: 356, height: 400 }
): ComposerPlanPopoverPosition {
  const edgePadding = 8
  const gap = 8
  const minLeft = edgePadding + popoverSize.width / 2
  const maxLeft = Math.max(minLeft, viewport.width - edgePadding - popoverSize.width / 2)
  const left = Math.min(Math.max(rect.left + rect.width / 2, minLeft), maxLeft)
  const spaceAbove = Math.max(0, rect.top - edgePadding - gap)
  const spaceBelow = Math.max(0, viewport.height - rect.bottom - edgePadding - gap)
  const placement =
    spaceBelow > spaceAbove && spaceAbove < popoverSize.height ? 'below' : 'above'
  if (placement === 'below') {
    const unclampedTop = rect.bottom + gap
    const maxTop = Math.max(edgePadding, viewport.height - edgePadding - popoverSize.height)
    return {
      left,
      top: Math.min(Math.max(unclampedTop, edgePadding), maxTop),
      placement
    }
  }
  const unclampedTop = rect.top - gap
  return {
    left,
    top: Math.max(edgePadding + popoverSize.height, Math.min(unclampedTop, viewport.height - edgePadding)),
    placement
  }
}

export function ComposerPlanPopoverButton({
  chat,
  composerStyle = 'default'
}: ComposerPlanPopoverButtonProps): React.JSX.Element | null {
  const lanes = useMemo(() => buildComposerPlanLanes(chat), [chat])
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<ComposerPlanPopoverPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const stats = useMemo(() => {
    const totalActive = lanes.reduce((sum, lane) => sum + activeCount(lane.todos), 0)
    const totalCompleted = lanes.reduce((sum, lane) => sum + completedCount(lane.todos), 0)
    const hasInProgress = lanes.some((lane) =>
      lane.todos.some((item) => item.status === 'in_progress')
    )
    const allComplete = totalActive > 0 && totalCompleted >= totalActive
    return { totalActive, totalCompleted, hasInProgress, allComplete }
  }, [lanes])

  const updatePosition = useCallback((): void => {
    if (typeof window === 'undefined') return
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const popoverHeight = popoverRef.current?.offsetHeight || 400
    setPosition(
      computeComposerPlanPopoverPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width: 356, height: popoverHeight }
      )
    )
  }, [])

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

  if (!chat) return null

  const stateClass = stats.hasInProgress ? 'active' : stats.allComplete ? 'completed' : 'pending'
  const title =
    stats.totalActive > 0 ? `Plan - ${stats.totalCompleted}/${stats.totalActive} complete` : 'Plan'
  const ariaLabel = stats.hasInProgress ? `${title}, in progress` : title
  const showLaneHeaders = lanes.length > 1

  const popover =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-plan-popover shell-${composerStyle}${position?.placement === 'below' ? ' is-below' : ''}`}
            role="dialog"
            aria-label="Plan"
            style={
              position
                ? { left: `${position.left}px`, top: `${position.top}px` }
                : { left: '0px', top: '0px', visibility: 'hidden' }
            }
          >
            <div className="composer-plan-popover-header">
              <span className="composer-plan-popover-title">Plan</span>
              {stats.totalActive > 0 && (
                <span className="composer-plan-count-chip">
                  {stats.totalCompleted}/{stats.totalActive}
                </span>
              )}
            </div>
            {lanes.length > 0 ? (
              <div className="composer-plan-lanes">
                {lanes.map((lane) => {
                  const summary = summarizeTodoProgress(lane.todos)
                  const laneActive = summary.total - summary.cancelled
                  return (
                    <section className="composer-plan-lane" key={lane.lane}>
                      {showLaneHeaders && lane.lane !== TODO_SOLO_LANE && (
                        <div
                          className="composer-plan-lane-header"
                          style={laneColorStyle(lane)}
                        >
                          <span className="composer-plan-lane-dot" aria-hidden />
                          <span className="composer-plan-lane-label">
                            {composerPlanLaneLabel(lane)}
                          </span>
                          {laneActive > 0 && (
                            <span className="composer-plan-lane-count">
                              {summary.completed}/{laneActive}
                            </span>
                          )}
                        </div>
                      )}
                      <TodoChecklistCard todos={lane.todos} variant="full" />
                    </section>
                  )
                })}
              </div>
            ) : (
              <p className="composer-plan-empty">No plan steps published yet.</p>
            )}
          </div>,
          document.body
        )
      : null

  return (
    <span className="composer-plan-control-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-plan-button composer-hint-pill is-${stateClass}${open ? ' is-open' : ''}`}
        data-hint-label="Plan"
        onClick={() => setOpen((value) => !value)}
        title={title}
        aria-label={ariaLabel}
        aria-expanded={open}
        data-plan-status={stateClass}
      >
        <PlanSymbolIcon />
        {stats.hasInProgress && <span className="composer-plan-button-dot" aria-hidden="true" />}
        {stats.allComplete && <span className="composer-plan-button-check" aria-hidden="true" />}
      </button>
      {popover}
    </span>
  )
}
