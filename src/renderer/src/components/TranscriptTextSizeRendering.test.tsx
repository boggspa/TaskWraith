import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { TRANSCRIPT_FONT_SCALE_PROPERTY, type TranscriptTextSize } from '../lib/transcriptTextSize'
import { TranscriptPanel } from './TranscriptPanel'

/**
 * The transcript text size, proved at the DOM instead of by source string.
 *
 * This is the half a source guard cannot reach. `transcriptTextSizeSetting`
 * pins that ONE local feeds both consumers; this file renders the panel and
 * reads what actually lands on `.transcript-inner` — the element every
 * transcript stylesheet scopes the four `--font-size-*` tokens to.
 *
 * No jsdom (this is `renderToStaticMarkup`), which is exactly why the scale is
 * delivered as an INLINE STYLE rather than as a `:root` attribute written from
 * an effect: refs never attach and effects never run here, but an inline style
 * attribute is in the first-paint markup and can be asserted verbatim.
 *
 * The byte-identity case below is the user's stated requirement, tested rather
 * than asserted: selecting Default must leave the app exactly as it is today.
 */
function message(index: number): ChatMessage {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `TEXTSIZE_${index} sample transcript line`,
    timestamp: '2026-01-01T00:00:00.000Z'
  }
}

const MESSAGES: ChatMessage[] = Array.from({ length: 6 }, (_, index) => message(index))

function markup(overrides: Record<string, unknown> = {}): string {
  const props = {
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
    onCopyMessage: () => {},
    onDeleteMessage: () => {},
    virtualize: false,
    ...overrides
    // The panel takes ~150 props; this harness supplies the ones its first
    // paint needs and casts, exactly as `TranscriptPanel.test.tsx` does.
  } as unknown as Parameters<typeof TranscriptPanel>[0]
  return renderToStaticMarkup(<TranscriptPanel {...props} />)
}

/** The opening tag of the transcript column, so nothing loose can satisfy a
 * claim about what that one element carries. */
function transcriptInnerTag(html: string): string {
  const at = html.indexOf('<div class="transcript-inner')
  expect(at, 'the transcript column did not render').toBeGreaterThan(-1)
  return html.slice(at, html.indexOf('>', at) + 1)
}

describe('the transcript column carries the chosen scale', () => {
  it('renders Large at the scale the user decided', () => {
    // The literal 1.25 is the DECISION, not a re-derivation: this assertion is
    // what stops the catalogue quietly re-pointing Large at another number.
    expect(transcriptInnerTag(markup({ transcriptTextSize: 'large' }))).toContain(
      `style="${TRANSCRIPT_FONT_SCALE_PROPERTY}:1.25"`
    )
  })

  it('renders Small at the scale the user decided', () => {
    expect(transcriptInnerTag(markup({ transcriptTextSize: 'small' }))).toContain(
      `style="${TRANSCRIPT_FONT_SCALE_PROPERTY}:0.85"`
    )
  })

  it('puts the scale on the transcript column and nowhere else in the tree', () => {
    // Scope, at the DOM. `.transcript-inner` holds the message rows and the two
    // virtualiser spacers; the composer, the import banner, the gutter rail and
    // the participant filter are outside it. A second occurrence would mean the
    // variable had been hung on a wrapper that contains one of those.
    const html = markup({ transcriptTextSize: 'large' })
    expect(html.split(TRANSCRIPT_FONT_SCALE_PROPERTY).length - 1).toBe(1)
  })

  it('leaves Default byte-identical to having no setting at all', () => {
    // The user's requirement, as an equality over the rendered bytes rather
    // than a claim about them. An always-emitted `--transcript-font-scale:1`
    // would render the same but FAIL this — deliberately: the guarantee being
    // kept is that the Default path is the old path, not merely a path that
    // looks the same.
    const chosen = markup({ transcriptTextSize: 'default' })
    const absent = markup()
    expect(chosen).toBe(absent)
    expect(transcriptInnerTag(absent)).not.toContain('style=')
    expect(chosen).not.toContain(TRANSCRIPT_FONT_SCALE_PROPERTY)
    // Positive control: this harness DOES produce a style attribute when a
    // non-default size is chosen, so the negatives above are about Default and
    // not about the panel never emitting one.
    expect(transcriptInnerTag(markup({ transcriptTextSize: 'large' }))).toContain('style=')
  })

  it('treats a junk persisted value as Default rather than as a resize', () => {
    const junk = markup({ transcriptTextSize: 'enormous' as TranscriptTextSize })
    expect(junk).toBe(markup())
  })
})
