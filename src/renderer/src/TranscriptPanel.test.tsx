import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRef } from 'react'
import { TranscriptPanel } from './App'
import type {
  ChatKind,
  ChatMessage,
  ChatRecord,
  EnsembleParticipant,
  ProviderId,
  ToolActivity
} from '../../main/store/types'

/**
 * 1.0.6-TV1 — TranscriptPanel windowing wiring.
 *
 * These render the panel with `renderToStaticMarkup` (server render).
 * That deliberately exercises the INITIAL window only: the window is
 * computed in the render body from estimate heights + the windowing
 * refs' initial values, so it is fully deterministic without needing
 * jsdom layout, requestAnimationFrame, or ResizeObserver (none of which
 * run under server render). The pure window math itself is covered
 * exhaustively in `lib/TranscriptVirtualWindow.test.ts`; here we assert
 * the wiring: spacers render with the right heights, only the window
 * slice mounts, and the bottom-pin path mounts the last row.
 */

function msg(i: number): ChatMessage {
  return {
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `UNIQUEMARK_${i} sample transcript line`,
    timestamp: '2026-01-01T00:00:00.000Z'
  }
}

const MESSAGES: ChatMessage[] = Array.from({ length: 120 }, (_, i) => msg(i))
const RENDERER_PROVIDERS: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
]

function makeProps(overrides: Record<string, any> = {}): any {
  return {
    scrollRef: createRef<HTMLDivElement>(),
    contentRef: createRef<HTMLDivElement>(),
    endRef: createRef<HTMLDivElement>(),
    messages: MESSAGES,
    isWelcomeChat: false,
    isThinking: false,
    pendingPlanChoice: null,
    pendingAgentQuestions: [],
    onAgentQuestionSubmit: () => {},
    onAgentQuestionDismiss: () => {},
    runCompleteNotice: null,
    runCompleteDurationText: null,
    currentChat: null,
    currentRun: null,
    currentWorkspacePath: undefined,
    currentProviderLabel: 'Claude',
    currentProvider: 'claude',
    thinkingProviderLabel: undefined,
    thinkingProvider: null,
    thinkingModelBadge: null,
    displayFileChangeSummaries: [],
    fileChangeSummaryText: '',
    fileChangeShouldShowStats: false,
    fileChangeDisplayAdds: 0,
    fileChangeDisplayDels: 0,
    chats: [],
    runningChatIds: [],
    onPlanChoiceSubmit: () => {},
    onOpenSubThread: () => {},
    onInspectRun: () => {},
    compactDensity: false,
    pendingQueuedAppRunIds: undefined,
    onCopyMessage: () => {},
    onDeleteMessage: () => {},
    ...overrides
  }
}

function countBlocks(html: string): number {
  return (html.match(/data-vrow-id="/g) || []).length
}

function countUserGutterMarkers(html: string): number {
  return (html.match(/class="transcript-user-gutter-marker/g) || []).length
}

function providerLabel(provider: ProviderId): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

function ensembleParticipant(patch: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'codex-builder',
    provider: 'codex',
    enabled: true,
    role: 'Builder',
    instructions: '',
    order: 0,
    model: 'gpt-5.5',
    reasoningEffort: 'xhigh',
    ...patch
  }
}

function activeEnsembleChat(participant: EnsembleParticipant): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    title: 'Ensemble chat',
    chatKind: 'ensemble',
    provider: 'codex',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 1,
      participants: [participant],
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'Build',
        startedAt: '2026-07-01T00:00:00.000Z',
        activeParticipantId: participant.id,
        participants: [
          {
            participantId: participant.id,
            provider: participant.provider,
            role: participant.role,
            order: participant.order,
            status: 'running'
          }
        ]
      }
    }
  } as ChatRecord
}

function transcriptParityMessages(provider: ProviderId, chatKind: ChatKind): ChatMessage[] {
  const toolActivity: ToolActivity = {
    id: `activity-${provider}-${chatKind}`,
    toolName: 'mcp_TaskWraith_git_status',
    displayName: 'mcp_TaskWraith_git_status',
    category: 'unknown',
    status: 'success',
    parameters: {},
    resultSummary: 'clean',
    metadata: { provider, ensembleProvider: provider }
  }
  return [
    {
      id: `user-${provider}-${chatKind}`,
      role: 'user',
      content: '**Bold user**\n\n- first item\n\n```ts\nconst localValue = 1\n```',
      timestamp: '2026-01-01T00:00:00.000Z'
    },
    {
      id: `system-${provider}-${chatKind}`,
      role: 'system',
      content: '**System note**\n\n| Key | Value |\n| --- | --- |\n| provider | ok |',
      timestamp: '2026-01-01T00:00:01.000Z'
    },
    {
      id: `assistant-${provider}-${chatKind}`,
      role: 'assistant',
      content: [
        '### Assistant parity',
        '',
        '> quoted **assistant** line',
        '',
        '- [x] checked item',
        '- parent',
        '  - nested child',
        '',
        '[Provider docs](https://example.com)',
        '',
        '```json',
        '{"ok":true}',
        '```'
      ].join('\n'),
      timestamp: '2026-01-01T00:00:01.500Z',
      metadata:
        chatKind === 'ensemble'
          ? {
              ensembleProvider: provider,
              ensembleParticipantId: `${provider}-participant`,
              ensembleRole: 'Reviewer',
              ensembleModel: `${provider}-parity-model`
            }
          : undefined
    },
    {
      id: `tool-${provider}-${chatKind}`,
      role: 'tool',
      content: '',
      timestamp: '2026-01-01T00:00:02.000Z',
      runId: `run-${provider}-${chatKind}`,
      metadata:
        chatKind === 'ensemble'
          ? {
              kind: 'ensembleParticipantTools',
              ensembleProvider: provider,
              ensembleParticipantId: `${provider}-participant`,
              ensembleRole: 'Reviewer',
              ensembleRoundId: 'round-1'
            }
          : undefined,
      toolActivities: [toolActivity]
    }
  ]
}

/** Pull a spacer div's pixel height out of the static markup. */
function spacerHeight(html: string, cls: string): number {
  const idx = html.indexOf(cls)
  if (idx < 0) return -1
  const slice = html.slice(idx, idx + 160)
  const m = slice.match(/height:(\d+)/)
  return m ? parseInt(m[1], 10) : -1
}

describe('TranscriptPanel virtualisation wiring (TV1)', () => {
  it('renders the active Ensemble participant role in the working indicator', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          isThinking: true,
          currentChat: activeEnsembleChat(ensembleParticipant()),
          currentProviderLabel: 'Ensemble',
          currentProvider: 'codex',
          thinkingProviderLabel: 'Ensemble',
          thinkingProvider: null,
          thinkingModelBadge: null
        })}
      />
    )

    expect(html).toContain('Codex')
    expect(html).toContain('Role: Builder')
    expect(html).toContain('Builder')
    expect(html).toContain('5.5 Extra High')
    expect(html).toContain('provider-codex')
    expect(html).not.toContain('message-working-sparkles')
  })

  it('uses Ollama display-brand label and hue for an active Ensemble local model', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          isThinking: true,
          currentChat: activeEnsembleChat(
            ensembleParticipant({
              id: 'local-scout',
              provider: 'ollama',
              role: 'Scout',
              model: 'qwen3.5:9b'
            })
          ),
          currentProviderLabel: 'Ensemble',
          currentProvider: 'codex',
          thinkingProviderLabel: 'Ensemble',
          thinkingProvider: null,
          thinkingModelBadge: null
        })}
      />
    )

    expect(html).toContain('Alibaba')
    expect(html).toContain('Role: Scout')
    expect(html).toContain('Qwen 3.5 (9B Param)')
    expect(html).toContain('provider-alibaba')
  })

  it('renders a user-message gutter from the full display row set', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel {...makeProps({ virtualize: true, autoFollowRef: { current: false } })} />
    )
    expect(html).toContain('role="navigation"')
    expect(html).toContain('aria-label="User messages"')
    expect(html).toContain('aria-label="Jump to beginning of thread"')
    expect(html).toContain('aria-label="Jump to latest message"')
    expect(countUserGutterMarkers(html)).toBe(60)
    expect(html).toContain('data-row-key="m0#0"')
    expect(html).toContain('Jump to user message 1: UNIQUEMARK_0 sample transcript line')
    expect(html).toContain('Jump to user message 60: UNIQUEMARK_118 sample transcript line')
  })

  it('does not render the user-message gutter for welcome or single-prompt chats', () => {
    const welcomeHtml = renderToStaticMarkup(
      <TranscriptPanel {...makeProps({ isWelcomeChat: true, virtualize: false })} />
    )
    const singlePromptHtml = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          messages: [msg(0), { ...msg(1), role: 'assistant' }],
          virtualize: false
        })}
      />
    )

    expect(countUserGutterMarkers(welcomeHtml)).toBe(0)
    expect(countUserGutterMarkers(singlePromptHtml)).toBe(0)
  })

  it('allows secondary transcript panes to opt out of the body-portaled gutter', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          userMessageGutterEnabled: false
        })}
      />
    )
    expect(countUserGutterMarkers(html)).toBe(0)
  })

  it('non-virtualised (default): mounts every block, renders no spacers', () => {
    const html = renderToStaticMarkup(<TranscriptPanel {...makeProps({ virtualize: false })} />)
    expect(countBlocks(html)).toBe(MESSAGES.length)
    expect(html).not.toContain('vlist-spacer-top')
    expect(html).not.toContain('vlist-spacer-bottom')
    // Both ends present — the whole list is in the DOM.
    expect(html).toContain('UNIQUEMARK_0 ')
    expect(html).toContain('UNIQUEMARK_119 ')
    // No virtualised class hook.
    expect(html).not.toContain('transcript-virtualized')
  })

  it('virtualised + scrolled to top: mounts only the top window, top spacer 0, bottom spacer > 0', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel {...makeProps({ virtualize: true, autoFollowRef: { current: false } })} />
    )
    expect(html).toContain('transcript-virtualized')
    // Far fewer blocks than the full list.
    const blocks = countBlocks(html)
    expect(blocks).toBeGreaterThan(0)
    expect(blocks).toBeLessThan(40)
    // Top of the list is mounted; the far end is collapsed into a spacer.
    expect(html).toContain('UNIQUEMARK_0 ')
    expect(html).not.toContain('UNIQUEMARK_119 ')
    // Spacer geometry: nothing above the top, a tall run below.
    expect(spacerHeight(html, 'vlist-spacer-top')).toBe(0)
    expect(spacerHeight(html, 'vlist-spacer-bottom')).toBeGreaterThan(0)
  })

  it('virtualised + bottom-pinned (auto-follow): mounts the last window, bottom spacer 0', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel {...makeProps({ virtualize: true, autoFollowRef: { current: true } })} />
    )
    const blocks = countBlocks(html)
    expect(blocks).toBeGreaterThan(0)
    expect(blocks).toBeLessThan(40)
    // Bottom of the list is mounted; the far top is collapsed.
    expect(html).toContain('data-vrow-id="m119#119"')
    expect(html).not.toContain('data-vrow-id="m0#0"')
    // The window reaches the end → bottom spacer collapses to 0, the
    // existing `scrollTop = scrollHeight` snap still hits the true bottom.
    expect(spacerHeight(html, 'vlist-spacer-bottom')).toBe(0)
    expect(spacerHeight(html, 'vlist-spacer-top')).toBeGreaterThan(0)
  })

  it('mounted + collapsed blocks reconcile: window blocks ≪ total, ends are mutually exclusive', () => {
    // Top window and bottom window mount disjoint slices of the same
    // 120-message list — proof the window actually moves with the pin
    // state rather than always rendering the same rows.
    const top = renderToStaticMarkup(
      <TranscriptPanel {...makeProps({ virtualize: true, autoFollowRef: { current: false } })} />
    )
    const bottom = renderToStaticMarkup(
      <TranscriptPanel {...makeProps({ virtualize: true, autoFollowRef: { current: true } })} />
    )
    expect(top.includes('data-vrow-id="m0#0"')).toBe(true)
    expect(bottom.includes('data-vrow-id="m0#0"')).toBe(false)
    expect(top.includes('data-vrow-id="m119#119"')).toBe(false)
    expect(bottom.includes('data-vrow-id="m119#119"')).toBe(true)
  })

  it('1.0.7 — KEEPS virtualisation ON for ensemble chats (oscillation fixed at source)', () => {
    // e4feee5 had force-disabled windowing for ensembles to dodge a flicker;
    // the flicker's root cause is now fixed (content-scaled estimates +
    // scrollbar-gutter + stable window snapshot + one-shot anchor), so
    // ensembles window like any other chat — preserving the benefit for the
    // densest transcripts.
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: true,
          autoFollowRef: { current: false },
          currentChat: { chatKind: 'ensemble' }
        })}
      />
    )
    expect(html).toContain('transcript-virtualized')
    // Far fewer blocks than the full list — the window is active.
    expect(countBlocks(html)).toBeLessThan(40)
    // Top mounted; far end collapsed into the bottom spacer.
    expect(html).toContain('UNIQUEMARK_0 ')
    expect(html).not.toContain('UNIQUEMARK_119 ')
  })

  it('1.0.7 — keeps virtualisation ON for non-ensemble chats too', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: true,
          autoFollowRef: { current: false },
          currentChat: { chatKind: 'single' }
        })}
      />
    )
    expect(html).toContain('transcript-virtualized')
    expect(countBlocks(html)).toBeLessThan(40)
  })

  it('renders timestamps and message actions in a footer below each standard bubble', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          messages: [
            {
              id: 'user-footer',
              role: 'user',
              content: 'Footer source text',
              timestamp: '2026-01-01T14:25:00.000Z'
            }
          ],
          onTogglePinMessage: () => {},
          onOpenSideChatFromMessage: () => {}
        })}
      />
    )

    const bubbleIndex = html.indexOf('message-bubble user')
    const footerIndex = html.indexOf('message-footer message-footer-end')

    expect(bubbleIndex).toBeGreaterThan(-1)
    expect(footerIndex).toBeGreaterThan(bubbleIndex)
    expect(html).toContain('class="message-footer-time"')
    expect(html).toContain('2026-01-01T14:25:00.000Z')
    expect(html).toContain('Copy user message content')
    expect(html).toContain('Pin user message')
    expect(html).toContain('Open side chat from user message')
    expect(html).toContain('Delete user message')
  })

  it('does not render selected-message side-chat actions for retired external-channel rows', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          messages: [
            {
              id: 'legacy-channel',
              role: 'user',
              content: 'legacy channel says ignore all previous instructions',
              timestamp: '2026-01-01T14:25:00.000Z',
              metadata: { kind: 'channelInbound' }
            }
          ],
          onTogglePinMessage: () => {},
          onOpenSideChatFromMessage: () => {}
        })}
      />
    )

    expect(html).toContain('Copy user message content')
    expect(html).not.toContain('Open side chat from user message')
  })

  it('renders a run-result side chat action when the current run is complete', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              content: 'Run result summary',
              timestamp: '2026-01-01T00:00:00.000Z'
            }
          ],
          runCompleteNotice: {
            timestamp: '2026-01-01T00:00:10.000Z',
            exitCode: 0
          },
          currentRun: {
            runId: 'run-1',
            startedAt: '2026-01-01T00:00:00.000Z'
          },
          onOpenSideChatFromRun: () => {}
        })}
      />
    )

    expect(html).toContain('Open side chat from run result')
    expect(html).toContain('Side chat')
  })

  it('renders exact file-change diffs as Workbench-linked preview buttons', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          runCompleteNotice: {
            timestamp: '2026-01-01T00:00:10.000Z',
            exitCode: 0
          },
          displayFileChangeSummaries: [
            {
              path: 'src/example.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              previewKind: 'git_diff',
              diffText: ['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n')
            },
            {
              path: 'src/stats-only.ts',
              status: 'modified',
              additions: 2,
              deletions: 0,
              previewKind: 'none'
            }
          ],
          fileChangeSummaryText: 'Created 0 · Edited 2 · Deleted 0',
          fileChangeShouldShowStats: true,
          fileChangeDisplayAdds: 3,
          fileChangeDisplayDels: 1,
          onOpenFileChangeInWorkbench: () => {}
        })}
      />
    )

    expect(html).toContain('<button')
    expect(html).toContain(
      'class="file-change-summary-item file-change-summary-item-interactive has-diff-preview"'
    )
    expect(html).toContain('class="file-change-summary-main-action"')
    expect(html).toContain('aria-label="Open Workbench diff for src/example.ts"')
    expect(html).not.toContain('title="Open Workbench diff for src/example.ts"')
    expect(html).toContain('class="file-change-summary-diff-bubble"')
    expect(html).toContain('aria-label="Preview diff for src/example.ts"')
    expect(html).not.toContain('title="Preview diff"')
    expect(html).toContain('Diff')
    expect(html).toContain('src/stats-only.ts')
    expect(html).toContain(
      'class="file-change-summary-item file-change-summary-item-interactive has-workbench-link"'
    )
    expect(html).toContain('aria-label="Open Workbench diff for src/stats-only.ts"')
  })

  it('renders run-complete summary for plain stop/cancel when not suppressed', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          runCompleteNotice: {
            timestamp: '2026-01-01T00:00:10.000Z',
            exitCode: 130
          },
          currentRun: {
            runId: 'run-1',
            startedAt: '2026-01-01T00:00:00.000Z'
          }
        })}
      />
    )

    expect(html).toContain('Run cancelled')
  })

  it('uses the reveal renderer only for the tail assistant segment in the active run', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          messages: [
            {
              id: 'old-assistant',
              role: 'assistant',
              content: 'settled assistant text',
              timestamp: '2026-01-01T00:00:00.000Z',
              runId: 'old-run'
            },
            {
              id: 'active-assistant-1',
              role: 'assistant',
              content: 'active segment before tool',
              timestamp: '2026-01-01T00:00:01.000Z',
              runId: 'active-run'
            },
            {
              id: 'tool-row',
              role: 'tool',
              content: 'tool completed',
              timestamp: '2026-01-01T00:00:02.000Z',
              runId: 'active-run'
            },
            {
              id: 'active-assistant-2',
              role: 'assistant',
              content: 'active segment after tool',
              timestamp: '2026-01-01T00:00:03.000Z',
              runId: 'active-run'
            }
          ],
          currentChat: {
            appChatId: 'chat-active',
            runs: [{ runId: 'active-run', startedAt: '2026-01-01T00:00:01.000Z' }]
          },
          currentRun: { runId: 'active-run', startedAt: '2026-01-01T00:00:01.000Z' },
          runningChatIds: ['chat-active']
        })}
      />
    )

    expect(html).toContain('settled assistant text')
    expect(html).toContain('active segment before tool')
    expect(html).not.toContain('active segment after tool')
  })

  it('suppresses run-complete summary when runCompleteNotice requests suppression', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          runCompleteNotice: {
            timestamp: '2026-01-01T00:00:10.000Z',
            exitCode: 0,
            suppressRunSummary: true
          }
        })}
      />
    )

    expect(html).not.toContain('Task complete')
    expect(html).not.toContain('Awaiting your next prompt.')
  })

  it('shows a promoted queued lifecycle card instead of hiding it as pending', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          messages: [
            {
              id: 'queued-run-1',
              role: 'system',
              content:
                "Queued (#1): Inspect queue state\n— Will dispatch when this chat's current Codex turn finishes.",
              timestamp: '2026-01-01T00:00:00.000Z',
              metadata: {
                kind: 'queuedRunRequest',
                appRunId: 'run-1'
              }
            }
          ],
          pendingQueuedAppRunIds: new Set(),
          queuedRunStatusByAppRunId: {
            'run-1': 'steer_promoting'
          }
        })}
      />
    )

    expect(html).toContain('Promoted to dispatch')
    expect(html).not.toContain('Will dispatch')
  })

  it.each(
    RENDERER_PROVIDERS.flatMap((provider) =>
      (['single', 'ensemble'] as const).map((chatKind) => [provider, chatKind] as const)
    )
  )('renders markdown and tool trace parity for %s %s transcript rows', (provider, chatKind) => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          compactDensity: true,
          currentProviderLabel: providerLabel(provider),
          currentProvider: provider,
          currentChat: {
            appChatId: `chat-${provider}-${chatKind}`,
            provider,
            chatKind
          },
          messages: transcriptParityMessages(provider, chatKind)
        })}
      />
    )

    expect(html).toContain('<strong>Bold user</strong>')
    expect(html).toContain('<li>first item</li>')
    expect(html).toContain('message-code-shell')
    expect(html).toContain('message-code-language">ts')
    expect(html).toContain('<strong>System note</strong>')
    expect(html).toContain('<table>')
    expect(html).toContain('<h3>Assistant parity</h3>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<strong>assistant</strong>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('nested child')
    expect(html).toContain('data-link-kind="external"')
    expect(html).toContain('message-code-language">json')
    expect(html).toContain('Git status')
    expect(html).toContain(`provider-${provider}`)
    expect(html).not.toContain('mcp_TaskWraith_git_status')
  })

  it('renders assistant message media refs below assistant markdown', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          currentProviderLabel: 'Codex',
          currentProvider: 'codex',
          currentChat: {
            appChatId: 'chat-assistant-media',
            provider: 'codex',
            chatKind: 'single',
            workspacePath: '/repo'
          },
          messages: [
            {
              id: 'assistant-media',
              role: 'assistant',
              content: '**Generated image attached**',
              timestamp: '2026-01-01T00:00:00.000Z',
              metadata: {
                mediaRefs: [
                  {
                    id: 'media-1',
                    kind: 'image',
                    format: 'raster',
                    source: 'tool_result',
                    name: 'Generated preview',
                    mimeType: 'image/png',
                    thumbnail: {
                      dataBase64: 'thumb',
                      mimeType: 'image/jpeg',
                      width: 2,
                      height: 1
                    },
                    status: 'available'
                  }
                ]
              }
            }
          ]
        })}
      />
    )

    expect(html).toContain('<strong>Generated image attached</strong>')
    expect(html).toContain('message-attachment-thumb is-image')
    expect(html).toContain('src="data:image/jpeg;base64,thumb"')
    expect(html).toContain('Generated preview')
  })

  it('renders user message phone-upload thumbnails from legacy image metadata', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          currentProviderLabel: 'Codex',
          currentProvider: 'codex',
          currentChat: {
            appChatId: 'chat-ios-image',
            provider: 'codex',
            chatKind: 'single',
            workspacePath: '/repo'
          },
          onPreviewImage: () => {},
          messages: [
            {
              id: 'ios-user-image',
              role: 'user',
              content: 'Here is the screenshot',
              timestamp: '2026-01-01T00:00:00.000Z',
              metadata: {
                imagePaths: ['/var/folders/taskwraith-remote-attachments/photo.jpg'],
                imageThumbnails: [
                  {
                    dataBase64: 'phone-thumb',
                    mimeType: 'image/jpeg',
                    width: 256,
                    height: 192
                  }
                ]
              }
            }
          ]
        })}
      />
    )

    expect(html).toContain('Here is the screenshot')
    expect(html).toContain('message-attachment-thumb is-image')
    expect(html).toContain('src="data:image/jpeg;base64,phone-thumb"')
    expect(html).toContain('Preview image photo.jpg')
  })

  it('keeps assistant markdown around grouped tool traces', () => {
    const firstTool: ToolActivity = {
      id: 'activity-read-one',
      toolName: 'read_file',
      displayName: 'Read file',
      category: 'read',
      status: 'success',
      parameters: { file_path: '/repo/src/one.ts' },
      resultSummary: 'read one'
    }
    const secondTool: ToolActivity = {
      ...firstTool,
      id: 'activity-read-two',
      parameters: { file_path: '/repo/src/two.ts' },
      resultSummary: 'read two'
    }
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          currentProviderLabel: 'Codex',
          currentProvider: 'codex',
          currentChat: {
            appChatId: 'chat-tool-ordering',
            provider: 'codex',
            chatKind: 'single'
          },
          messages: [
            {
              id: 'assistant-before-tools',
              role: 'assistant',
              content: '**Before tools**',
              timestamp: '2026-01-01T00:00:00.000Z'
            },
            {
              id: 'tool-one',
              role: 'tool',
              content: '',
              timestamp: '2026-01-01T00:00:01.000Z',
              runId: 'run-tool-ordering',
              toolActivities: [firstTool]
            },
            {
              id: 'tool-two',
              role: 'tool',
              content: '',
              timestamp: '2026-01-01T00:00:02.000Z',
              runId: 'run-tool-ordering',
              toolActivities: [secondTool]
            },
            {
              id: 'assistant-after-tools',
              role: 'assistant',
              content: '## After tools\n\n- grouped trace preserved',
              timestamp: '2026-01-01T00:00:03.000Z'
            }
          ]
        })}
      />
    )

    expect(html).toContain('<strong>Before tools</strong>')
    expect(html).toContain('<h2>After tools</h2>')
    expect(html).toContain('<li>grouped trace preserved</li>')
    expect(html).toContain('tool-group-tool-one')
    expect(html).toContain('Read 2 files')
  })

  it('renders content-only tool messages as markdown fallback bubbles', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          messages: [
            {
              id: 'legacy-tool-content',
              role: 'tool',
              content: '**Legacy tool result**\n\n- visible item',
              timestamp: '2026-01-01T00:00:00.000Z'
            }
          ]
        })}
      />
    )

    expect(html).toContain('tool-message-fallback')
    expect(html).toContain('<strong>Legacy tool result</strong>')
    expect(html).toContain('<li>visible item</li>')
    expect(html).toContain('Actions for tool message')
  })

  it('renders Ollama brand providers with model badges in message headers', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          currentProviderLabel: 'Ollama',
          currentProvider: 'ollama',
          messages: [
            {
              id: 'assistant-qwen35',
              role: 'assistant',
              content: 'Local response',
              timestamp: '2026-01-01T00:00:00.000Z',
              metadata: {
                providerModel: 'qwen3.5:9b',
                providerModelLabel: 'Qwen 3.5 (9B Param)'
              }
            }
          ]
        })}
      />
    )

    expect(html).toContain('provider-alibaba')
    expect(html).toContain('Alibaba')
    expect(html).toContain('Qwen 3.5 (9B Param)')
  })

	  it('renders Ollama run cards with the local model label instead of Gemini fallback', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          currentProviderLabel: 'Ollama',
          currentProvider: 'ollama',
          messages: [
            {
              id: 'm-run-ollama',
              role: 'user',
              content: 'Run this locally',
              timestamp: '2026-01-01T00:00:00.000Z',
              runId: 'run-ollama'
            }
          ],
          currentChat: {
            appChatId: 'chat-ollama',
            provider: 'ollama',
            runs: [
              {
                runId: 'run-ollama',
                provider: 'ollama',
                promptMessageId: 'm-run-ollama',
                requestedModel: 'gpt-oss',
                actualModel: 'gpt-oss',
                startedAt: '2026-01-01T00:00:00.000Z',
                endedAt: '2026-01-01T00:00:18.000Z',
                status: 'success'
              }
            ]
          }
        })}
      />
    )

    expect(html).toContain('run-card-provider provider-openai')
    expect(html).toContain('GPT OSS (20B Param)')
    expect(html).not.toContain('run-card-provider provider-ollama">Gemini')
	  })

	  it('renders multiple pending agent questions in one transcript', () => {
	    const html = renderToStaticMarkup(
	      <TranscriptPanel
	        {...makeProps({
	          virtualize: false,
	          messages: [
	            {
	              id: 'agent-question-q1',
	              role: 'system',
	              content: 'Codex asked a question:',
	              timestamp: '2026-01-01T00:00:00.000Z',
	              metadata: { kind: 'agentQuestion', questionId: 'q1' }
	            },
	            {
	              id: 'agent-question-q2',
	              role: 'system',
	              content: 'Claude asked a question:',
	              timestamp: '2026-01-01T00:00:01.000Z',
	              metadata: { kind: 'agentQuestion', questionId: 'q2' }
	            }
	          ],
	          pendingAgentQuestions: [
	            {
	              questionId: 'q1',
	              appRunId: 'run-1',
	              messageId: 'agent-question-q1',
	              provider: 'codex',
	              question: 'Which path should Codex take?',
	              options: ['A', 'B'],
	              askedAt: 1
	            },
	            {
	              questionId: 'q2',
	              appRunId: 'run-2',
	              messageId: 'agent-question-q2',
	              provider: 'claude',
	              question: 'Should Claude continue?',
	              askedAt: 2
	            }
	          ]
	        })}
	      />
	    )

	    expect(html).toContain('Which path should Codex take?')
	    expect(html).toContain('Should Claude continue?')
	  })

  it('renders a run-result side chat action on historical run boundary cards', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          messages: [
            {
              id: 'm-run',
              role: 'user',
              content: 'Run this task',
              timestamp: '2026-01-01T00:00:00.000Z',
              runId: 'run-1'
            }
          ],
          currentChat: {
            appChatId: 'chat-1',
            provider: 'codex',
            runs: [
              {
                runId: 'run-1',
                provider: 'codex',
                promptMessageId: 'm-run',
                startedAt: '2026-01-01T00:00:00.000Z',
                endedAt: '2026-01-01T00:00:10.000Z',
                status: 'success'
              }
            ]
          },
          onOpenSideChatFromRun: () => {}
        })}
      />
    )

    expect(html).toContain('Open side chat from this run result')
    expect(html).toContain('Side chat')
  })

  it('marks the selected side-chat seed message in the transcript', () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        {...makeProps({
          virtualize: false,
          sideChatSeedMessageId: 'm2',
          onOpenSideChatFromMessage: () => {}
        })}
      />
    )

    expect(html).toContain('is-side-chat-seed')
    expect(html).toContain('data-message-id="m2"')
  })
})
