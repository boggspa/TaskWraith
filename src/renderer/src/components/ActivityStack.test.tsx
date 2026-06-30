import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityStack, buildActivityWorkbenchDiffSummary } from './ActivityStack'
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
    // Each actor's tool surfaces under its own human-friendly label —
    // Codex's write_file as "Wrote …", Claude's Edit as "Edited …".
    expect(html).toContain('Wrote /repo/src/foo.ts')
    expect(html).toContain('Edited /repo/src/foo.ts')
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

  it('labels provider-native child-agent threads with unified invocation copy', () => {
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

    expect(html).toContain('Provider Native')
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
