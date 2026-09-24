import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import {
  transcriptChatIdentityEqual,
  transcriptPanelPropsEqual,
  type TranscriptPanelMemoComparable
} from './transcriptPanelMemoProps'

function chat(title: string, messages: ChatRecord['messages']): ChatRecord {
  return {
    appChatId: 'chat-a',
    title,
    createdAt: 1,
    updatedAt: 10,
    archived: false,
    messages,
    runs: []
  }
}

function baseProps(
  overrides: Partial<TranscriptPanelMemoComparable> = {}
): TranscriptPanelMemoComparable {
  const messages: ChatRecord['messages'] = []
  const currentChat = chat('A', messages)
  return {
    scrollRef: { current: null },
    contentRef: { current: null },
    endRef: { current: null },
    messages,
    isWelcomeChat: false,
    isThinking: false,
    pendingPlanChoice: null,
    pendingProposedPlan: null,
    pendingAgentQuestions: [],
    onAgentQuestionSubmit: () => {},
    onAgentQuestionDismiss: () => {},
    runCompleteNotice: null,
    runCompleteDurationText: null,
    currentRun: null,
    currentChat,
    currentProviderLabel: 'Codex',
    currentProvider: 'codex',
    displayFileChangeSummaries: [],
    fileChangeSummaryText: '',
    fileChangeShouldShowStats: false,
    fileChangeDisplayAdds: 0,
    fileChangeDisplayDels: 0,
    chats: [currentChat],
    runningChatIds: [],
    onCopyMessage: () => {},
    onDeleteMessage: () => {},
    onPreviewImage: () => {},
    copiedId: null,
    copy: () => {},
    compactDensity: false,
    ...overrides
  }
}

describe('transcriptPanelMemoProps', () => {
  it('treats currentChat object-identity churn as equal when transcript identity matches', () => {
    const messages: ChatRecord['messages'] = []
    const left = chat('Same', messages)
    const right = { ...left }
    expect(left).not.toBe(right)
    expect(transcriptChatIdentityEqual(left, right)).toBe(true)
  })

  it('invalidates when messages reference changes', () => {
    const left = chat('Same', [])
    const right = chat('Same', [{ id: 'm', role: 'user', content: 'x', createdAt: 1 } as never])
    expect(transcriptChatIdentityEqual(left, right)).toBe(false)
  })

  it('does not require currentChat === for panel props equality', () => {
    const messages: ChatRecord['messages'] = []
    const currentChat = chat('A', messages)
    const shared = baseProps({ messages, currentChat, chats: [currentChat] })
    const nextChat = { ...currentChat }
    const next = { ...shared, currentChat: nextChat }
    expect(shared.currentChat).not.toBe(next.currentChat)
    expect(transcriptChatIdentityEqual(shared.currentChat, next.currentChat)).toBe(true)
    expect(transcriptPanelPropsEqual(shared, next)).toBe(true)
  })

  it('invalidates when the Appearance transcript-view default changes', () => {
    // This comparable type is structurally `unknown` per field, so a new prop
    // on TranscriptPanelProps type-checks whether or not it is listed here.
    // Unlisted, the MAIN pane and the SIDE CHAT both freeze on the old default
    // — the panel consumes this one inside its own render (it is the fallback
    // argument to `useTranscriptView`), with no `:root` attribute to repaint
    // around React the way `fanoutLaneLayout` has.
    const shared = baseProps()
    expect(transcriptPanelPropsEqual(shared, { ...shared, defaultTranscriptView: 'minimal' })).toBe(
      false
    )
    expect(
      transcriptPanelPropsEqual(
        { ...shared, defaultTranscriptView: 'tools' },
        { ...shared, defaultTranscriptView: 'standard' }
      )
    ).toBe(false)
    // Positive control: unchanged still compares equal, so the two above are
    // this field moving and not the comparator returning false for everything.
    expect(
      transcriptPanelPropsEqual(
        { ...shared, defaultTranscriptView: 'minimal' },
        { ...shared, defaultTranscriptView: 'minimal' }
      )
    ).toBe(true)
  })

  it('invalidates when the Appearance transcript TEXT SIZE changes', () => {
    // The worst of the three to miss, because the panel resolves this one to a
    // NUMBER in its own render: that number is both the
    // `--transcript-font-scale` it stamps on `.transcript-inner` and the
    // `TranscriptLayoutEpoch.fontScale` every height estimate, the pre-paint
    // measure pass and every height-cache key are built from. Unlisted, nothing
    // re-renders on a size change — and "the setting does nothing" is exactly
    // how that presents, in the MAIN pane and the SIDE CHAT alike, because the
    // Settings takeover hides `.app-transcript` with `display: none` rather
    // than unmounting it.
    const shared = baseProps()
    expect(transcriptPanelPropsEqual(shared, { ...shared, transcriptTextSize: 'large' })).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        { ...shared, transcriptTextSize: 'small' },
        { ...shared, transcriptTextSize: 'large' }
      )
    ).toBe(false)
    // Positive control: unchanged still compares equal, so the two above are
    // this field moving and not the comparator refusing everything.
    expect(
      transcriptPanelPropsEqual(
        { ...shared, transcriptTextSize: 'large' },
        { ...shared, transcriptTextSize: 'large' }
      )
    ).toBe(true)
  })

  it('invalidates when the Appearance transcript WIDTH changes', () => {
    // Called, not read out of the source. Order 10 pinned the text-size entry in
    // this comparator BEHAVIOURALLY, right above; the width entry shipped pinned
    // only by `toContain('previous.transcriptWidth === next.transcriptWidth &&')`
    // over the raw file — which a comment satisfies, and which cannot tell an
    // `&&` from a `||`.
    //
    // Worse to miss than the text size, because the width has a second
    // consumer: `.transcript-inner`'s `data-transcript-width` is rendered by
    // this component, so an uncompared width leaves the COLUMN at the old cap as
    // well as the estimator. And the Settings takeover hides `.app-transcript`
    // with `display: none` rather than unmounting it, so returning from Settings
    // forces no render of its own.
    const shared = baseProps()
    expect(transcriptPanelPropsEqual(shared, { ...shared, transcriptWidth: 'wide' })).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        { ...shared, transcriptWidth: 'narrow' },
        { ...shared, transcriptWidth: 'wide' }
      )
    ).toBe(false)
    // Medium is the default and is spelled as absence in a settings file that
    // predates the control, so the two spellings of "Medium" must also be
    // distinguished — the panel resolves them to the same render, but the
    // comparator is what decides whether that render happens at all.
    expect(
      transcriptPanelPropsEqual(
        { ...shared, transcriptWidth: undefined },
        { ...shared, transcriptWidth: 'wide' }
      )
    ).toBe(false)
    // Positive control: unchanged still compares equal, so the three above are
    // this field moving and not the comparator refusing everything.
    expect(
      transcriptPanelPropsEqual(
        { ...shared, transcriptWidth: 'wide' },
        { ...shared, transcriptWidth: 'wide' }
      )
    ).toBe(true)
  })

  it('re-renders when the fan-out lane layout changes', () => {
    // This key was MISSING from the comparator, excused by a comment claiming
    // its effect is only a `:root` attribute CSS reads outside React. It is
    // not: TranscriptPanel derives `pairFanoutLanes` from it in JS, and that
    // boolean feeds the projection estimate, the slot map and the measurement
    // pass. Uncompared, switching Fan-out lanes in Settings and returning to
    // the app left the panel on the old layout — the takeover hides
    // `.app-transcript` with `display: none` rather than unmounting it, so
    // nothing forces the re-render an unmount would have.
    const shared = baseProps()
    expect(transcriptPanelPropsEqual(shared, { ...shared, fanoutLaneLayout: 'stacked' })).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        { ...shared, fanoutLaneLayout: 'paired' },
        { ...shared, fanoutLaneLayout: 'stacked' }
      )
    ).toBe(false)
    // Positive control: unchanged still compares equal, so the two above are
    // this field moving and not the comparator refusing everything.
    expect(
      transcriptPanelPropsEqual(
        { ...shared, fanoutLaneLayout: 'stacked' },
        { ...shared, fanoutLaneLayout: 'stacked' }
      )
    ).toBe(true)
  })

  it('guards TranscriptPanel against currentChat === memo keying', () => {
    const source = readFileSync(
      new URL('../components/TranscriptPanel.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('transcriptPanelPropsEqual')
    expect(source).not.toMatch(/previous\.currentChat === next\.currentChat/)
  })

  it('invalidates when citation open or extract-resolve handler identity changes', () => {
    const shared = baseProps()
    const openA = () => undefined
    const openB = () => undefined
    const resolveA = () => null
    expect(
      transcriptPanelPropsEqual(shared, {
        ...shared,
        onOpenProjectReferenceCitation: openA,
        resolveProjectReferenceExtract: resolveA
      })
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        { ...shared, onOpenProjectReferenceCitation: openA },
        { ...shared, onOpenProjectReferenceCitation: openB }
      )
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        { ...shared, onOpenProjectReferenceCitation: openA, resolveProjectReferenceExtract: resolveA },
        { ...shared, onOpenProjectReferenceCitation: openA, resolveProjectReferenceExtract: resolveA }
      )
    ).toBe(true)
  })

  it('invalidates when fleet child pending approval maps or respond handler change', () => {
    const shared = baseProps()
    const respondA = () => undefined
    const respondB = () => undefined
    const approval = { id: 'apr-1' }
    expect(
      transcriptPanelPropsEqual(shared, {
        ...shared,
        pendingAgentApprovalByChatId: { 'child-1': approval as never }
      })
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        {
          ...shared,
          pendingAgentApprovalByChatId: { 'child-1': approval as never },
          pendingApprovalQueueByChatId: {},
          onRespondAgentApproval: respondA
        },
        {
          ...shared,
          pendingAgentApprovalByChatId: { 'child-1': approval as never },
          pendingApprovalQueueByChatId: {},
          onRespondAgentApproval: respondA
        }
      )
    ).toBe(true)
    expect(
      transcriptPanelPropsEqual(
        {
          ...shared,
          pendingAgentApprovalByChatId: { 'child-1': approval as never },
          onRespondAgentApproval: respondA
        },
        {
          ...shared,
          pendingAgentApprovalByChatId: { 'child-1': { id: 'apr-2' } as never },
          onRespondAgentApproval: respondA
        }
      )
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        { ...shared, onRespondAgentApproval: respondA },
        { ...shared, onRespondAgentApproval: respondB }
      )
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(
        {
          ...shared,
          pendingApprovalQueueByChatId: { 'child-1': [approval as never] }
        },
        {
          ...shared,
          pendingApprovalQueueByChatId: { 'child-1': [{ id: 'apr-2' } as never] }
        }
      )
    ).toBe(false)
  })

  it('invalidates when in-chat search query, matches, or active row change', () => {
    // Without these three the panel never re-renders on a keystroke, so the
    // highlight pass never runs and the counter is again the only feedback.
    const shared = baseProps({
      threadSearchQuery: 'alpha',
      threadSearchMatchRowKeys: new Set(['m-1#0']),
      threadSearchActiveRowKey: 'm-1#0'
    })
    expect(transcriptPanelPropsEqual(shared, { ...shared, threadSearchQuery: 'beta' })).toBe(false)
    expect(
      transcriptPanelPropsEqual(shared, {
        ...shared,
        threadSearchMatchRowKeys: new Set(['m-2#0'])
      })
    ).toBe(false)
    expect(
      transcriptPanelPropsEqual(shared, { ...shared, threadSearchActiveRowKey: 'm-2#0' })
    ).toBe(false)
    // Same membership under a fresh Set object must NOT force a repaint.
    expect(
      transcriptPanelPropsEqual(shared, {
        ...shared,
        threadSearchMatchRowKeys: new Set(['m-1#0'])
      })
    ).toBe(true)
  })

  it('invalidates on execution-only progress and control changes', () => {
    const shared = baseProps()
    const open = () => undefined
    const cancel = () => undefined
    const baseView = {
      executionId: 'execution-1',
      state: 'running',
      settled: false,
      counts: {
        total: 2,
        proposed: 1,
        queued: 1,
        running: 0,
        needsAction: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        settled: 0
      },
      cells: [
        { id: 'scout-1', status: 'queued', kind: 'solo_agent' },
        { id: 'scout-2', status: 'proposed', kind: 'solo_agent' }
      ]
    }
    const left = {
      ...shared,
      hasLiveOwnedExecution: true,
      ownedExecutionViews: [baseView],
      onOpenExecutionMapForThread: open,
      onCancelOwnedExecution: cancel
    }
    expect(
      transcriptPanelPropsEqual(left, { ...left, ownedExecutionViews: [{ ...baseView }] })
    ).toBe(true)
    expect(
      transcriptPanelPropsEqual(left, {
        ...left,
        ownedExecutionViews: [
          {
            ...baseView,
            counts: { ...baseView.counts, queued: 0, running: 1 },
            cells: [{ ...baseView.cells[0], status: 'working' }, baseView.cells[1]]
          }
        ]
      })
    ).toBe(false)
    expect(transcriptPanelPropsEqual(left, { ...left, hasLiveOwnedExecution: false })).toBe(false)
    expect(
      transcriptPanelPropsEqual(left, { ...left, onCancelOwnedExecution: () => undefined })
    ).toBe(false)
  })
})
