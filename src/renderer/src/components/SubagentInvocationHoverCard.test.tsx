import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CloseoutSubagentDelegation } from '../lib/taskWraithCloseoutMessage'
import {
  buildSubagentInvocationView,
  SubagentInvocationHoverCardBody,
  SUBAGENT_INVOCATION_PROMPT_LIMIT
} from './SubagentInvocationHoverCard'

const row = (over: Partial<CloseoutSubagentDelegation> = {}): CloseoutSubagentDelegation => ({
  subThreadId: 'child-a',
  identitySeed: 'child-a',
  title: 'CAM7-market-v2',
  provider: 'mistral',
  parentProvider: 'claude',
  status: 'returned',
  promptPreview: 'Audit the market map tiles and fix the warp flags',
  ...over
})

describe('buildSubagentInvocationView', () => {
  it('reads the route the same way the close-out row does', () => {
    expect(buildSubagentInvocationView(row()).routeLabel).toBe('Claude → Mistral')
  })

  it('names only the worker when no caller provider was recorded', () => {
    expect(buildSubagentInvocationView(row({ parentProvider: undefined })).routeLabel).toBe(
      'Mistral'
    )
  })

  it('keeps one identity per sub-thread, seeded like every other surface', () => {
    // Same seed => same character on the invocation card, the return card and
    // the close-out row; a hover that renamed the agent would be a new bug.
    const first = buildSubagentInvocationView(row())
    const second = buildSubagentInvocationView(row({ title: 'renamed' }))
    expect(second.agentName).toBe(first.agentName)
    expect(second.agentKey).toBe(first.agentKey)
  })

  it('falls back to the agent name when the row carries no title', () => {
    const view = buildSubagentInvocationView(row({ title: '' }))
    expect(view.title).toBe(view.agentName)
  })

  it('truncates a long prompt and says so', () => {
    const view = buildSubagentInvocationView(
      row({ promptPreview: 'x'.repeat(SUBAGENT_INVOCATION_PROMPT_LIMIT + 50) })
    )
    expect(view.promptTruncated).toBe(true)
    expect(view.prompt.endsWith('…')).toBe(true)
    expect(view.prompt.length).toBeLessThanOrEqual(SUBAGENT_INVOCATION_PROMPT_LIMIT + 1)
  })

  it('leaves a short prompt whole', () => {
    const view = buildSubagentInvocationView(row())
    expect(view.promptTruncated).toBe(false)
    expect(view.prompt).toBe('Audit the market map tiles and fix the warp flags')
  })

  it('maps every status to a label a reader recognises', () => {
    const labels = (
      ['returned', 'completed', 'running', 'failed', 'cancelled', 'created', 'unknown'] as const
    ).map((status) => buildSubagentInvocationView(row({ status })).statusLabel)
    expect(labels).toEqual([
      'Returned',
      'Completed',
      'Active',
      'Failed',
      'Cancelled',
      'Created',
      'Pending'
    ])
  })
})

describe('SubagentInvocationHoverCardBody', () => {
  it('renders the invocation the row summarises', () => {
    const html = renderToStaticMarkup(
      <SubagentInvocationHoverCardBody view={buildSubagentInvocationView(row())} />
    )
    expect(html).toContain('Agent Invocation')
    expect(html).toContain('CAM7-market-v2')
    expect(html).toContain('Claude → Mistral')
    expect(html).toContain('Returned')
    expect(html).toContain('Audit the market map tiles')
    // Both ends of the route carry their provider mark.
    expect(html).toContain('data-provider-logo="claude"')
    expect(html).toContain('data-provider-logo="mistral"')
  })

  it('says so plainly when the invocation recorded no prompt', () => {
    const html = renderToStaticMarkup(
      <SubagentInvocationHoverCardBody
        view={buildSubagentInvocationView(row({ promptPreview: undefined }))}
      />
    )
    expect(html).toContain('recorded no prompt preview')
  })

  it('shows one mark when the caller provider is unknown', () => {
    const html = renderToStaticMarkup(
      <SubagentInvocationHoverCardBody
        view={buildSubagentInvocationView(row({ parentProvider: undefined }))}
      />
    )
    expect(html).not.toContain('data-provider-logo="claude"')
    expect(html).toContain('data-provider-logo="mistral"')
  })
})
