import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ActivityStack,
  buildActivityWorkbenchDiffSummary,
  buildTimelineItems,
  buildTimelineSegments,
  LIVE_THINKING_TRACE_RENDER_CHAR_CAP,
  liveThinkingTraceRenderBody,
  shouldDebounceActivityTimelineCollapse,
  sliceTimelineSegmentsToTail
} from './ActivityStack'
import type { ChatRecord, EnsembleParticipant, ToolActivity } from '../../../main/store/types'

function makeEnsembleYieldActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-yield-1',
    toolName: 'mcp_TaskWraith_ensemble_yield',
    displayName: 'Captain K yielding to Gems',
    category: 'task',
    status: 'success',
    startedAt: '2026-05-26T17:00:00Z',
    endedAt: '2026-05-26T17:00:01Z',
    durationMs: 1000,
    parameters: { target: 'Gems' },
    ...overrides
  }
}

function makeEnsembleChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'codex',
    title: 'Ensemble run',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 6,
      participants
    }
  }
}

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-identity',
    scope: 'workspace',
    provider: 'claude',
    title: 'Agent thread',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function makeParticipant(overrides: Partial<EnsembleParticipant>): EnsembleParticipant {
  return {
    id: 'ensemble-gemini',
    provider: 'gemini',
    enabled: true,
    role: 'Gems',
    instructions: '',
    order: 1,
    ...overrides
  }
}

describe('ActivityStack ensemble_yield rendering', () => {
  it('humanizes the Codex-style mcp_TaskWraith_ensemble_yield tool name', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeEnsembleYieldActivity()]} provider="codex" />
    )

    expect(html).toContain('yielding to')
    expect(html).toContain('@Gems')
    expect(html).not.toContain('mcp_TaskWraith_ensemble_yield')
  })

  it('humanizes the Claude-style mcp__TaskWraith__ensemble_yield tool name', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeEnsembleYieldActivity({
            id: 'tool-yield-2',
            toolName: 'mcp__TaskWraith__ensemble_yield'
          })
        ]}
        provider="claude"
      />
    )

    expect(html).toContain('yielding to')
    expect(html).toContain('@Gems')
    expect(html).not.toContain('mcp__TaskWraith__ensemble_yield')
  })

  it('humanizes the bare ensemble_yield tool name', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeEnsembleYieldActivity({
            id: 'tool-yield-3',
            toolName: 'ensemble_yield'
          })
        ]}
        provider="gemini"
      />
    )

    expect(html.toLowerCase()).toContain('yielding to')
    expect(html).toContain('@Gems')
  })

  it('tints the target chip with the resolved participant provider when chat carries the roster', () => {
    const chat = makeEnsembleChat([
      makeParticipant({ id: 'ensemble-gemini', provider: 'gemini', role: 'Gems', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Captain K', order: 2 })
    ])

    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeEnsembleYieldActivity()]} provider="codex" chat={chat} />
    )

    expect(html).toContain('activity-yield-target')
    expect(html).toContain('provider-gemini')
    expect(html).toContain('@Gems')
  })

  it('falls back to humanized label even when displayName is the raw tool name (defensive bypass)', () => {
    // Simulates an upstream path that constructs the activity without
    // running it through the humanization helper — `displayName` is left
    // as the raw tool name. The renderer should still produce a friendly
    // label by reading `parameters.target` directly via
    // `renderEnsembleYieldTitle`, never surfacing the raw name.
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeEnsembleYieldActivity({
            id: 'tool-yield-raw',
            toolName: 'mcp_TaskWraith_ensemble_yield',
            displayName: 'mcp_TaskWraith_ensemble_yield'
          })
        ]}
        provider="codex"
      />
    )

    expect(html).toContain('Yielding to')
    expect(html).toContain('@Gems')
    expect(html).not.toContain('mcp_TaskWraith_ensemble_yield')
  })

  it('does not surface a raw tool name when filePath candidate fields (target) resolve to the yield target', () => {
    // `getFilePathFromActivity` lists `target` among its candidate
    // fields, so an ensemble_yield activity always presents a non-empty
    // `activityFilePath` equal to the target name. The legacy file-path
    // render branch in `ActivityTitle` would otherwise emit
    // `<displayName-or-toolName> <strong>{target}</strong>` — i.e. the
    // exact "raw tool name + bold target" shape the bug report calls
    // out. The ensemble_yield short-circuit must run first.
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeEnsembleYieldActivity({
            displayName: '',
            parameters: { target: 'Captain K' }
          })
        ]}
        provider="codex"
      />
    )

    expect(html).toContain('Yielding to')
    expect(html).toContain('@Captain K')
    expect(html).not.toMatch(/<strong[^>]*>Captain K<\/strong>/)
    expect(html).not.toContain('mcp_TaskWraith_ensemble_yield')
  })
})

function makeWriteActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-write-1',
    toolName: 'write_file',
    displayName: 'write_file',
    category: 'write',
    status: 'success',
    startedAt: '2026-05-26T17:00:00Z',
    endedAt: '2026-05-26T17:00:00.250Z',
    durationMs: 250,
    parameters: { file_path: '/repo/src/foo.ts', content: 'hello' },
    resultSummary: 'wrote 1 line',
    ...overrides
  }
}

function makeReadActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-read-1',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    startedAt: '2026-05-26T17:00:00Z',
    endedAt: '2026-05-26T17:00:00.250Z',
    durationMs: 250,
    parameters: { file_path: '/repo/src/foo.ts' },
    resultSummary: 'read file',
    ...overrides
  }
}

function makeThinkingActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-thinking-1',
    toolName: 'codex_thinking',
    displayName: 'Thinking',
    category: 'task',
    status: 'success',
    startedAt: '2026-05-26T17:00:00Z',
    endedAt: '2026-05-26T17:00:00.250Z',
    durationMs: 250,
    resultSummary: 'I am checking the request and keeping the answer concise.',
    ...overrides
  }
}

function makeWorkflowActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'toolu_wf_1',
    toolName: 'Workflow',
    displayName: 'Workflow',
    category: 'task',
    status: 'success',
    startedAt: '2026-05-26T17:00:00Z',
    endedAt: '2026-05-26T17:00:01Z',
    durationMs: 1000,
    parameters: { script: "export const meta = { name: 'x', phases: [{ title: 'Audit' }] }" },
    workflowSummary: { workflowName: 'howto-docs-audit', status: 'running', totalTokens: 278700 },
    ...overrides
  }
}

describe('ActivityStack workflow card', () => {
  it('renders the workflow card for a claude Workflow activity', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWorkflowActivity()]} provider="claude" />
    )
    expect(html).toContain('claude-workflow-card')
    expect(html).toContain('howto-docs-audit')
    expect(html).toContain('278.7k tokens')
  })

  it('renders the card for a NON-claude provider once it has workflow telemetry', () => {
    // Generalization: presence of workflowSummary lights the card up for any
    // provider, with its own identity (data-provider + seeded identicon).
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeWorkflowActivity({
            id: 'codex_wf_1',
            toolName: 'Task',
            workflowSummary: { provider: 'codex', workflowName: 'codex-run', status: 'running' }
          })
        ]}
        provider="codex"
      />
    )
    expect(html).toContain('claude-workflow-card')
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('agent-identity-icon')
  })

  it('does NOT render the card for a non-claude tool merely NAMED workflow (no telemetry)', () => {
    // The name-path stays Claude-pinned; without telemetry a non-claude tool
    // called "workflow" is just a normal tool row.
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeWorkflowActivity({
            workflowSummary: undefined,
            parameters: undefined
          })
        ]}
        provider="codex"
      />
    )
    expect(html).not.toContain('claude-workflow-card')
  })

  it('renders the card in compact density too', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWorkflowActivity()]} provider="claude" compactDensity />
    )
    expect(html).toContain('claude-workflow-card')
  })

  it('keeps the card inline rather than collapsing it into a compact group', () => {
    // Two terminal Workflow activities back-to-back must NOT merge into a
    // "used N tools" group — each is its own live card.
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeWorkflowActivity({ id: 'toolu_wf_1' }),
          makeWorkflowActivity({ id: 'toolu_wf_2' })
        ]}
        provider="claude"
      />
    )
    const cardCount = html.split('claude-workflow-card status-').length - 1
    expect(cardCount).toBe(2)
  })
})

describe('ActivityStack Codex review card', () => {
  function makeReviewActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
    return {
      id: 'rev_1',
      toolName: 'codex_review',
      displayName: 'Codex review',
      category: 'task',
      status: 'running',
      reviewSummary: { provider: 'codex', status: 'running', target: 'uncommitted changes' },
      ...overrides
    }
  }

  it('renders the review card for a codex_review activity with telemetry', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeReviewActivity()]} provider="codex" />
    )
    expect(html).toContain('review-card')
    expect(html).toContain('Codex Review')
    expect(html).toContain('uncommitted changes')
    expect(html).toContain('data-provider="codex"')
  })

  it('does not render a review card for a non-codex provider on name alone', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeReviewActivity({ reviewSummary: undefined })]}
        provider="claude"
      />
    )
    expect(html).not.toContain('review-card')
  })

  it('keeps the review card inline (not swept into a compact group)', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeReviewActivity({ id: 'rev_1', status: 'success' }),
          makeReviewActivity({ id: 'rev_2', status: 'success' })
        ]}
        provider="codex"
      />
    )
    expect(html.split('review-card').length - 1).toBe(2)
  })
})

describe('ActivityStack Codex Multi-agent card', () => {
  function makeMultiAgentActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
    return {
      id: 'ma_1',
      toolName: 'codex_multi_agent',
      displayName: 'Codex Multi-agent',
      category: 'task',
      status: 'running',
      multiAgentSummary: {
        provider: 'codex',
        status: 'working',
        detailLevel: 'full',
        subagents: [
          {
            id: 'call_a',
            agentThreadId: 'thread-a',
            agentPath: '/root/audit_css',
            taskName: 'audit_css',
            status: 'working'
          }
        ]
      },
      ...overrides
    }
  }

  it('renders the Multi-agent card for a codex_multi_agent activity with telemetry', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeMultiAgentActivity()]} provider="codex" />
    )
    expect(html).toContain('multi-agent-card')
    expect(html).toContain('Codex Multi-agent')
    expect(html).toContain('audit_css')
    expect(html).toContain('data-provider="codex"')
  })

  it('does not render a Multi-agent card for a non-codex provider on name alone', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeMultiAgentActivity({ multiAgentSummary: undefined })]}
        provider="claude"
      />
    )
    expect(html).not.toContain('multi-agent-card')
  })

  it('keeps the Multi-agent card inline (not swept into a compact group)', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeMultiAgentActivity({ id: 'ma_1', status: 'success' }),
          makeMultiAgentActivity({ id: 'ma_2', status: 'success' })
        ]}
        provider="codex"
      />
    )
    expect(html.split('multi-agent-card"').length - 1 + html.split('multi-agent-card ').length - 1).toBeGreaterThanOrEqual(2)
    expect(html).not.toContain('used 2 tools')
  })
})

describe('ActivityStack live activity viewport', () => {
  it('wraps settled tool stacks in the viewport when enabled', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWriteActivity()]} provider="codex" liveActivityViewport />
    )

    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('activity-timeline-live-inner')
    expect(html).toContain('data-active="false"')
    expect(html).toContain('activity-row')
  })

  it('keeps success-status thinking traces active when the transcript marks the row live', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeThinkingActivity({ toolName: 'kimi_thinking', displayName: 'Kimi thinking' })
        ]}
        provider="kimi"
        liveActivityViewport
        liveActivityViewportActive
      />
    )

    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('data-active="true"')
    expect(html).toContain('is-thinking-trace')
  })

  it('keeps the plain timeline when the viewport setting is disabled', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeWriteActivity()]}
        provider="codex"
        liveActivityViewport={false}
      />
    )

    expect(html).not.toContain('live-activity-viewport')
    expect(html).toContain('activity-row')
  })

  it('renders thinking traces inside the live viewport with the full action row', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeThinkingActivity()]}
        provider="codex"
        liveActivityViewport
        thinkingTraceActions={{
          messageId: 'tool-message-1',
          copiedId: 'tool-message-1:tool-thinking-1:thinking',
          pinned: true,
          thumbsVote: 'up',
          copy: () => undefined,
          onAddToPrompt: () => undefined,
          onTogglePin: () => undefined,
          onThumbsUp: () => undefined,
          onThumbsDown: () => undefined,
          onDelete: () => undefined,
          onOpenSideChat: () => undefined
        }}
      />
    )

    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('activity-progress-note-shell is-thinking-trace-shell')
    expect(html).toContain('message-actions-chip-button--thumbs-up is-active')
    expect(html).toContain('message-actions-chip-button--thumbs-down')
    expect(html).toContain('message-actions-chip-button--copy is-copied')
    expect(html).toContain('message-actions-chip-button--add-to-prompt')
    expect(html).toContain('message-actions-chip-button--pin is-pinned')
    expect(html).toContain('message-actions-chip-button--side-chat')
    expect(html).toContain('message-actions-chip-button--delete')
  })

  it('bounds collapsed live viewport rendering to the latest activity items', () => {
    const activities = Array.from({ length: 120 }, (_, index) =>
      makeWriteActivity({
        id: `tool-write-${index}`,
        status: 'running',
        endedAt: undefined,
        durationMs: undefined,
        parameters: { file_path: `/repo/src/file-${index}.ts`, content: 'hello' },
        resultSummary: `wrote file ${index}`
      })
    )

    const html = renderToStaticMarkup(
      <ActivityStack activities={activities} provider="codex" liveActivityViewport />
    )

    expect(html).toContain('40 earlier events hidden while collapsed.')
    expect(html).not.toContain('/repo/src/file-0.ts')
    expect(html).toContain('/repo/src/file-119.ts')
  })

  it('forwards custom live viewport presentation props', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeWriteActivity()]}
        provider="codex"
        liveActivityViewport
        liveActivityViewportClassName="nested-tool-viewport"
        liveActivityViewportCollapsedMaxHeight={123}
        liveActivityViewportLabel="Nested tool calls"
        liveActivityViewportExpandLabel="Expand nested tools"
        liveActivityViewportCollapseLabel="Collapse nested tools"
        liveActivityViewportJumpLabel="Jump to nested latest"
      />
    )

    expect(html).toContain('nested-tool-viewport')
    expect(html).toContain('aria-label="Nested tool calls"')
    expect(html).toContain('max-height:123px')
    expect(html).toContain('Expand nested tools')
  })

  it('keeps thinking traces as progress notes in compact density so actions are not nested in compact rows', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeThinkingActivity()]}
        provider="claude"
        compactDensity
        thinkingTraceActions={{
          messageId: 'tool-message-1',
          copiedId: null,
          pinned: false,
          copy: () => undefined
        }}
      />
    )

    expect(html).toContain('activity-progress-note status-success is-thinking-trace')
    expect(html).toContain('message-actions-chip')
    expect(html).not.toContain('compact-tool-trace')
  })
})

describe('ActivityStack compact tool groups', () => {
  it('uses the full-size tool-family icon in same-family group headers', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeReadActivity({ id: 'tool-read-1', parameters: { file_path: '/repo/src/foo.ts' } }),
          makeReadActivity({ id: 'tool-read-2', parameters: { file_path: '/repo/src/bar.ts' } })
        ]}
        provider="codex"
      />
    )

    expect(html).toContain('activity-compact-group')
    expect(html).toContain('Read 2 files')
    expect(html).toContain('class="activity-category-icon" width="27.2" height="27.2"')
  })

  it('summarizes repeated file targets with repeat chips and an odometer count badge', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeReadActivity({ id: 'tool-read-1', parameters: { file_path: '/repo/src/foo.ts' } }),
          makeReadActivity({ id: 'tool-read-2', parameters: { file_path: '/repo/src/foo.ts' } })
        ]}
        provider="codex"
      />
    )

    expect(html).toContain('Read foo.ts')
    expect(html).toContain('activity-compact-chip-repeat')
    expect(html).toContain('×2')
    expect(html).toContain('activity-count-badge')
    expect(html).toContain('digit-odometer')
    expect(html).toContain('2 raw tool calls')
    expect(html).not.toContain('activity-compact-chip muted')
  })

  it('debounces only same-id transitions from individual rows into a compact group', () => {
    const running = buildTimelineItems([
      makeReadActivity({ id: 'tool-read-1', status: 'running' }),
      makeReadActivity({ id: 'tool-read-2', status: 'running' })
    ])
    const settled = buildTimelineItems([
      makeReadActivity({ id: 'tool-read-1', status: 'success' }),
      makeReadActivity({ id: 'tool-read-2', status: 'success' })
    ])

    expect(running.map((item) => item.type)).toEqual(['activity', 'activity'])
    expect(settled.map((item) => item.type)).toEqual(['compact-group'])
    expect(shouldDebounceActivityTimelineCollapse(running, settled)).toBe(true)
  })

  it('does not debounce compact grouping when activity ids changed or warnings need surfacing', () => {
    const first = buildTimelineItems([
      makeReadActivity({ id: 'tool-read-1', status: 'success' })
    ])
    const appended = buildTimelineItems([
      makeReadActivity({ id: 'tool-read-1', status: 'success' }),
      makeReadActivity({ id: 'tool-read-2', status: 'success' })
    ])
    const running = buildTimelineItems([
      makeReadActivity({ id: 'tool-read-1', status: 'running' }),
      makeReadActivity({ id: 'tool-read-2', status: 'running' })
    ])
    const warning = buildTimelineItems([
      makeReadActivity({ id: 'tool-read-1', status: 'success' }),
      makeReadActivity({ id: 'tool-read-2', status: 'warning' })
    ])

    expect(shouldDebounceActivityTimelineCollapse(first, appended)).toBe(false)
    expect(shouldDebounceActivityTimelineCollapse(running, warning)).toBe(false)
  })
})

describe('ActivityStack compactDensity routing', () => {
  it('routes individual tool activities through CompactToolTrace when compactDensity is true', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWriteActivity()]} provider="claude" compactDensity />
    )

    expect(html).toContain('compact-tool-trace')
    // The legacy ActivityRow shell should not render alongside the
    // CompactToolTrace path — verifies we replaced the row, not
    // double-rendered.
    expect(html).not.toContain('activity-row-inline')
  })

  it('uses the standard ActivityRow when compactDensity is false (default)', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWriteActivity()]} provider="claude" />
    )

    expect(html).not.toContain('compact-tool-trace')
    expect(html).toContain('activity-row')
  })

  it('renders the file basename as a clickable TranscriptFileTarget in the DEFAULT (non-compact) path', () => {
    // Guards ActivityStack's own wiring: ActivityTitle/getInlineActivityTitle
    // must thread the path through to a `transcript-file-target activity-file-name`
    // button (not the old <strong>) in the default experience most users see.
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWriteActivity()]} provider="claude" workspacePath="/repo" />
    )

    expect(html).toContain('transcript-file-target activity-file-name')
    expect(html).toContain('>foo.ts</button>')
    // The full resolved path rides along in the title for the hover affordance.
    expect(html).toContain('title="/repo/src/foo.ts"')
  })

  it('surfaces cross-provider attribution distinctly when activities carry their own metadata.ensembleProvider', () => {
    // Simulates a single ensemble round where Codex called write_file
    // and Claude called Edit — the chat-level provider is "codex" but
    // each activity tags its actor via metadata.ensembleProvider.
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeWriteActivity({
            id: 'cross-1',
            toolName: 'write_file',
            metadata: { ensembleProvider: 'codex' }
          }),
          makeWriteActivity({
            id: 'cross-2',
            toolName: 'Edit',
            displayName: 'Edit',
            metadata: { ensembleProvider: 'claude' }
          })
        ]}
        provider="codex"
        compactDensity
      />
    )

    expect(html).toContain('provider-codex')
    expect(html).toContain('provider-claude')
    // Each actor's tool surfaces under its own human-friendly verb — Codex's
    // write_file as "Wrote", Claude's Edit as "Edited" — with the file path
    // split out into a distinct clickable, openable target.
    expect(html).toContain('>Wrote</span>')
    expect(html).toContain('>Edited</span>')
    expect(html).toContain('transcript-file-target compact-tool-trace-path')
    expect(html).toContain('/repo/src/foo.ts')
  })

  it('still renders ChildAgentSpawnBlock and falls back to ActivityRow when an activity has a child thread, even in compact mode', () => {
    // Compact-mode bypass only kicks in for activities WITHOUT a
    // child-agent thread — preserves the ChildAgentThreadCard hang-off.
    // Smoke test: an activity that isn't a spawner still uses
    // CompactToolTrace.
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWriteActivity()]} provider="codex" compactDensity />
    )
    expect(html).toContain('compact-tool-trace')
  })
})

describe('ActivityStack diff hover previews', () => {
  it('builds Workbench diff targets from tool diff summaries', () => {
    expect(
      buildActivityWorkbenchDiffSummary({
        diffText: ['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n'),
        workspacePath: '/repo',
        diffSummary: {
          additions: 1,
          deletions: 1,
          confidence: 'exact',
          source: 'patch_preview',
          files: [
            {
              path: '/repo/src/foo.ts',
              status: 'updated',
              additions: 1,
              deletions: 1
            }
          ]
        }
      })
    ).toMatchObject({
      path: 'src/foo.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      previewKind: 'git_diff'
    })

    expect(
      buildActivityWorkbenchDiffSummary({
        activityFilePath: 'src/local.ts',
        workspacePath: '/repo'
      })
    ).toMatchObject({
      path: 'src/local.ts',
      status: 'modified'
    })

    expect(
      buildActivityWorkbenchDiffSummary({
        activityFilePath: '/outside/src/foo.ts',
        workspacePath: '/repo'
      })
    ).toBeNull()
  })

  it('marks successful write rows with patch previews for hover diff preview', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeWriteActivity({
            parameters: {
              file_path: '/repo/src/foo.ts',
              patchPreview: ['@@ -1,2 +1,2 @@', '-old', '+new'].join('\n')
            },
            diffSummary: {
              additions: 1,
              deletions: 1,
              confidence: 'exact',
              source: 'patch_preview',
              files: [{ path: '/repo/src/foo.ts', status: 'modified', additions: 1, deletions: 1 }]
            }
          })
        ]}
        provider="codex"
      />
    )

    expect(html).toContain('data-diff-hover-preview="true"')
    expect(html).toContain('class="activity-diff-preview-bubble"')
    expect(html).toContain('aria-label="Preview diff for /repo/src/foo.ts"')
    expect(html).toContain('Diff')
  })

  it('does not mark write rows without diff text for hover preview', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWriteActivity()]} provider="codex" />
    )

    expect(html).not.toContain('data-diff-hover-preview=')
    expect(html).not.toContain('activity-diff-preview-bubble')
  })
})

describe('ActivityStack agent invocation presentation', () => {
  it('renders thinking progress notes with a provider-tinted bulb instead of a status check', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="grok"
        activities={[
          makeWriteActivity({
            id: 'thinking-1',
            toolName: 'grok_thinking',
            displayName: 'Thinking',
            category: 'task',
            status: 'success',
            parameters: {},
            resultSummary: 'Reviewing the renderer path.'
          })
        ]}
      />
    )

    expect(html).toContain('activity-progress-note')
    expect(html).toContain('is-thinking-trace')
    expect(html).toContain('data-provider="grok"')
    expect(html).toContain('activity-progress-note-thinking-icon')
    expect(html).toContain('Grok thinking trace')
    expect(html).not.toContain('class="activity-status success"')
  })

  it('renders cursor thinking progress notes with a provider-tinted bulb instead of a status check', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="cursor"
        activities={[
          makeWriteActivity({
            id: 'cursor-thinking-1',
            toolName: 'cursor_thinking',
            displayName: 'Thinking',
            category: 'task',
            status: 'success',
            parameters: {},
            resultSummary: 'Tracing the stream-json delta path.'
          })
        ]}
      />
    )

    expect(html).toContain('activity-progress-note')
    expect(html).toContain('is-thinking-trace')
    expect(html).toContain('data-provider="cursor"')
    expect(html).toContain('activity-progress-note-thinking-icon')
    expect(html).toContain('Cursor thinking trace')
    expect(html).not.toContain('class="activity-status success"')
  })

  it('routes provider reasoning names through the same live activity viewport', () => {
    const cases = [
      ['codex', 'codex_reasoning'],
      ['claude', 'mcp__TaskWraith__claude_reasoning'],
      ['grok', 'grok_thinking'],
      ['cursor', 'cursor_thinking'],
      ['ollama', 'ollama_thinking'],
      ['kimi', 'kimi_thinking']
    ] as const

    for (const [provider, toolName] of cases) {
      const html = renderToStaticMarkup(
        <ActivityStack
          provider={provider}
          liveActivityViewport
          activities={[
            makeWriteActivity({
              id: `${provider}-thinking-viewport`,
              toolName,
              displayName: 'Reasoning',
              category: 'task',
              status: 'success',
              parameters: { title: 'Thinking', kind: 'reasoning' },
              resultSummary: `${provider} full reasoning trace`
            })
          ]}
        />
      )

      expect(html).toContain('live-activity-viewport')
      expect(html).toContain('activity-progress-note')
      expect(html).toContain('is-thinking-trace')
      expect(html).toContain(`${provider} full reasoning trace`)
      expect(html).not.toContain('activity-row')
      expect(html).not.toContain('activity-detail-section-title')
    }
  })

  it('uses the thinking bulb when only the progress displayName identifies the trace', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="kimi"
        activities={[
          makeWriteActivity({
            id: 'thinking-display-name',
            toolName: 'Task',
            displayName: 'Kimi Thinking',
            category: 'task',
            status: 'success',
            parameters: {},
            resultSummary: 'Considering the next edit.'
          })
        ]}
      />
    )

    expect(html).toContain('is-thinking-trace')
    expect(html).toContain('data-provider="kimi"')
    expect(html).toContain('activity-progress-note-thinking-icon')
    expect(html).not.toContain('class="activity-status success"')
  })

  it('renders named thinking progress note bodies without the raw-events truncation footer', () => {
    const thinking = [
      'The user wants the complete trace in the live activity viewport.',
      ...Array.from(
        { length: 44 },
        (_, index) => `Reasoning line ${index + 1}: ${'x'.repeat(24)}`
      ),
      'tail sentinel after the old progress-note limit'
    ].join('\n')

    const html = renderToStaticMarkup(
      <ActivityStack
        provider="ollama"
        activities={[
          makeWriteActivity({
            id: 'thinking-full-body',
            toolName: 'ollama_thinking',
            displayName: 'Thinking',
            category: 'task',
            status: 'success',
            parameters: {},
            resultSummary: thinking
          })
        ]}
      />
    )

    expect(html).toContain('tail sentinel after the old progress-note limit')
    expect(html).not.toContain('open raw events for full output')
    expect(html).not.toContain('lines hidden')
  })

  it('does not fall back to a truncated result card for mis-categorized reasoning rows', () => {
    const thinking = [
      'Considering commit updates',
      ...Array.from(
        { length: 650 },
        (_, index) => `Reasoning line ${index + 1}: ${'x'.repeat(72)}`
      ),
      'tail sentinel after the old sanitized-detail limit'
    ].join('\n')

    const html = renderToStaticMarkup(
      <ActivityStack
        provider="codex"
        liveActivityViewport
        activities={[
          makeWriteActivity({
            id: 'codex-reasoning-unknown-category',
            toolName: 'codex_reasoning',
            displayName: 'Codex Reasoning',
            category: 'unknown',
            status: 'success',
            parameters: { title: 'Considering commit updates', kind: 'reasoning' },
            resultSummary: thinking
          })
        ]}
      />
    )

    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('is-thinking-trace')
    expect(html).toContain('tail sentinel after the old sanitized-detail limit')
    expect(html).not.toContain('activity-row')
    expect(html).not.toContain('activity-detail-section-title')
    expect(html).not.toContain('open raw events for full output')
    expect(html).not.toContain('lines hidden')
  })

  it('does not truncate display-name-only thinking traces', () => {
    const thinking = `${'Considering provider-specific activity rows. '.repeat(14)}final display-name sentinel`
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="kimi"
        activities={[
          makeWriteActivity({
            id: 'thinking-display-full-body',
            toolName: 'Task',
            displayName: 'Kimi Thinking',
            category: 'task',
            status: 'success',
            parameters: {},
            resultSummary: thinking
          })
        ]}
      />
    )

    expect(html).toContain('final display-name sentinel')
    expect(html).not.toContain('open raw events for full output')
  })

  it('renders Used callmcptool as the dancing tool icon easter egg', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="grok"
        activities={[
          makeWriteActivity({
            id: 'call-mcp-tool',
            toolName: 'callmcptool',
            displayName: 'Used callmcptool',
            category: 'unknown',
            parameters: {},
            resultSummary: ''
          })
        ]}
      />
    )

    expect(html).toContain('callmcp-tool-easter-egg')
    expect(html).toContain('aria-label="Used callmcptool"')
    expect(html).toContain('callmcp-tool-easter-egg-icon')
    expect(html).not.toContain('>Used callmcptool<')
  })

  it('renders generic MCP wrapper calls as the dancing tool icon easter egg', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="grok"
        activities={[
          makeWriteActivity({
            id: 'mcp-tool',
            toolName: 'mcp',
            displayName: 'MCP',
            category: 'unknown',
            parameters: {},
            resultSummary: ''
          })
        ]}
      />
    )

    expect(html).toContain('callmcp-tool-easter-egg')
    expect(html).toContain('callmcp-tool-easter-egg-icon')
    expect(html).not.toContain('>MCP<')
  })

  it('renders unknown wrapper calls as the dancing tool icon easter egg', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="grok"
        activities={[
          makeWriteActivity({
            id: 'unknown-tool',
            toolName: 'unknown',
            displayName: 'Used unknown',
            category: 'unknown',
            parameters: { mcpToolName: 'workspace_search', server: 'taskwraith' },
            rawUseEvent: { type: 'mcpToolCall', arguments: { query: 'needle' } },
            resultSummary: ''
          })
        ]}
      />
    )

    expect(html).toContain('callmcp-tool-easter-egg')
    expect(html).toContain('callmcp-tool-easter-egg-icon')
    expect(html).not.toContain('>Used unknown<')
  })

  it('does not obscure command-shaped unknown tool calls', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="grok"
        activities={[
          makeWriteActivity({
            id: 'unknown-shell-tool',
            toolName: 'unknown',
            displayName: 'Used unknown',
            category: 'unknown',
            parameters: { command: 'rg "needle" src' },
            resultSummary: ''
          })
        ]}
      />
    )

    expect(html).not.toContain('callmcp-tool-easter-egg')
    expect(html).toContain('Used unknown')
  })

  it('does not obscure command-shaped MCP wrapper calls', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="grok"
        activities={[
          makeWriteActivity({
            id: 'mcp-shell-tool',
            toolName: 'mcp',
            displayName: 'MCP',
            category: 'unknown',
            parameters: { command: 'bash ./scripts/check.sh' },
            resultSummary: ''
          })
        ]}
      />
    )

    expect(html).not.toContain('callmcp-tool-easter-egg')
    expect(html).toContain('MCP')
  })

  it('keeps provider-native child-agent cards free of source chips', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="claude"
        activities={[
          makeWriteActivity({
            id: 'task-1',
            toolName: 'Task',
            displayName: 'Task',
            category: 'task',
            status: 'running',
            parameters: {
              description: 'Review helper',
              prompt: 'Review the current diff'
            }
          }),
          makeWriteActivity({
            id: 'child-read-1',
            toolName: 'read_file',
            displayName: 'Read file',
            category: 'read',
            parentToolCallId: 'task-1'
          })
        ]}
      />
    )

    expect(html).not.toContain('Provider Native')
    expect(html).toContain('Provider tool call in this transcript')
    expect(html).toContain('Invocation prompt')
    expect(html).toContain('Provider-native activity')
  })

  it('renders child-agent identities with named identicons', () => {
    const chat = makeChat()
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="claude"
        chat={chat}
        chatId="chat-identity"
        runId="run-identity"
        activities={[
          makeWriteActivity({
            id: 'task-ident',
            toolName: 'Task',
            displayName: 'Task',
            category: 'task',
            status: 'running',
            parameters: {
              prompt: 'Review the current diff'
            }
          })
        ]}
      />
    )

    expect(html).toContain('agent-identity-icon-named')
    expect(html).toContain('data-agent-slug="donny-davis"')
    expect(html).toContain('Donny-Davis')
    const metadata = chat.providerMetadata as
      | {
          agentIdentities?: Record<
            string,
            { accent?: string; color?: string; name?: string; slug?: string }
          >
        }
      | undefined
    expect(metadata?.agentIdentities?.['task-ident']?.name).toBe('Donny-Davis')
    expect(metadata?.agentIdentities?.['task-ident']?.slug).toBe('donny-davis')
    expect(metadata?.agentIdentities?.['task-ident']?.accent).toBe('#DD3E2C')
    expect(metadata?.agentIdentities?.['task-ident']?.color).toBe('#DD3E2C')
  })
})

describe('ActivityStack controlled expansion (1.0.6-TV2)', () => {
  it('renders the row collapsed when the controlled set is empty', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeWriteActivity({ id: 'tool-x' })]}
        provider="codex"
        expandedActivityIds={new Set()}
        onExpandedActivityIdsChange={() => {}}
      />
    )
    expect(html).toContain('data-expanded="false"')
    expect(html).not.toContain('data-expanded="true"')
  })

  it('renders the row expanded when its id is in the controlled set', () => {
    // Proves expansion is driven by the parent-owned set, not local
    // state — the property transcript virtualisation relies on so an
    // expanded tool row survives scrolling out of the window and back.
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeWriteActivity({ id: 'tool-x' })]}
        provider="codex"
        expandedActivityIds={new Set(['tool-x'])}
        onExpandedActivityIdsChange={() => {}}
      />
    )
    expect(html).toContain('data-expanded="true"')
  })

  it('still works uncontrolled (no controlled props) — starts collapsed', () => {
    // Backward-compat guard: every other ActivityStack call site omits
    // the controlled props and must keep its original local-state
    // behaviour (rows start collapsed).
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeWriteActivity({ id: 'tool-y' })]} provider="codex" />
    )
    expect(html).toContain('data-expanded="false"')
    expect(html).not.toContain('data-expanded="true"')
  })
})

describe('ActivityStack expanded result rendering', () => {
  it('renders markdown-shaped result prose as markdown in expanded tool details', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeReadActivity({
            id: 'tool-markdown-result',
            toolName: 'web_fetch',
            displayName: 'Fetch page',
            category: 'read',
            resultSummary: [
              '## Findings',
              '',
              '- **Useful** result',
              '- [Source](https://example.com/docs)'
            ].join('\n')
          })
        ]}
        provider="codex"
        expandedActivityIds={new Set(['tool-markdown-result'])}
        onExpandedActivityIdsChange={() => {}}
      />
    )

    expect(html).toContain('activity-output-markdown')
    expect(html).toContain('<h2>')
    expect(html).toContain('<strong>Useful</strong>')
    expect(html).toContain('data-link-kind="external"')
    expect(html).not.toContain('activity-output-diff')
  })

  it('keeps JSON-ish result bodies preformatted rather than markdown-rendering them', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeReadActivity({
            id: 'tool-json-result',
            toolName: 'git_status',
            displayName: 'Git status',
            category: 'read',
            resultSummary: '{"branch":"main","files":["src/App.tsx"]}'
          })
        ]}
        provider="codex"
        expandedActivityIds={new Set(['tool-json-result'])}
        onExpandedActivityIdsChange={() => {}}
      />
    )

    expect(html).not.toContain('activity-output-markdown')
    expect(html).toContain('activity-output-diff')
    expect(html).toContain('&quot;branch&quot;')
  })

  it('keeps path-line search output preformatted even when matched text contains markdown', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeReadActivity({
            id: 'tool-search-result',
            toolName: 'workspace_search',
            displayName: 'Workspace search',
            category: 'search',
            parameters: { query: 'markdown' },
            resultSummary: [
              'src/a.ts:1: - **markdown-looking** text',
              'src/b.ts:2: [Source](https://example.com/docs)'
            ].join('\n')
          })
        ]}
        provider="codex"
        expandedActivityIds={new Set(['tool-search-result'])}
        onExpandedActivityIdsChange={() => {}}
      />
    )

    expect(html).not.toContain('activity-output-markdown')
    expect(html).toContain('activity-output-diff')
    expect(html).not.toContain('<strong>markdown-looking</strong>')
  })
})

describe('ActivityStack denied / errored edit rendering', () => {
  // Repro: a read-only ("Plan / Read-only") Grok seat asks to edit the
  // README; Grok calls native `search_replace`; TaskWraith's gate auto-denies
  // it (tool_result `{ status: 'error', output: 'User rejected …' }`). The
  // file on disk is unchanged, so the card must NOT read as an applied
  // "Wrote README.md +6 −4" change — it carries the attempted diff but the
  // result was a rejection.
  function makeDeniedEditActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
    return {
      id: 'tool-denied-1',
      toolName: 'search_replace',
      // createToolActivity would set this to "Wrote README.md"; the card must
      // override it rather than fall back to it.
      displayName: 'Wrote README.md',
      category: 'write',
      status: 'error',
      startedAt: '2026-05-26T17:00:00Z',
      endedAt: '2026-05-26T17:00:00.100Z',
      durationMs: 100,
      parameters: {
        file_path: 'README.md',
        old_string: 'one\ntwo\nthree\nfour',
        new_string: 'one\nTWO\nthree\nfour\nfive\nsix'
      },
      diffSummary: {
        additions: 6,
        deletions: 4,
        files: [{ path: 'README.md', status: 'modified', additions: 6, deletions: 4 }],
        source: 'string_replace',
        confidence: 'estimated'
      },
      resultSummary: 'User rejected the execution for tool search_replace',
      filePath: 'README.md',
      ...overrides
    }
  }

  it('renders an attempted label, not "Wrote README.md", for a denied edit', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeDeniedEditActivity()]} provider="grok" />
    )
    expect(html).toContain('Attempted to edit')
    expect(html).not.toContain('Wrote README.md')
  })

  it('does not paint the "+N −M" inline pill for a denied edit', () => {
    const html = renderToStaticMarkup(
      <ActivityStack activities={[makeDeniedEditActivity()]} provider="grok" />
    )
    // `activity-line-stats` is the inline odometer wrapper; it must be absent
    // when the edit was denied even though diffSummary carries +6/−4.
    expect(html).not.toContain('activity-line-stats')
  })

  it('still shows the success label + pill when the SAME edit is applied', () => {
    // Control: gate is on the result status, not the tool. A successful edit
    // keeps its "Edited" label and its odometer.
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeDeniedEditActivity({
            id: 'tool-applied-1',
            toolName: 'edit_file',
            displayName: 'Edited README.md',
            status: 'success',
            resultSummary: 'Applied 1 edit'
          })
        ]}
        provider="grok"
      />
    )
    expect(html).toContain('Edited')
    expect(html).not.toContain('Attempted')
    expect(html).toContain('activity-line-stats')
  })
})

describe('ActivityStack todo_write rendering', () => {
  it('renders a checklist card and progress summary for goal-step updates', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          {
            id: 'tool-todo-1',
            toolName: 'todo_write',
            displayName: 'Goal steps',
            category: 'task',
            status: 'success',
            startedAt: '2026-06-08T12:00:00Z',
            endedAt: '2026-06-08T12:00:01Z',
            durationMs: 1000,
            parameters: {
              merge: false,
              todos: [
                { id: '1', content: 'Parse todo parameters', status: 'completed' },
                { id: '2', content: 'Render checklist card', status: 'in_progress' },
                { id: '3', content: 'Ship 1.4.2', status: 'pending' }
              ]
            }
          }
        ]}
        provider="codex"
      />
    )

    expect(html).toContain('Goal steps · 1/3 complete')
    expect(html).toContain('todo-checklist-card')
    expect(html).toContain('Render checklist card')
    expect(html).toContain('Ship 1.4.2')
  })

  it('keeps same-provider ensemble plan lanes separate in the live PlanRail', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          {
            id: 'tool-todo-reviewer',
            toolName: 'todo_write',
            displayName: 'Goal steps',
            category: 'task',
            status: 'success',
            parameters: {
              todos: [{ id: 'review', content: 'Review the patch', status: 'in_progress' }]
            },
            metadata: {
              ensembleParticipantId: 'codex-reviewer',
              ensembleProvider: 'codex',
              provider: 'codex'
            }
          },
          {
            id: 'tool-todo-builder',
            toolName: 'todo_write',
            displayName: 'Goal steps',
            category: 'task',
            status: 'success',
            parameters: {
              todos: [{ id: 'build', content: 'Apply the fix', status: 'pending' }]
            },
            metadata: {
              ensembleParticipantId: 'codex-builder',
              ensembleProvider: 'codex',
              provider: 'codex'
            }
          }
        ]}
        provider="codex"
        chat={makeEnsembleChat([
          makeParticipant({ id: 'codex-reviewer', provider: 'codex', role: 'Reviewer', order: 1 }),
          makeParticipant({ id: 'codex-builder', provider: 'codex', role: 'Builder', order: 2 })
        ])}
        liveActivityViewport
      />
    )

    expect(html).toContain('Reviewer / Codex')
    expect(html).toContain('Builder / Codex')
    expect(html).toContain('Review the patch')
    expect(html).toContain('Apply the fix')
  })
})

describe('sliceTimelineSegmentsToTail (stable viewport identity under the collapsed cap)', () => {
  const thinking = (id: string): ToolActivity =>
    ({
      id,
      toolName: 'codex_reasoning',
      displayName: 'Reasoning summary',
      category: 'unknown',
      status: 'success',
      outputPreview: `trace ${id}`,
      parameters: { kind: 'reasoning' }
    }) as ToolActivity
  const tool = (id: string): ToolActivity =>
    ({
      id,
      toolName: 'read_file',
      displayName: 'Read',
      category: 'read',
      status: 'success',
      outputPreview: `out ${id}`
    }) as ToolActivity

  const activities = [
    thinking('t-0'),
    thinking('t-1'),
    tool('r-0'),
    tool('r-1'),
    tool('r-2'),
    thinking('t-2'),
    thinking('t-3')
  ]
  const segments = buildTimelineSegments(buildTimelineItems(activities))

  it('keeps every surviving segment id identical to the full-timeline id', () => {
    const sliced = sliceTimelineSegmentsToTail(segments, 4)
    const fullIds = segments.map((segment) => segment.id)
    for (const segment of sliced) {
      expect(fullIds).toContain(segment.id)
    }
  })

  it('trims the earliest included segment WITHOUT renaming it', () => {
    // The 3 consecutive reads compact-group into ONE timeline item, so the
    // full item list is [t-0, t-1, group(r-0..2), t-2, t-3]. Limit 4 drops
    // t-0 — the leading thinking segment is trimmed to one item but keeps
    // its full-timeline id (first constituent t-0) even though t-0 itself
    // is no longer rendered.
    const sliced = sliceTimelineSegmentsToTail(segments, 4)
    expect(sliced.map((segment) => segment.kind)).toEqual(['thinking', 'tools', 'thinking'])
    expect(sliced[0].id).toBe(segments[0].id)
    expect(sliced[0].items.length).toBe(1)
    expect(sliced[1].id).toBe(segments[1].id)
    expect(sliced[2].items.length).toBe(2)
  })

  it('is id-stable as new items append past the cap (the mid-stream flash)', () => {
    const grown = [...activities, thinking('t-4')]
    const grownSegments = buildTimelineSegments(buildTimelineItems(grown))
    const before = sliceTimelineSegmentsToTail(segments, 4)
    const after = sliceTimelineSegmentsToTail(grownSegments, 4)
    // The trailing thinking segment keeps its identity when it grows.
    expect(after[after.length - 1].id).toBe(before[before.length - 1].id)
  })

  it('returns everything when the limit covers the list, nothing at limit 0', () => {
    expect(sliceTimelineSegmentsToTail(segments, 99)).toEqual(segments)
    expect(sliceTimelineSegmentsToTail(segments, 0)).toEqual([])
  })
})

describe('subagent viewport (agent segments outside the thinking/tool hierarchy)', () => {
  function makeAgentSpawnActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
    return {
      id: 'agent-spawn-1',
      toolName: 'agent',
      displayName: 'Used agent',
      category: 'task',
      status: 'running',
      parameters: { description: 'Audit the CSS shards', subagent_type: 'coder' },
      ...overrides
    } as ToolActivity
  }

  it('splits an agent anchor into its own agent segment between tool segments', () => {
    const items = buildTimelineItems([
      makeWriteActivity({ id: 'w-0' }),
      makeAgentSpawnActivity(),
      makeWriteActivity({ id: 'w-1', parameters: { file_path: '/repo/src/bar.ts' } })
    ])
    const segments = buildTimelineSegments(items, new Set(['agent-spawn-1']))
    expect(segments.map((segment) => segment.kind)).toEqual(['tools', 'agent', 'tools'])
    expect(segments[1].activities.map((activity) => activity.id)).toEqual(['agent-spawn-1'])
  })

  it('keeps consecutive agent anchors in ONE spawn-wave segment', () => {
    const items = buildTimelineItems([
      makeAgentSpawnActivity({ id: 'agent-a' }),
      makeAgentSpawnActivity({ id: 'agent-b' })
    ])
    const segments = buildTimelineSegments(items, new Set(['agent-a', 'agent-b']))
    expect(segments.map((segment) => segment.kind)).toEqual(['agent'])
    expect(segments[0].activities).toHaveLength(2)
  })

  it('renders the child-agent card inside its own subagent viewport, not the tool viewport', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[makeWriteActivity({ id: 'w-0' }), makeAgentSpawnActivity()]}
        provider="claude"
        liveActivityViewport
      />
    )
    expect(html).toContain('activity-subagent-viewport')
    // The write activity's tool viewport precedes the agent viewport and must
    // NOT contain the child-agent card — it lives in its own top-level
    // viewport, outside the thinking/tool hierarchy.
    const toolViewportHtml = html.slice(
      html.indexOf('activity-tool-call-viewport'),
      html.indexOf('activity-subagent-viewport')
    )
    expect(toolViewportHtml).not.toContain('child-agent-thread')
    expect(html.slice(html.indexOf('activity-subagent-viewport'))).toContain('child-agent-thread')
  })

  it('renders a settled subagent as a collapsed one-liner carrying the provider accent hook', () => {
    const html = renderToStaticMarkup(
      <ActivityStack
        activities={[
          makeAgentSpawnActivity({
            id: 'agent-done',
            status: 'success',
            endedAt: '2026-05-26T17:01:00Z',
            durationMs: 60_000,
            resultSummary: 'Audit complete.'
          })
        ]}
        provider="claude"
        liveActivityViewport
      />
    )
    // Collapsed one-liner: header only, no expanded body.
    expect(html).toContain('child-agent-thread state-completed')
    expect(html).not.toContain('child-agent-thread-body')
    // Provider accent hook rides the card root next to the agent id.
    expect(html).toContain('data-agent-id="agent-done" data-provider="claude"')
  })
})

describe('liveThinkingTraceRenderBody (bounded live thinking render)', () => {
  it('passes short bodies and settled runs through untouched', () => {
    expect(liveThinkingTraceRenderBody('short trace', true)).toEqual({
      text: 'short trace',
      trimmed: false
    })
    const huge = 'x'.repeat(LIVE_THINKING_TRACE_RENDER_CHAR_CAP + 5_000)
    // Settled run (liveStreamActive false): full body renders once.
    expect(liveThinkingTraceRenderBody(huge, false)).toEqual({ text: huge, trimmed: false })
  })

  it('renders only the tail of a huge live body, with an ellipsis marker', () => {
    const head = 'HEAD-SHOULD-NOT-RENDER '.repeat(600)
    const tail = 'visible tail sentence. '.repeat(400)
    const out = liveThinkingTraceRenderBody(head + tail, true)
    expect(out.trimmed).toBe(true)
    expect(out.text.startsWith('\u2026 ')).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(LIVE_THINKING_TRACE_RENDER_CHAR_CAP + 2)
    expect(out.text).not.toContain('HEAD-SHOULD-NOT-RENDER')
    expect(out.text).toContain('visible tail sentence.')
  })

  it('opens the tail at a nearby break instead of mid-word', () => {
    // The newline sits ~100 chars into the 6000-char tail (well inside the
    // 400-char re-anchor window) and is immediately followed by text — the
    // common trace shape. The visible body must re-anchor at the paragraph,
    // dropping the mid-word 'a' fragment entirely.
    const body = `${'a'.repeat(LIVE_THINKING_TRACE_RENDER_CHAR_CAP - 5_900 + 20_000)}\nClean paragraph start ${'b'.repeat(5_800)}`
    const out = liveThinkingTraceRenderBody(body, true)
    expect(out.trimmed).toBe(true)
    expect(out.text.startsWith('\u2026 Clean paragraph start')).toBe(true)
    expect(out.text).not.toContain('aaa')
  })

  it('never opens the tail on an orphaned surrogate half', () => {
    // An astral char straddles the slice boundary: cap+1 chars of prose after
    // it means slice(-cap) starts on the low surrogate.
    const body = `${'x'.repeat(500)}\u{1F600}${'y'.repeat(LIVE_THINKING_TRACE_RENDER_CHAR_CAP - 1)}`
    const out = liveThinkingTraceRenderBody(body, true)
    expect(out.trimmed).toBe(true)
    // Well-formed: no lone surrogate anywhere in the rendered text.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out.text)).toBe(
      false
    )
  })
})
