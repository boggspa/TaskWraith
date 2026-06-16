import type { TodoItem } from '../../../main/TodoList'
import { findCurrentTodoStep, summarizeTodoProgress } from '../../../main/TodoList'

interface TodoChecklistCardProps {
  todos: readonly TodoItem[]
  variant?: 'compact' | 'full' | 'pinned'
  maxVisible?: number
  /** When set (ensemble per-participant PlanRail), labels the pinned card with
   * the lane (e.g. the provider) so concurrent authors are distinguishable. */
  laneLabel?: string
}

function statusGlyph(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'in_progress':
      return '◉'
    case 'cancelled':
      return '—'
    default:
      return '○'
  }
}

export function TodoChecklistCard({
  todos,
  variant = 'compact',
  maxVisible = 6,
  laneLabel
}: TodoChecklistCardProps) {
  if (todos.length === 0) return null

  if (variant === 'pinned') {
    const current = findCurrentTodoStep(todos)
    const summary = summarizeTodoProgress(todos)
    if (!current) {
      if (summary.completed === summary.total - summary.cancelled && summary.total > 0) {
        return (
          <div className="todo-pinned-step is-complete" aria-label="All plan steps complete">
            <span className="todo-pinned-label">{laneLabel || 'Plan'}</span>
            <span className="todo-pinned-text">{summary.label}</span>
          </div>
        )
      }
      return null
    }
    const activeTotal = summary.total - summary.cancelled
    const stepIndex =
      todos.filter((item) => item.status !== 'cancelled').findIndex((item) => item.id === current.id) +
      1
    return (
      <div className="todo-pinned-step" aria-label={`Current step: ${current.content}`}>
        <span className="todo-pinned-label">{laneLabel || 'Current step'}</span>
        <span className="todo-pinned-text">
          {stepIndex > 0 && activeTotal > 0 ? `${stepIndex}/${activeTotal} · ` : ''}
          {current.content}
        </span>
      </div>
    )
  }

  const visible = variant === 'full' ? todos : todos.slice(0, maxVisible)
  const hiddenCount = todos.length - visible.length

  return (
    <ul
      className={`todo-checklist-card${variant === 'compact' ? ' is-compact' : ' is-full'}`}
      aria-label="Plan steps"
    >
      {visible.map((item) => (
        <li
          key={item.id}
          className={`todo-checklist-item status-${item.status}`}
          data-status={item.status}
        >
          <span className="todo-checklist-glyph" aria-hidden>
            {statusGlyph(item.status)}
          </span>
          <span className="todo-checklist-text">{item.content}</span>
        </li>
      ))}
      {hiddenCount > 0 && (
        <li className="todo-checklist-more" aria-label={`${hiddenCount} more plan steps`}>
          +{hiddenCount} more
        </li>
      )}
    </ul>
  )
}
