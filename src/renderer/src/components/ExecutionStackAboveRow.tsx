import { memo, type JSX } from 'react'
import type {
  ExecutionGraphProjection,
  ExecutionStackPosition,
  ExecutionStepProjection
} from '../lib/executionGraphProjection'

export interface ExecutionStackAboveRowProps {
  projection: ExecutionGraphProjection | null
  onOpenMap: (runId: string, stepId?: string) => void
  onAddToStack?: (runId: string) => void
  onSaveAsWorkflow?: (runId: string) => void
  onCancelStep?: (runId: string, activationId: string, stepId: string) => void
}

const POSITION_LABEL: Record<ExecutionStackPosition, string> = {
  current: 'Current',
  next: 'Next',
  then: 'Then'
}

function positionOrder(position: ExecutionStackPosition): number {
  if (position === 'current') return 0
  if (position === 'next') return 1
  return 2
}

function StackStepRow({
  runId,
  row,
  onOpenMap,
  onCancelStep
}: {
  runId: string
  row: ExecutionStepProjection
  onOpenMap: ExecutionStackAboveRowProps['onOpenMap']
  onCancelStep?: ExecutionStackAboveRowProps['onCancelStep']
}): JSX.Element {
  const position = row.stackPosition ?? 'then'
  const canCancel = row.canCancel && Boolean(row.activationId) && Boolean(onCancelStep)

  return (
    <li
      className={`execution-stack-step tone-${row.statusTone} position-${position}`}
      data-step-id={row.stepId}
      data-step-activation-id={row.activationId ?? undefined}
    >
      <span className="execution-stack-position">{POSITION_LABEL[position]}</span>
      <button
        type="button"
        className="execution-stack-step-summary"
        onClick={() => onOpenMap(runId, row.stepId)}
        aria-current={position === 'current' ? 'step' : undefined}
        aria-label={`${POSITION_LABEL[position]} step, ${row.step.title}, ${row.statusLabel}${
          row.blocker ? `, ${row.blocker}` : ''
        }`}
      >
        <span className="execution-stack-step-copy">
          <span className="execution-stack-step-title">{row.step.title}</span>
          {row.blocker && <span className="execution-stack-step-blocker">{row.blocker}</span>}
        </span>
        {row.isRuntimeAppended && (
          <span className="execution-runtime-badge" title="Added to the frontier during this run">
            Added during run
          </span>
        )}
        <span className={`execution-status-token tone-${row.statusTone}`}>{row.statusLabel}</span>
      </button>
      {canCancel && row.activationId && (
        <button
          type="button"
          className="execution-stack-cancel-step"
          onClick={() => onCancelStep?.(runId, row.activationId as string, row.stepId)}
          aria-label={`Cancel planned step ${row.step.title}`}
        >
          Cancel
        </button>
      )}
    </li>
  )
}

function ExecutionStackAboveRowImpl({
  projection,
  onOpenMap,
  onAddToStack,
  onSaveAsWorkflow,
  onCancelStep
}: ExecutionStackAboveRowProps): JSX.Element | null {
  if (!projection || projection.stackRows.length === 0) return null

  const rows = [...projection.stackRows].sort(
    (left, right) =>
      positionOrder(left.stackPosition ?? 'then') - positionOrder(right.stackPosition ?? 'then') ||
      left.order - right.order
  )

  return (
    <section
      className="queued-messages-above-row execution-stack-above-row"
      aria-label={`${projection.title} Stack`}
      data-execution-run-id={projection.runId}
    >
      <div className="execution-stack-header">
        <span className="execution-stack-heading">
          <span className="execution-stack-kicker">Stack</span>
          <span className="execution-stack-name">{projection.title}</span>
          <span className={`execution-status-token tone-${projection.runStatusTone}`}>
            {projection.runStatusLabel}
          </span>
        </span>
        <span className="execution-stack-actions">
          {onAddToStack && (
            <button
              type="button"
              className="execution-stack-action"
              onClick={() => onAddToStack(projection.runId)}
            >
              Add to Stack
            </button>
          )}
          {onSaveAsWorkflow && (
            <button
              type="button"
              className="execution-stack-action"
              onClick={() => onSaveAsWorkflow(projection.runId)}
            >
              Save as Workflow
            </button>
          )}
          <button
            type="button"
            className="execution-stack-action is-primary"
            onClick={() => onOpenMap(projection.runId)}
          >
            Open map
          </button>
        </span>
      </div>
      <ol className="execution-stack-list">
        {rows.map((row) => (
          <StackStepRow
            key={row.activationId ?? row.stepId}
            runId={projection.runId}
            row={row}
            onOpenMap={onOpenMap}
            onCancelStep={onCancelStep}
          />
        ))}
      </ol>
      <span className="execution-visually-hidden" role="status" aria-live="polite">
        {projection.liveSummary}
      </span>
    </section>
  )
}

export const ExecutionStackAboveRow = memo(ExecutionStackAboveRowImpl)
