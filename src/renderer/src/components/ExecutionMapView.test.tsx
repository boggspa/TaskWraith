import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  EffectiveExecutionTopology,
  ExecutionStepDefinition,
  StepActivation,
  StepAttempt
} from '../../../main/executionGraph/ExecutionGraphModel'
import { buildExecutionGraphProjection } from '../lib/executionGraphProjection'
import { ExecutionMapView } from './ExecutionMapView'

const at = '2026-07-18T10:00:00.000Z'

function common(id: string) {
  return {
    id,
    title: id.charAt(0).toUpperCase() + id.slice(1),
    objective: `Complete ${id} with evidence`,
    effect: 'read_only' as const,
    retry: { maxAttempts: 2 }
  }
}

function activation(
  stepId: string,
  state: StepActivation['state'],
  reason?: string
): StepActivation {
  return {
    id: `activation-${stepId}`,
    stepId,
    state,
    createdAt: at,
    updatedAt: at,
    attemptIds: [],
    reason
  }
}

function fixture() {
  const steps: ExecutionStepDefinition[] = [
    {
      ...common('recon'),
      kind: 'solo_agent',
      outputs: [{ name: 'findings', required: true }],
      agent: { provider: 'codex', session: { mode: 'fresh' } }
    },
    {
      ...common('draft'),
      kind: 'solo_agent',
      inputs: [{ name: 'findings', required: true }],
      outputs: [{ name: 'patch' }],
      permissionRequestRef: {
        schemaVersion: 1,
        referenceId: 'request-read',
        ceilingReferenceId: 'ceiling-1',
        authorityDigest: 'authority-digest-1'
      },
      agent: { provider: 'claude', session: { mode: 'fresh' } }
    },
    {
      ...common('review'),
      kind: 'human_gate',
      gate: { mode: 'approval', prompt: 'Approve the proposed patch?' }
    },
    {
      ...common('join'),
      kind: 'join',
      join: { mode: 'all' }
    }
  ]
  const topology: EffectiveExecutionTopology = {
    steps,
    edges: [
      {
        id: 'recon-draft-data',
        kind: 'data',
        from: { stepId: 'recon', port: 'findings' },
        to: { stepId: 'draft', port: 'findings' }
      },
      {
        id: 'recon-review',
        kind: 'control',
        fromStepId: 'recon',
        toStepId: 'review',
        outcome: 'success'
      },
      {
        id: 'draft-join',
        kind: 'control',
        fromStepId: 'draft',
        toStepId: 'join',
        outcome: 'success'
      },
      {
        id: 'review-join',
        kind: 'control',
        fromStepId: 'review',
        toStepId: 'join',
        outcome: 'success'
      }
    ]
  }
  const attempts: StepAttempt[] = [
    {
      id: 'attempt-draft',
      activationId: 'activation-draft',
      stepId: 'draft',
      ordinal: 1,
      state: 'running',
      createdAt: at,
      updatedAt: at,
      result: {
        schemaVersion: 1,
        trust: 'untrusted_agent_output',
        artifactRefs: [
          {
            schemaVersion: 1,
            id: 'patch-artifact',
            kind: 'diff',
            uri: 'file:///workspace/taskwraith.patch',
            createdByAttemptId: 'attempt-draft',
            trust: 'untrusted_agent_output'
          }
        ],
        threadRef: 'chat-draft'
      }
    }
  ]
  return buildExecutionGraphProjection({
    runId: 'execution-map-1',
    runState: 'waiting',
    title: 'Branching release check',
    topology,
    activations: [
      activation('recon', 'succeeded'),
      activation('draft', 'running'),
      activation('review', 'waiting_approval', 'Security owner approval required'),
      activation('join', 'dormant')
    ],
    attempts,
    runtimeAppendedStepIds: ['join']
  })
}

describe('ExecutionMapView', () => {
  const noop = (): void => {}

  it('renders a semantic topological stage map with visible dependencies and blockers', () => {
    const html = renderToStaticMarkup(
      <ExecutionMapView
        projection={fixture()}
        selectedStepId="draft"
        onBack={noop}
        onOpenThread={noop}
        onSaveGraph={noop}
      />
    )

    expect(html).toContain('aria-label="Branching release check Execution Map"')
    expect(html).toContain('aria-label="Topological execution stages"')
    expect(html).toContain('Stage 1')
    expect(html).toContain('Stage 2')
    expect(html).toContain('Stage 3')
    expect(html).toContain('Receives findings from Recon.findings')
    expect(html).toContain('After Recon succeeds')
    expect(html).toContain('Security owner approval required')
    expect(html).toContain('Added during run')
    expect(html).toContain('aria-current="step"')
    expect(html).toContain('role="status"')
    expect(html).toContain('role="progressbar"')
  })

  it('shows attempts, ports, authority, artifacts, and the linked thread in the inspector', () => {
    const html = renderToStaticMarkup(
      <ExecutionMapView projection={fixture()} selectedStepId="draft" onOpenThread={noop} />
    )

    expect(html).toContain('aria-label="Details for Draft"')
    expect(html).toContain('<h3>Inputs</h3>')
    expect(html).toContain('<h3>Outputs</h3>')
    expect(html).toContain('<h3>Authority</h3>')
    expect(html).toContain('authority-digest-1')
    expect(html).toContain('<h3>Attempts</h3>')
    expect(html).toContain('Attempt 1')
    expect(html).toContain('<span>Running</span>')
    expect(html).toContain('<h3>Artifacts</h3>')
    expect(html).toContain('<span>Diff</span>')
    expect(html).toContain('file:///workspace/taskwraith.patch')
    expect(html).toContain('Open thread')
  })

  it('labels an attention-needing step with a blocker note', () => {
    const html = renderToStaticMarkup(
      <ExecutionMapView projection={fixture()} selectedStepId="review" onOpenThread={noop} />
    )

    expect(html).toContain('>Blocker<')
    expect(html).toContain('Security owner approval required')
  })

  it('explains a terminal muted step without labelling it a blocker', () => {
    const steps: ExecutionStepDefinition[] = [
      {
        ...common('halted'),
        kind: 'solo_agent',
        agent: { provider: 'codex', session: { mode: 'fresh' } }
      }
    ]
    const projection = buildExecutionGraphProjection({
      runId: 'execution-map-2',
      runState: 'cancelled',
      title: 'Closed with its owner',
      topology: { steps, edges: [] },
      activations: [activation('halted', 'cancelled', 'Cancelled with the owning parent run.')]
    })

    const html = renderToStaticMarkup(
      <ExecutionMapView projection={projection} selectedStepId="halted" />
    )

    expect(html).toContain('Why this ended')
    expect(html).toContain('Cancelled with the owning parent run.')
    expect(html).not.toContain('>Blocker<')
  })

  it('contains native inspection controls but no faux graph editing surface', () => {
    const html = renderToStaticMarkup(<ExecutionMapView projection={fixture()} />)

    expect(html).toContain('type="button"')
    expect(html).not.toContain('draggable=')
    expect(html).not.toContain('contenteditable=')
    expect(html).not.toContain('<canvas')
    expect(html).not.toMatch(/>Reorder</)
    expect(html).not.toMatch(/>Connect</)
  })

  it('provides a recoverable empty state', () => {
    const html = renderToStaticMarkup(<ExecutionMapView projection={null} onBack={noop} />)
    expect(html).toContain('Execution unavailable')
    expect(html).toContain('>Back</button>')
  })
})
