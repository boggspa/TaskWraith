import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  ExecutionArtifactRef,
  ExecutionStepDefinition,
  StepAttempt
} from '../../../main/executionGraph/ExecutionGraphModel'
import type {
  ExecutionGraphProjection,
  ExecutionProjectionTone,
  ExecutionStepProjection
} from '../lib/executionGraphProjection'

export interface ExecutionMapViewProps {
  projection: ExecutionGraphProjection | null
  selectedStepId?: string
  onSelectStep?: (stepId: string) => void
  onBack?: () => void
  onOpenThread?: (threadRef: string) => void
  onSaveGraph?: (runId: string) => void
  /** Stop the whole execution. Absent when the caller has no cancel authority. */
  onCancelRun?: (runId: string) => void
  /** Offered only for a PAUSED graph: resume is meaningless while work is
   * already in flight, and refusing on click would teach the reader nothing. */
  onResumeRun?: (runId: string) => void
}

function executionStepKindLabel(kind: ExecutionStepDefinition['kind']): string {
  switch (kind) {
    case 'solo_agent':
      return 'Agent'
    case 'deterministic_check':
      return 'Deterministic check'
    case 'human_gate':
      return 'Human gate'
    case 'join':
      return 'Join'
    case 'ensemble_round':
      return 'Ensemble round'
    case 'output':
      return 'Output'
  }
}

function effectLabel(effect: ExecutionStepDefinition['effect']): string {
  if (effect === 'read_only') return 'Read only'
  if (effect === 'workspace_write') return 'Workspace write'
  return 'External side effect'
}

function attemptStateLabel(state: StepAttempt['state']): string {
  switch (state) {
    case 'created':
      return 'Created'
    case 'claimed':
      return 'Claimed'
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'waiting_input':
      return 'Needs input'
    case 'waiting_approval':
      return 'Needs approval'
    case 'succeeded':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Interrupted'
  }
}

function artifactKindLabel(kind: ExecutionArtifactRef['kind']): string {
  switch (kind) {
    case 'file':
      return 'File'
    case 'diff':
      return 'Diff'
    case 'commit':
      return 'Commit'
    case 'report':
      return 'Report'
    case 'blob':
      return 'Data'
    case 'run':
      return 'Run'
    case 'project_reference':
      return 'Project reference'
    case 'other':
      return 'Other'
  }
}

/* Monoline step-kind marks, drawn in the card's tone colour inside the glyph
 * slot — the same header anatomy (glyph, name, status pill) as the delegated
 * wave / workflow orchestration cards, so one reading skill covers both. */
function StepKindGlyph({ kind }: { kind: ExecutionStepDefinition['kind'] }): JSX.Element {
  return (
    <svg
      viewBox="0 0 12 12"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'solo_agent' && (
        <>
          <circle cx="6" cy="4" r="2.1" />
          <path d="M2.6 10c0-1.9 1.5-2.9 3.4-2.9s3.4 1 3.4 2.9" />
        </>
      )}
      {kind === 'deterministic_check' && <polyline points="2.6,6.4 5,8.8 9.4,3.4" />}
      {kind === 'human_gate' && (
        <>
          <path d="M4.4 3.4v5.2" />
          <path d="M7.6 3.4v5.2" />
        </>
      )}
      {kind === 'join' && <path d="M2.6 2.8 6 6.3m3.4-3.5L6 6.3M6 6.3v3.4" />}
      {kind === 'ensemble_round' && (
        <>
          <circle cx="3.1" cy="3.9" r="1.25" />
          <circle cx="8.9" cy="3.9" r="1.25" />
          <circle cx="6" cy="8.7" r="1.25" />
        </>
      )}
      {kind === 'output' && <path d="M3.6 10V2.6h4.8L6.9 4.9l1.5 2.3H3.6" />}
    </svg>
  )
}

/* Roll a stage's steps up to one tone + label for the stage header. Dormant
 * steps carry the muted tone, so they are checked by activation state — a
 * stage that has not started yet must read "Planned", never "Ended". */
function stageRollup(steps: readonly ExecutionStepProjection[]): {
  tone: ExecutionProjectionTone
  label: string
} {
  const tones = new Set(steps.map((step) => step.statusTone))
  if (tones.has('failure')) return { tone: 'failure', label: 'Failed' }
  if (tones.has('attention')) return { tone: 'attention', label: 'Needs attention' }
  if (tones.has('waiting')) return { tone: 'waiting', label: 'Waiting' }
  if (tones.has('active')) return { tone: 'active', label: 'Running' }
  const dormant = steps.some((step) => step.activationState === 'dormant')
  if (tones.has('pending') || dormant) return { tone: 'pending', label: 'Planned' }
  if (tones.has('success')) return { tone: 'success', label: 'Complete' }
  return { tone: 'muted', label: 'Ended' }
}

function StepNode({
  step,
  selected,
  onSelect
}: {
  step: ExecutionStepProjection
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const isCurrent = step.stackPosition === 'current'
  return (
    <li className="execution-map-node-item">
      <button
        type="button"
        className={`execution-map-node tone-${step.statusTone} ${selected ? 'is-selected' : ''}`}
        onClick={onSelect}
        aria-pressed={selected}
        aria-current={isCurrent ? 'step' : undefined}
        data-step-id={step.stepId}
        data-step-activation-id={step.activationId ?? undefined}
      >
        <span className="execution-map-node-header">
          <span className="execution-map-node-glyph" aria-hidden="true">
            <StepKindGlyph kind={step.step.kind} />
          </span>
          <span className="execution-map-node-heading">
            <span className="execution-map-node-kind">
              {executionStepKindLabel(step.step.kind)}
              {step.isRuntimeAppended && (
                <span className="execution-runtime-badge">Added during run</span>
              )}
            </span>
            <span className="execution-map-node-title">{step.step.title}</span>
          </span>
          <span className={`execution-status-token tone-${step.statusTone}`}>
            {step.statusLabel}
          </span>
        </span>
        {step.statusTone === 'active' && (
          <span className="execution-map-node-meter" aria-hidden="true">
            <span />
          </span>
        )}
        <span className="execution-map-node-objective">{step.step.objective}</span>
        {step.dependencies.length > 0 && (
          <span className="execution-map-node-dependencies">
            {step.dependencies.map((dependency) => (
              <span key={dependency.edgeId}>{dependency.label}</span>
            ))}
          </span>
        )}
        {step.blocker && (
          <span className={`execution-map-node-note tone-${step.statusTone}`}>{step.blocker}</span>
        )}
        <span className="execution-map-node-footer">
          <span>{effectLabel(step.step.effect)}</span>
          {step.attempts.length > 0 && (
            <span>
              {step.attempts.length} attempt{step.attempts.length === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}

function PortList({
  title,
  ports
}: {
  title: string
  ports: ExecutionStepDefinition['inputs']
}): JSX.Element | null {
  if (!ports?.length) return null
  return (
    <section className="execution-map-inspector-section">
      <h3>{title}</h3>
      <ul className="execution-map-inspector-list">
        {ports.map((port) => (
          <li key={port.name}>
            <code>{port.name}</code>
            <span>{port.required ? 'Required' : 'Optional'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StepInspector({
  step,
  onOpenThread
}: {
  step: ExecutionStepProjection
  onOpenThread?: ExecutionMapViewProps['onOpenThread']
}): JSX.Element {
  const threadRef = step.latestAttempt?.result?.threadRef
  return (
    <aside className="execution-map-inspector" aria-label={`Details for ${step.step.title}`}>
      <header className="execution-map-inspector-header">
        <span>{executionStepKindLabel(step.step.kind)}</span>
        <h2>{step.step.title}</h2>
        <span className={`execution-status-token tone-${step.statusTone}`}>{step.statusLabel}</span>
      </header>

      <p className="execution-map-inspector-objective">{step.step.objective}</p>
      {step.blocker && (
        <div className={`execution-map-inspector-note tone-${step.statusTone}`} role="note">
          <strong>{step.statusTone === 'muted' ? 'Why this ended' : 'Blocker'}</strong>
          <span>{step.blocker}</span>
        </div>
      )}

      {step.dependencies.length > 0 && (
        <section className="execution-map-inspector-section">
          <h3>Dependencies</h3>
          <ul className="execution-map-inspector-list">
            {step.dependencies.map((dependency) => (
              <li key={dependency.edgeId}>
                <span>{dependency.label}</span>
                <span>{dependency.kind === 'control' ? 'Success gate' : 'Data binding'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PortList title="Inputs" ports={step.step.inputs} />
      <PortList title="Outputs" ports={step.step.outputs} />

      <section className="execution-map-inspector-section">
        <h3>Authority</h3>
        <dl className="execution-map-inspector-facts">
          <div>
            <dt>Effect</dt>
            <dd>{effectLabel(step.step.effect)}</dd>
          </div>
          <div>
            <dt>Permission request</dt>
            <dd>{step.step.permissionRequestRef?.referenceId ?? 'Run ceiling'}</dd>
          </div>
          {step.step.permissionRequestRef?.authorityDigest && (
            <div>
              <dt>Authority digest</dt>
              <dd>
                <code>{step.step.permissionRequestRef.authorityDigest}</code>
              </dd>
            </div>
          )}
        </dl>
      </section>

      {step.attempts.length > 0 && (
        <section className="execution-map-inspector-section">
          <h3>Attempts</h3>
          <ol className="execution-map-attempts">
            {step.attempts.map((attempt) => (
              <li key={attempt.id}>
                <span>Attempt {attempt.ordinal}</span>
                <span>{attemptStateLabel(attempt.state)}</span>
                {attempt.error && (
                  <span className="execution-map-attempt-error">{attempt.error}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {step.artifactRefs.length > 0 && (
        <section className="execution-map-inspector-section">
          <h3>Artifacts</h3>
          <ul className="execution-map-inspector-list">
            {step.artifactRefs.map((artifact) => (
              <li key={artifact.id}>
                <span>{artifactKindLabel(artifact.kind)}</span>
                <code title={artifact.uri}>{artifact.uri ?? artifact.id}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {threadRef && onOpenThread && (
        <button
          type="button"
          className="execution-map-open-thread"
          onClick={() => onOpenThread(threadRef)}
        >
          Open thread
        </button>
      )}
    </aside>
  )
}

export function ExecutionMapView({
  projection,
  selectedStepId,
  onSelectStep,
  onBack,
  onOpenThread,
  onSaveGraph,
  onCancelRun,
  onResumeRun
}: ExecutionMapViewProps): JSX.Element {
  const [internalSelectedStepId, setInternalSelectedStepId] = useState<string | null>(null)
  const mapRef = useRef<HTMLElement>(null)
  useEffect(() => {
    mapRef.current?.focus()
  }, [projection?.runId])
  const selectedStep = useMemo(() => {
    if (!projection) return null
    const preferredId = selectedStepId ?? internalSelectedStepId
    return (
      projection.orderedSteps.find((step) => step.stepId === preferredId) ??
      projection.orderedSteps.find((step) => step.stackPosition === 'current') ??
      projection.orderedSteps[0] ??
      null
    )
  }, [internalSelectedStepId, projection, selectedStepId])

  if (!projection) {
    return (
      <main
        ref={mapRef}
        className="execution-map-view is-empty"
        aria-label="Execution Map"
        tabIndex={-1}
      >
        {onBack && (
          <button type="button" className="execution-map-back" onClick={onBack}>
            Back
          </button>
        )}
        <div className="execution-map-empty-state">
          <h1>Execution unavailable</h1>
          <p>This execution may have finished or been removed.</p>
        </div>
      </main>
    )
  }

  const handleSelect = (stepId: string): void => {
    setInternalSelectedStepId(stepId)
    onSelectStep?.(stepId)
  }
  const progress =
    projection.totalStepCount > 0
      ? Math.round((projection.completedStepCount / projection.totalStepCount) * 100)
      : 0

  return (
    <main
      ref={mapRef}
      className="execution-map-view"
      aria-label={`${projection.title} Execution Map`}
      data-execution-run-id={projection.runId}
      tabIndex={-1}
    >
      <header className="execution-map-header">
        <span className="execution-map-header-leading">
          {onBack && (
            <button type="button" className="execution-map-back" onClick={onBack}>
              Back
            </button>
          )}
          <span>
            <span className="execution-map-kicker">Execution Map</span>
            <h1>{projection.title}</h1>
          </span>
        </span>
        <span className="execution-map-header-actions">
          <span className={`execution-status-token tone-${projection.runStatusTone}`}>
            {projection.runStatusLabel}
          </span>
          {onSaveGraph && (
            <button
              type="button"
              className="execution-map-save-workflow"
              onClick={() => onSaveGraph(projection.runId)}
            >
              Save graph
            </button>
          )}
          {onResumeRun && projection.runState === 'requires_action' && (
            <button
              type="button"
              className="execution-map-resume-run"
              onClick={() => onResumeRun(projection.runId)}
            >
              Resume execution
            </button>
          )}
          {onCancelRun &&
            projection.runState !== 'succeeded' &&
            projection.runState !== 'failed' &&
            projection.runState !== 'cancelled' && (
              <button
                type="button"
                className="execution-map-cancel-run"
                onClick={() => onCancelRun(projection.runId)}
              >
                Cancel execution
              </button>
            )}
        </span>
      </header>

      <div className="execution-map-progress-meta">
        <span>
          {projection.completedStepCount} of {projection.totalStepCount} steps complete
        </span>
        <div
          className="execution-map-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label={`${progress}% complete`}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>

      <span className="execution-visually-hidden" role="status" aria-live="polite">
        {projection.liveSummary}
      </span>

      {projection.issues.length > 0 && (
        <div className="execution-map-issues" role="alert">
          {projection.issues.join(' ')}
        </div>
      )}

      <div className="execution-map-body">
        <ol className="execution-map-stages" aria-label="Topological execution stages">
          {projection.stages.map((stage) => {
            const rollup = stageRollup(stage.steps)
            const doneCount = stage.steps.filter((step) => step.statusTone === 'success').length
            return (
              <li key={stage.index} className={`execution-map-stage tone-${rollup.tone}`}>
                <section aria-labelledby={`execution-map-${projection.runId}-stage-${stage.index}`}>
                  <header className="execution-map-stage-header">
                    <h2 id={`execution-map-${projection.runId}-stage-${stage.index}`}>
                      {stage.label}
                    </h2>
                    {stage.steps.length > 1 && (
                      <span className="execution-map-stage-count">
                        {doneCount} of {stage.steps.length} done
                      </span>
                    )}
                    <span
                      className={`execution-status-token tone-${rollup.tone} execution-map-stage-status`}
                    >
                      {rollup.label}
                    </span>
                  </header>
                  <ol className="execution-map-stage-steps">
                    {stage.steps.map((step) => (
                      <StepNode
                        key={step.stepId}
                        step={step}
                        selected={selectedStep?.stepId === step.stepId}
                        onSelect={() => handleSelect(step.stepId)}
                      />
                    ))}
                  </ol>
                </section>
              </li>
            )
          })}
        </ol>

        {selectedStep && <StepInspector step={selectedStep} onOpenThread={onOpenThread} />}
      </div>
    </main>
  )
}
