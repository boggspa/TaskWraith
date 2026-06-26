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

interface ComposerPlanLane {
  lane: string
  todos: TodoItem[]
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

function laneLabel(lane: string): string {
  if (lane === TODO_SOLO_LANE) return 'Plan'
  switch (lane) {
    case 'codex':
    case 'claude':
    case 'kimi':
    case 'grok':
    case 'cursor':
    case 'ollama':
    case 'gemini':
      return getProviderLabel(lane as ProviderId)
    default:
      return lane
  }
}

function laneColorStyle(lane: string): CSSProperties {
  return {
    '--composer-plan-lane-color': `var(--provider-${lane}-color, var(--accent))`
  } as CSSProperties
}

function persistedLaneId(chat: ChatRecord, lane: string): string {
  if (lane === TODO_SOLO_LANE) return lane
  return (
    chat.ensemble?.participants.find((participant) => participant.id === lane)?.provider ?? lane
  )
}

function buildPersistedTodoLanes(chat?: ChatRecord | null): ComposerPlanLane[] {
  return Object.entries(chat?.chatTodos ?? {})
    .filter(([, todos]) => todos.length > 0)
    .map(([lane, todos]) => ({ lane: chat ? persistedLaneId(chat, lane) : lane, todos }))
    .sort((a, b) => a.lane.localeCompare(b.lane))
}

function buildComposerPlanLanes(chat?: ChatRecord | null): ComposerPlanLane[] {
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
      activity.metadata?.ensembleProvider ?? activity.metadata?.provider ?? TODO_SOLO_LANE
  )
  const activityLanes = Object.entries(byLane)
    .filter(([, todos]) => todos.length > 0)
    .map(([lane, todos]) => ({ lane, todos }))
    .sort((a, b) => a.lane.localeCompare(b.lane))
  return activityLanes.length > 0 ? activityLanes : buildPersistedTodoLanes(chat)
}

export function ComposerPlanPopoverButton({
  chat,
  composerStyle = 'default'
}: ComposerPlanPopoverButtonProps): React.JSX.Element | null {
  const lanes = useMemo(() => buildComposerPlanLanes(chat), [chat])
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
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
    const popoverWidth = 356
    const edgePadding = 8
    const minLeft = edgePadding + popoverWidth / 2
    const maxLeft = Math.max(minLeft, window.innerWidth - edgePadding - popoverWidth / 2)
    const left = Math.min(Math.max(rect.left + rect.width / 2, minLeft), maxLeft)
    const top = Math.max(edgePadding, rect.top - 8)
    setPosition({ left, top })
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

  if (lanes.length === 0) return null

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
            className={`composer-plan-popover shell-${composerStyle}`}
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
            <div className="composer-plan-lanes">
              {lanes.map((lane) => {
                const summary = summarizeTodoProgress(lane.todos)
                const laneActive = summary.total - summary.cancelled
                return (
                  <section className="composer-plan-lane" key={lane.lane}>
                    {showLaneHeaders && lane.lane !== TODO_SOLO_LANE && (
                      <div className="composer-plan-lane-header" style={laneColorStyle(lane.lane)}>
                        <span className="composer-plan-lane-dot" aria-hidden />
                        <span className="composer-plan-lane-label">{laneLabel(lane.lane)}</span>
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
