import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ToolActivity } from '../../../main/store/types'
import {
  getChatTranscriptStore,
  resetChatTranscriptStoreBindingForTests
} from '../lib/useChatTranscript'
import { TranscriptPanel, activityStackSpeakerPresentation } from './TranscriptPanel'

/**
 * Cause 6 of the branding-loss investigation: the transcript's run lookups read
 * `currentChat.runs` directly, and that array is one React render behind by
 * DESIGN. `shouldRetainReactChatOnFlush` (lib/chatChromeIdentity.ts) lists
 * `runs` in `TRANSCRIPT_STREAM_FIELDS`, so a flush whose only deltas are
 * transcript arrays keeps the PREVIOUS chat object and leaves the fresh arrays
 * to ChatTranscriptStore — which is exactly what `resolvedMessages` already
 * reads. Branding never followed.
 *
 * A `role: 'tool'` activity row carries no model of its own (verified against a
 * real profile record: its `metadata` is empty while the assistant bubbles
 * beside it carry `providerModel`), so the run array IS its only brand source.
 * Pi and Ollama are the only two seats whose hue needs a model id at all
 * (`resolveProviderHueClass`), which is why only they visibly revert to the
 * plain seat colour the moment a run settles and the transcript stops growing.
 */

const CEREBRAS_RUN = {
  runId: 'run-pi-cerebras',
  provider: 'pi' as const,
  requestedModel: 'cerebras/qwen-3.8-27b',
  startedAt: '2026-09-11T13:40:43.621Z',
  endedAt: '2026-09-11T13:40:50.946Z',
  status: 'success'
}

const TOOL_ROW: ChatMessage = {
  id: 'tool-pi-cerebras',
  role: 'tool',
  content: '',
  timestamp: '2026-09-11T13:40:47.381Z',
  runId: CEREBRAS_RUN.runId,
  toolActivities: [
    {
      id: 'read-pi-cerebras',
      toolName: 'read_file',
      displayName: 'Read AGENTS.md',
      category: 'read',
      status: 'success',
      metadata: { provider: 'pi' }
    } as ToolActivity
  ]
}

const ASSISTANT_ROW: ChatMessage = {
  id: 'assistant-pi-cerebras',
  role: 'assistant',
  content: 'Here is the picture of this repo.',
  timestamp: '2026-09-11T13:40:50.185Z',
  runId: CEREBRAS_RUN.runId
}

const SECOND_TOOL_ROW: ChatMessage = {
  ...TOOL_ROW,
  id: 'tool-pi-cerebras-2',
  timestamp: '2026-09-11T13:40:48.100Z',
  toolActivities: [
    {
      id: 'read-pi-cerebras-2',
      toolName: 'read_file',
      displayName: 'Read package.json',
      category: 'read',
      status: 'success',
      metadata: { provider: 'pi' }
    } as ToolActivity
  ]
}

const MESSAGES: ChatMessage[] = [TOOL_ROW, ASSISTANT_ROW]
// Two adjacent settled stacks merge into one collapsed super-group, whose lead
// is branded with NO resolved run — the shape `superGroupProviderHueClass` and
// its header use.
const SUPER_GROUP_MESSAGES: ChatMessage[] = [TOOL_ROW, SECOND_TOOL_ROW, ASSISTANT_ROW]

function chatRecord(runs: ChatRecord['runs'], messages: ChatMessage[] = MESSAGES): ChatRecord {
  return {
    appChatId: 'chat-pi-cerebras',
    title: 'hi',
    chatKind: 'single',
    provider: 'pi',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages,
    runs
  } as ChatRecord
}

function renderPanel(currentChat: ChatRecord, messages: ChatMessage[] = MESSAGES): string {
  return renderToStaticMarkup(
    <TranscriptPanel
      {...({
        scrollRef: createRef<HTMLDivElement>(),
        contentRef: createRef<HTMLDivElement>(),
        endRef: createRef<HTMLDivElement>(),
        virtualize: false,
        messages,
        isWelcomeChat: false,
        isThinking: false,
        pendingPlanChoice: null,
        pendingAgentQuestions: [],
        onAgentQuestionSubmit: () => {},
        onAgentQuestionDismiss: () => {},
        runCompleteNotice: null,
        runCompleteDurationText: null,
        currentChat,
        // The run has settled, so the widened `selectCurrentChatRun` seam has
        // nothing open left to hand back — see lib/activeRunSelection.ts.
        currentRun: null,
        currentWorkspacePath: undefined,
        currentProviderLabel: 'Pi',
        currentProvider: 'pi',
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
        onCopyMessage: () => {},
        onDeleteMessage: () => {}
      } as any)}
    />
  )
}

describe('transcript branding reads the store-backed runs', () => {
  beforeEach(() => {
    resetChatTranscriptStoreBindingForTests()
  })

  it('keeps the Cerebras upstream hue when the React chat retained a stale empty runs array', () => {
    // What the flush actually does: ingest the fresh record into the store,
    // then retain the previous React object because only messages/runs changed.
    getChatTranscriptStore().ingest(chatRecord([CEREBRAS_RUN]))
    const html = renderPanel(chatRecord([]))

    // Three INDEPENDENT read sites, each with its own anchor, so reverting any
    // one of them reds a named assertion instead of hiding behind the others:
    // the collapsed stack's accent (activityStackProviderHueClass), the speaker
    // header (ActivityStackSpeakerHeader), and the assistant bubble beside it
    // (assistantRun / assistantRunModel).
    expect(html).toContain('--accent:var(--provider-cerebras-color, var(--accent))')
    expect(html).toContain('aria-label="Activity from Cerebras"')
    expect(html).toContain(
      '<div class="message-group  "><div class="message-meta provider-cerebras">'
    )
    expect(html).not.toContain('provider-pi')
  })

  it('prefers the store over a retained array that names a different upstream', () => {
    // Sharper than the empty case: the retained array can still ANSWER, just
    // wrongly. The previous turn ran DeepSeek, so reading `currentChat.runs`
    // paints this Cerebras row DeepSeek blue rather than merely losing the hue.
    getChatTranscriptStore().ingest(chatRecord([CEREBRAS_RUN]))
    const html = renderPanel(
      chatRecord([
        {
          runId: 'run-pi-previous-turn',
          provider: 'pi',
          requestedModel: 'deepseek/deepseek-v4-flash',
          startedAt: '2026-09-11T13:40:27.195Z',
          endedAt: '2026-09-11T13:40:30.145Z',
          status: 'success'
        }
      ])
    )

    expect(html).toContain('message-meta provider-cerebras')
    expect(html).toContain('>Cerebras</span>')
    expect(html).not.toContain('message-meta provider-deepseek')
  })

  it('still brands from the chat record when the store holds nothing for this chat', () => {
    // The fallback arm of `resolvedRuns` must stay live: a chat the store has
    // never ingested (first paint, popout, fan-out lane viewport) has only the
    // record to read, and this assertion is what keeps that arm from rotting.
    expect(getChatTranscriptStore().has('chat-pi-cerebras')).toBe(false)
    const html = renderPanel(chatRecord([CEREBRAS_RUN]))

    expect(html).toContain('message-meta provider-cerebras')
    expect(html).toContain('>Cerebras</span>')
  })

  it('keeps the upstream hue on a merged super-group whose lead has no resolved run', () => {
    // The folded-away case from the report: two settled stacks collapse into one
    // "Activity" line whose lead is branded with NO `run` prop at all, so both
    // `superGroupProviderHueClass` and its header read the runs argument alone.
    getChatTranscriptStore().ingest(chatRecord([CEREBRAS_RUN], SUPER_GROUP_MESSAGES))
    const html = renderPanel(chatRecord([], SUPER_GROUP_MESSAGES), SUPER_GROUP_MESSAGES)

    expect(html).toContain('--accent:var(--provider-cerebras-color, var(--accent))')
    expect(html).toContain('aria-label="Activity from Cerebras"')
    expect(html).not.toContain('provider-pi')
  })

  it('resolves a super-group header from the runs argument alone', () => {
    // `superGroupProviderHueClass` is the one caller that passes NO resolved
    // `run` — a merged stack's lead is branded purely by the internal lookup,
    // so this is the site the `runs` argument actually carries.
    const presentation = activityStackSpeakerPresentation({
      message: TOOL_ROW,
      chat: chatRecord([]),
      runs: [CEREBRAS_RUN],
      fallbackProvider: 'pi',
      fallbackProviderLabel: 'Pi'
    })

    expect(presentation.label).toBe('Cerebras')
    expect(presentation.providerClass).toBe('cerebras')
  })

  it('falls back to the chat record when no runs argument is supplied', () => {
    // Keeps the default arm alive: TranscriptPanelSpeakerBranding.test.ts and
    // every pre-existing caller omit `runs` entirely.
    const presentation = activityStackSpeakerPresentation({
      message: TOOL_ROW,
      chat: chatRecord([CEREBRAS_RUN]),
      fallbackProvider: 'pi',
      fallbackProviderLabel: 'Pi'
    })

    expect(presentation.label).toBe('Cerebras')
    expect(presentation.providerClass).toBe('cerebras')
  })

  it('does not fabricate an upstream when neither the store nor the record has the run', () => {
    // The honest floor: no run anywhere means no model id, and the seat colour
    // is the correct answer. Without this the fix could "pass" by inventing a
    // brand from the seat's configured model.
    const html = renderPanel(chatRecord([]))

    expect(html).toContain('message-meta provider-pi')
    expect(html).not.toContain('message-meta provider-cerebras')
  })

  it('brands a stamped activity row with no run reachable from anywhere', () => {
    // Defence in depth: `soloToolEventReducer` stamps the run's wire id onto
    // the row it creates, so a row that carries it never needs a run lookup at
    // all. This is the same starting state as the floor test above — empty
    // record, empty store — and the ONLY difference is the row's own metadata.
    const stampedRow: ChatMessage = {
      ...TOOL_ROW,
      metadata: {
        providerModel: 'cerebras/qwen-3.8-27b',
        providerModelLabel: 'Qwen 3.8 27B (Cerebras)'
      }
    }
    const messages = [stampedRow, ASSISTANT_ROW]
    const html = renderPanel(chatRecord([], messages), messages)

    expect(html).toContain('aria-label="Activity from Cerebras"')
    expect(html).toContain('--accent:var(--provider-cerebras-color, var(--accent))')
  })
})
