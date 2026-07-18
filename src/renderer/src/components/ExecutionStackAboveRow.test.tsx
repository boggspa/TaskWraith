import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  EffectiveExecutionTopology,
  ExecutionStepDefinition,
  StepActivation
} from '../../../main/executionGraph/ExecutionGraphModel'
import { buildExecutionGraphProjection } from '../lib/executionGraphProjection'
import { ExecutionStackAboveRow } from './ExecutionStackAboveRow'

const at = '2026-07-18T10:00:00.000Z'

function step(id: string): ExecutionStepDefinition {
  return {
    id,
    title: id.charAt(0).toUpperCase() + id.slice(1),
    objective: `Complete ${id}`,
    effect: 'read_only',
    retry: { maxAttempts: 1 },
    kind: 'solo_agent',
    agent: { provider: 'codex', session: { mode: 'fresh' } }
  }
}

function activation(stepId: string, state: StepActivation['state']): StepActivation {
  return {
    id: `activation-${stepId}`,
    stepId,
    state,
    createdAt: at,
    updatedAt: at,
    attemptIds: []
  }
}

function projection(state: 'running' | 'succeeded' = 'running') {
  const topology: EffectiveExecutionTopology = {
    steps: [step('implement'), step('verify'), step('summarise')],
    edges: [
      {
        id: 'implement-verify',
        kind: 'control',
        fromStepId: 'implement',
        toStepId: 'verify',
        outcome: 'success'
      },
      {
        id: 'verify-summarise',
        kind: 'control',
        fromStepId: 'verify',
        toStepId: 'summarise',
        outcome: 'success'
      }
    ]
  }
  return buildExecutionGraphProjection({
    runId: 'execution-1',
    runState: state,
    title: 'Ship TaskWraith',
    topology,
    activations:
      state === 'succeeded'
        ? [
            activation('implement', 'succeeded'),
            activation('verify', 'succeeded'),
            activation('summarise', 'succeeded')
          ]
        : [
            activation('implement', 'running'),
            activation('verify', 'dormant'),
            activation('summarise', 'dormant')
          ],
    runtimeAppendedStepIds: ['summarise']
  })
}

describe('ExecutionStackAboveRow', () => {
  const noop = (): void => {}

  it('renders the Current/Next/Then operational stack with durable activation identities', () => {
    const html = renderToStaticMarkup(
      <ExecutionStackAboveRow
        projection={projection()}
        onOpenMap={noop}
        onAddToStack={noop}
        onSaveAsWorkflow={noop}
        onCancelStep={noop}
      />
    )

    expect(html).toContain('aria-label="Ship TaskWraith Stack"')
    expect(html).toContain('data-execution-run-id="execution-1"')
    expect(html).toContain('data-step-activation-id="activation-implement"')
    expect(html).toContain('aria-current="step"')
    expect(html).toContain('Current')
    expect(html).toContain('Next')
    expect(html).toContain('Then')
    expect(html).toContain('Waiting for Implement')
    expect(html).toContain('Added during run')
    expect(html).toContain('role="status"')
  })

  it('offers native graph actions and cancellation only for dormant activations', () => {
    const html = renderToStaticMarkup(
      <ExecutionStackAboveRow
        projection={projection()}
        onOpenMap={noop}
        onAddToStack={noop}
        onSaveAsWorkflow={noop}
        onCancelStep={noop}
      />
    )

    expect(html).toContain('Add to Stack')
    expect(html).toContain('Save as Workflow')
    expect(html).toContain('Open map')
    expect(html.match(/Cancel planned step/g)).toHaveLength(2)
    expect(html).not.toContain('draggable=')
    expect(html).not.toContain('contenteditable=')
    expect(html).not.toMatch(/>Move</)
    expect(html).not.toMatch(/>Edit</)
    expect(html).not.toMatch(/>Delete</)
    expect(html).not.toMatch(/>Steer</)
  })

  it('returns no composer row after the Stack has no pending work', () => {
    expect(
      renderToStaticMarkup(
        <ExecutionStackAboveRow projection={projection('succeeded')} onOpenMap={noop} />
      )
    ).toBe('')
  })
})
