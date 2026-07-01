import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../../../main/store/types'
import { WorkflowCard } from './WorkflowCard'

function workflowActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'toolu_1',
    toolName: 'Workflow',
    displayName: 'Workflow',
    category: 'task',
    status: 'success',
    ...overrides
  }
}

describe('WorkflowCard', () => {
  it('renders the live stat strip from telemetry', () => {
    const html = renderToStaticMarkup(
      <WorkflowCard
        activity={workflowActivity({
          workflowSummary: {
            workflowName: 'howto-docs-audit',
            status: 'running',
            totalTokens: 278700,
            toolUses: 239,
            durationMs: 31000,
            agentCount: 14,
            lastToolName: 'audit-sweep'
          }
        })}
      />
    )
    expect(html).toContain('howto-docs-audit')
    expect(html).toContain('Running')
    expect(html).toContain('14 agents')
    expect(html).toContain('278.7k tokens')
    expect(html).toContain('239 tools')
    expect(html).toContain('audit-sweep')
    expect(html).toContain('status-running')
  })

  it('parses phases from the workflow script when telemetry lacks them', () => {
    const script = [
      'export const meta = {',
      "  name: 'scripted-name',",
      "  phases: [{ title: 'Audit' }, { title: 'Sweep' }],",
      '}'
    ].join('\n')
    const html = renderToStaticMarkup(
      <WorkflowCard
        activity={workflowActivity({
          parameters: { script },
          workflowSummary: { status: 'running' }
        })}
      />
    )
    expect(html).toContain('Audit')
    expect(html).toContain('Sweep')
    expect(html).toContain('Phases')
  })

  it('degrades gracefully with no telemetry and no script', () => {
    const html = renderToStaticMarkup(<WorkflowCard activity={workflowActivity()} />)
    expect(html).toContain('Workflow')
    expect(html).toContain('claude-workflow-card')
    // No agent count / tokens fabricated.
    expect(html).not.toContain('agents')
    expect(html).not.toContain('tokens')
  })

  it('shows a completed status and final summary affordance', () => {
    const html = renderToStaticMarkup(
      <WorkflowCard
        activity={workflowActivity({
          workflowSummary: {
            workflowName: 'done-flow',
            status: 'completed',
            totalTokens: 1000,
            summary: 'All phases complete.',
            outputFile: '/tmp/out.txt'
          }
        })}
      />
    )
    expect(html).toContain('Completed')
    expect(html).toContain('status-completed')
  })

  describe('provider identity', () => {
    it('keeps Claude on the bespoke glyph + global accent (no provider tint)', () => {
      const html = renderToStaticMarkup(
        <WorkflowCard
          activity={workflowActivity({ workflowSummary: { workflowName: 'wf', status: 'running' } })}
          provider="claude"
        />
      )
      expect(html).toContain('data-provider="claude"')
      // Claude must NOT get a provider-accent override (would recolour it amber).
      expect(html).not.toContain('--provider-accent')
      // Claude keeps the bespoke workflow glyph, not a seeded agent identicon.
      expect(html).not.toContain('agent-identity-icon')
    })

    it('renders a non-Claude provider with a seeded identicon + brand accent', () => {
      const html = renderToStaticMarkup(
        <WorkflowCard
          activity={workflowActivity({
            id: 'codex_tool_1',
            toolName: 'Task',
            workflowSummary: { provider: 'codex', workflowName: 'codex-run', status: 'running' }
          })}
          provider="codex"
        />
      )
      expect(html).toContain('data-provider="codex"')
      expect(html).toContain('--provider-accent')
      expect(html).toContain('var(--provider-codex-color')
      // Uses the design-assets agent identicon system for non-Claude glyphs.
      expect(html).toContain('agent-identity-icon')
    })

    it('prefers telemetry.provider over the provider prop', () => {
      const html = renderToStaticMarkup(
        <WorkflowCard
          activity={workflowActivity({ workflowSummary: { provider: 'kimi', status: 'running' } })}
          provider="claude"
        />
      )
      expect(html).toContain('data-provider="kimi"')
    })
  })
})
