import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import type { CodexMultiAgentTelemetry } from '../../../shared/codexMultiAgent'
import { CodexMultiAgentCard } from './CodexMultiAgentCard'

function multiAgentActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'ma_1',
    toolName: 'codex_multi_agent',
    displayName: 'Codex Multi-agent',
    category: 'task',
    status: 'running',
    ...overrides
  }
}

const FULL_TELEMETRY: CodexMultiAgentTelemetry = {
  provider: 'codex',
  status: 'working',
  detailLevel: 'full',
  subagents: [
    {
      id: 'call_a',
      agentThreadId: 'thread-a',
      agentPath: '/root/audit_css',
      taskName: 'audit_css',
      status: 'completed'
    },
    {
      id: 'call_b',
      agentThreadId: 'thread-b',
      agentPath: '/root/audit_tests',
      taskName: 'audit_tests',
      status: 'working'
    }
  ],
  coordinationEvents: 1,
  lastCoordination: 'wait'
}

describe('CodexMultiAgentCard', () => {
  it('renders a fully observed working episode with subagent chips + codex identity', () => {
    const html = renderToStaticMarkup(
      <CodexMultiAgentCard activity={multiAgentActivity({ multiAgentSummary: FULL_TELEMETRY })} />
    )
    expect(html).toContain('Codex Multi-agent')
    expect(html).toContain('Working in parallel')
    expect(html).toContain('2 subagents')
    expect(html).toContain('audit_css')
    expect(html).toContain('audit_tests')
    expect(html).toContain('multi-agent-card-agent status-completed')
    expect(html).toContain('multi-agent-card-agent status-working')
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('agent-identity-icon')
    expect(html).toContain('var(--provider-codex-color')
    expect(html).toContain('waiting on subagents')
    // Real observed progress: 1 of 2 settled → determinate 50% meter.
    expect(html).toContain('determinate')
    expect(html).toContain('width:50%')
  })

  it('claims synthesis only when the synthesis phase was actually observed', () => {
    const synthesized = renderToStaticMarkup(
      <CodexMultiAgentCard
        activity={multiAgentActivity({
          status: 'success',
          multiAgentSummary: {
            ...FULL_TELEMETRY,
            status: 'completed',
            synthesized: true,
            subagents: FULL_TELEMETRY.subagents!.map((agent) => ({
              ...agent,
              status: 'completed' as const
            })),
            durationMs: 12000,
            totalTokens: 29070
          }
        })}
      />
    )
    expect(synthesized).toContain('synthesized their results')
    expect(synthesized).toContain('12s')
    expect(synthesized).toContain('29.1k tokens')
    expect(synthesized).toContain('status-completed')

    const unsynthesized = renderToStaticMarkup(
      <CodexMultiAgentCard
        activity={multiAgentActivity({
          status: 'success',
          multiAgentSummary: { ...FULL_TELEMETRY, status: 'completed', synthesized: false }
        })}
      />
    )
    expect(unsynthesized).not.toContain('synthesized their results')
  })

  it('renders the detected-only level honestly: no counts, no chips, indeterminate meter', () => {
    const html = renderToStaticMarkup(
      <CodexMultiAgentCard
        activity={multiAgentActivity({
          multiAgentSummary: {
            provider: 'codex',
            status: 'delegating',
            detailLevel: 'detected',
            coordinationEvents: 1,
            lastCoordination: 'wait'
          }
        })}
      />
    )
    expect(html).toContain('Parallel delegation detected')
    expect(html).toContain('details are not available')
    expect(html).not.toContain('subagent<') // no count segment in the meta line
    expect(html).not.toContain('multi-agent-card-agent status-')
    expect(html).toContain('class="indeterminate"')
    expect(html).not.toContain('class="determinate"') // meter never fabricates progress
  })

  it('never fabricates a subagent count at any level', () => {
    const html = renderToStaticMarkup(
      <CodexMultiAgentCard
        activity={multiAgentActivity({
          multiAgentSummary: { provider: 'codex', status: 'working', detailLevel: 'detected' }
        })}
      />
    )
    expect(html).not.toMatch(/\d+ subagent/)
  })

  it('never exposes internal transport identifiers or encrypted payloads', () => {
    const html = renderToStaticMarkup(
      <CodexMultiAgentCard activity={multiAgentActivity({ multiAgentSummary: FULL_TELEMETRY })} />
    )
    expect(html).not.toContain('multi_agents_v2')
    expect(html).not.toContain('responses_multi_agent')
    expect(html.toLowerCase()).not.toContain('encrypted')
    // Not titled "Workflow" — that name belongs to Claude's feature.
    expect(html).not.toContain('Workflow')
  })

  it('surfaces failure + interruption states', () => {
    const failed = renderToStaticMarkup(
      <CodexMultiAgentCard
        activity={multiAgentActivity({
          multiAgentSummary: {
            provider: 'codex',
            status: 'failed',
            detailLevel: 'full',
            subagents: [],
            error: 'provider stream ended unexpectedly'
          }
        })}
      />
    )
    expect(failed).toContain('Failed')
    expect(failed).toContain('status-failed')

    const interrupted = renderToStaticMarkup(
      <CodexMultiAgentCard
        activity={multiAgentActivity({
          multiAgentSummary: { provider: 'codex', status: 'interrupted', detailLevel: 'full' }
        })}
      />
    )
    expect(interrupted).toContain('Interrupted')
    expect(interrupted).toContain('status-interrupted')
  })

  it('shows synthesizing as a live state with its own current line', () => {
    const html = renderToStaticMarkup(
      <CodexMultiAgentCard
        activity={multiAgentActivity({
          multiAgentSummary: {
            ...FULL_TELEMETRY,
            status: 'synthesizing',
            subagents: FULL_TELEMETRY.subagents!.map((agent) => ({
              ...agent,
              status: 'completed' as const
            }))
          }
        })}
      />
    )
    expect(html).toContain('Synthesizing')
    expect(html).toContain('synthesizing results')
    expect(html).toContain('claude-workflow-card-pulse')
  })
})
