import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { TRANSCRIPT_WIDTH_ATTRIBUTE, type TranscriptWidth } from '../lib/transcriptWidth'
import { TranscriptPanel } from './TranscriptPanel'

/**
 * The transcript width, proved at the DOM instead of by source string.
 *
 * `data-transcript-width` on `.transcript-inner` is the ONE line that makes the
 * entire CSS half of this setting work: the two `[data-transcript-width]` rules
 * declare `--transcript-column-max-width`, and nothing else in the app declares
 * it. Delete that attribute and the control still renders, still persists, still
 * round-trips through four registries and a popout — and every column stays at
 * Medium. `transcriptWidthSetting.test.ts` used to pin it with a raw-source
 * `toContain`, which a JSX block comment satisfies.
 *
 * So this file renders the panel and reads what lands on the element, the way
 * `TranscriptTextSizeRendering` does for the font scale. The two settings share
 * that element, and the reasons are the same: no jsdom here (this is
 * `renderToStaticMarkup`), which is exactly why an ATTRIBUTE in the first-paint
 * markup is the deliverable rather than something an effect writes on `:root`.
 *
 * The Medium case below is the user's stated requirement, tested rather than
 * asserted: Medium must be byte-identical to having no setting at all.
 */
function message(index: number): ChatMessage {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `WIDTH_${index} sample transcript line`,
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
    // paint needs and casts, exactly as `TranscriptTextSizeRendering.test.tsx`
    // does.
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

describe('the transcript column carries the chosen width', () => {
  it('stamps Wide on the element the width rules scope to', () => {
    // The attribute NAME comes from the module, so a rename that leaves the CSS
    // behind cannot pass by being spelled consistently in this file alone.
    expect(transcriptInnerTag(markup({ transcriptWidth: 'wide' }))).toContain(
      `${TRANSCRIPT_WIDTH_ATTRIBUTE}="wide"`
    )
  })

  it('stamps Narrow on the element the width rules scope to', () => {
    expect(transcriptInnerTag(markup({ transcriptWidth: 'narrow' }))).toContain(
      `${TRANSCRIPT_WIDTH_ATTRIBUTE}="narrow"`
    )
  })

  it('puts the attribute on the transcript column and nowhere else in the tree', () => {
    // Scope, at the DOM. The Default-transcript-view slice shipped the bug this
    // catches: an attribute moved to a different element renders, reads
    // correctly in the DOM inspector, and matches no rule. It would also point
    // the ResizeObserver — which observes `.transcript-inner` — at a box the
    // width rules never reached.
    const html = markup({ transcriptWidth: 'wide' })
    expect(html.split(TRANSCRIPT_WIDTH_ATTRIBUTE).length - 1).toBe(1)
  })

  it('leaves Medium byte-identical to having no setting at all', () => {
    // The user's requirement, as an equality over the rendered bytes rather
    // than a claim about them. An always-emitted `data-transcript-width="medium"`
    // would match no rule and render the same, and would FAIL this —
    // deliberately: the guarantee being kept is that the Medium path IS the old
    // path, not a path that looks like it.
    const chosen = markup({ transcriptWidth: 'medium' })
    const absent = markup()
    expect(chosen).toBe(absent)
    expect(transcriptInnerTag(absent)).not.toContain(TRANSCRIPT_WIDTH_ATTRIBUTE)
    expect(chosen).not.toContain(TRANSCRIPT_WIDTH_ATTRIBUTE)
    // Positive control: this harness DOES produce the attribute when a
    // non-Medium width is chosen, so the negatives above are about Medium and
    // not about the panel never emitting one.
    expect(transcriptInnerTag(markup({ transcriptWidth: 'wide' }))).toContain(
      TRANSCRIPT_WIDTH_ATTRIBUTE
    )
  })

  it('treats a junk persisted value as Medium rather than as a reflow', () => {
    const junk = markup({ transcriptWidth: 'enormous' as TranscriptWidth })
    expect(junk).toBe(markup())
  })

  it('renders the same column markup at Medium as the two other axes do', () => {
    // The three transcript appearance settings share `.transcript-inner`, and
    // their identity claims have to hold TOGETHER: an install at Medium and
    // Default text carries neither the attribute nor the inline style, so the
    // element's opening tag is the pre-settings one.
    const tag = transcriptInnerTag(markup({ transcriptWidth: 'medium' }))
    expect(tag).not.toContain('style=')
    expect(tag).not.toContain('data-transcript-')
    // Positive control for both negatives at once: each axis really can put
    // something on this tag.
    const both = transcriptInnerTag(
      markup({ transcriptWidth: 'narrow', transcriptTextSize: 'large' })
    )
    expect(both).toContain('style=')
    expect(both).toContain(`${TRANSCRIPT_WIDTH_ATTRIBUTE}="narrow"`)
  })
})
