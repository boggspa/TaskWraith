import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProviderId } from '../../../main/store/types'
import {
  executionGraphGhostCellStates,
  executionGraphGhostCounts,
  type ExecutionGhostCardView
} from '../../../shared/executionGraphGhost'
import { ExecutionGhostStrip } from './ExecutionGhostStrip'
import { ExecutionLiveCard } from './ExecutionLiveCard'

const steps = [
  { id: 's1', kind: 'solo_agent', title: 'Scout 1' },
  { id: 's2', kind: 'solo_agent', title: 'Scout 2' },
  { id: 'j', kind: 'join', title: 'Join' },
  { id: 'g', kind: 'human_gate', title: 'Approve' },
  { id: 'o', kind: 'output', title: 'Publish' }
]

function view(
  activations: { stepId: string; state: string }[],
  state: string
): ExecutionGhostCardView {
  const cells = executionGraphGhostCellStates({ steps, activations })
  return {
    executionId: 'exec-1',
    title: 'UltraTask · compare CLIs',
    seatId: 'antigravity:gemini-3.1-pro',
    state,
    settled: ['succeeded', 'failed', 'cancelled'].includes(state),
    cells,
    counts: executionGraphGhostCounts(cells)
  }
}

describe('ExecutionGhostStrip', () => {
  it('draws one cell per work-bearing step, in topology order', () => {
    const cells = executionGraphGhostCellStates({
      steps,
      activations: [
        { stepId: 's1', state: 'succeeded' },
        { stepId: 's2', state: 'running' }
      ]
    })
    const html = renderToStaticMarkup(<ExecutionGhostStrip cells={cells} />)
    const rendered = html.match(/execution-ghost-cell status-([a-z_]+)/g) || []
    expect(rendered).toEqual([
      'execution-ghost-cell status-completed',
      'execution-ghost-cell status-working',
      'execution-ghost-cell status-proposed'
    ])
  })

  // The label is the whole point for anyone not reading the picture.
  it('labels the strip with the counts', () => {
    const cells = executionGraphGhostCellStates({
      steps,
      activations: [{ stepId: 's1', state: 'succeeded' }]
    })
    expect(renderToStaticMarkup(<ExecutionGhostStrip cells={cells} />)).toContain(
      'aria-label="1 of 3 settled · 2 proposed"'
    )
  })

  it('distinguishes a durable queue claim from a provider-running step', () => {
    const cells = executionGraphGhostCellStates({
      steps,
      activations: [
        { stepId: 's1', state: 'queued' },
        { stepId: 's2', state: 'running' }
      ]
    })
    const html = renderToStaticMarkup(<ExecutionGhostStrip cells={cells} />)
    expect(html).toContain('status-queued')
    expect(html).toContain('status-working')
    expect(html).toContain('aria-label="0 of 3 settled · 1 running · 1 queued · 1 proposed"')
  })

  // An empty strip would read as "no agents have started yet" rather than
  // "this graph has none".
  it('renders nothing when a graph has no work-bearing steps', () => {
    const cells = executionGraphGhostCellStates({
      steps: [{ id: 'o', kind: 'output' }],
      activations: []
    })
    expect(renderToStaticMarkup(<ExecutionGhostStrip cells={cells} />)).toBe('')
  })
})

describe('ExecutionLiveCard', () => {
  const render = (v: ExecutionGhostCardView): string =>
    renderToStaticMarkup(
      <ExecutionLiveCard
        view={v}
        provider={'antigravity' as ProviderId}
        onOpenExecutionMap={() => {}}
        onCancelExecution={() => {}}
        onResumeExecution={() => {}}
      />
    )

  // The caller is named by the shared seat element — the same one the composer,
  // Task Complete and the seat-change row use — not by a bare model slug that
  // matches nothing else in the transcript.
  it('names its caller with the shared seat presentation element', () => {
    const html = render(view([{ stepId: 's1', state: 'running' }], 'running'))
    expect(html).toContain('seat-change-message is-inline')
    expect(html).toContain('execution-ghost-strip')
  })

  it('offers the map and the killswitch while work is live', () => {
    const html = render(view([{ stepId: 's1', state: 'running' }], 'running'))
    expect(html).toContain('Open map')
    expect(html).toContain('execution-live-card-cancel')
    expect(html).toContain('>Running<')
    expect(html).toContain('claude-workflow-card-pulse')
    expect(html).not.toMatch(/<button[^>]*claude-workflow-card-header[\s\S]*<button/)
  })

  it('labels queued work honestly without a provider-running pulse', () => {
    const html = render(view([{ stepId: 's1', state: 'queued' }], 'running'))
    expect(html).toContain('>Queued<')
    expect(html).toContain('1 queued')
    expect(html).not.toContain('claude-workflow-card-pulse')
    expect(html).toContain('class="determinate"')
  })

  // A paused graph is stopped. Animating it would claim work is happening when
  // the entire meaning of the state is that none is.
  it('does not animate a graph that is paused for a person', () => {
    const html = render(view([{ stepId: 'g', state: 'waiting_approval' }], 'requires_action'))
    expect(html).toContain('Needs attention')
    expect(html).toContain('status-needs_action')
    expect(html).toContain('paused — needs a decision')
    expect(html).not.toContain('indeterminate')
  })

  // Resume is the other half of the killswitch. It is offered ONLY while the
  // graph is paused: there is nothing to resume otherwise, and a control that
  // refuses on click teaches the reader nothing.
  it('offers Resume on a paused graph', () => {
    const html = render(view([{ stepId: 'g', state: 'waiting_approval' }], 'requires_action'))
    expect(html).toContain('execution-live-card-resume')
    expect(html).toContain('>Resume<')
  })

  it('wires map, resume, and cancel controls to their exact execution', () => {
    const calls: string[] = []
    const card = ExecutionLiveCard({
      view: view([{ stepId: 'g', state: 'waiting_approval' }], 'requires_action'),
      provider: 'antigravity' as ProviderId,
      onOpenExecutionMap: (executionId) => calls.push(`map:${executionId}`),
      onResumeExecution: (executionId) => calls.push(`resume:${executionId}`),
      onCancelExecution: (executionId) => calls.push(`cancel:${executionId}`)
    }) as any
    const actions = card.props.headerTrailing.props.children as any[]
    for (const className of [
      'execution-result-card-open-map',
      'execution-live-card-resume',
      'execution-live-card-cancel'
    ]) {
      actions.find((action) => action?.props?.className === className)?.props.onClick()
    }
    expect(calls).toEqual(['map:exec-1', 'resume:exec-1', 'cancel:exec-1'])
  })

  it('does not offer Resume while work is still in flight', () => {
    const html = render(view([{ stepId: 's1', state: 'running' }], 'running'))
    expect(html).not.toContain('execution-live-card-resume')
    expect(html).toContain('execution-live-card-cancel')
  })
})
