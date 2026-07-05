import type { RefObject } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  ComposerHighlightOverlay,
  composerHighlightScrollTransform,
  syncComposerHighlightScroll
} from './ComposerHighlightOverlay'

const textareaRef = { current: null } as RefObject<HTMLTextAreaElement | null>

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'ensemble-reviewer',
    provider: 'claude',
    enabled: true,
    role: 'Reviewer',
    instructions: '',
    order: 1,
    model: 'claude-opus-4-7',
    permissionPresetId: 'read_only',
    ...overrides
  }
}

describe('ComposerHighlightOverlay', () => {
  it('mirrors textarea scroll offsets with negative inner-content translation', () => {
    expect(composerHighlightScrollTransform(12, 96)).toBe('translate3d(-12px, -96px, 0)')
    expect(composerHighlightScrollTransform(0, 0)).toBe('translate3d(0px, 0px, 0)')
  })

  it('applies textarea scroll offsets to the overlay content style', () => {
    const content = { style: { transform: '' } } as unknown as Pick<HTMLDivElement, 'style'>

    syncComposerHighlightScroll({ scrollLeft: 18, scrollTop: 42 }, content)

    expect(content.style.transform).toBe('translate3d(-18px, -42px, 0)')
  })

  it('renders a clipping shell and translated content layer for mention text', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value="Please ask @Reviewer for a second pass."
        participants={[participant()]}
        textareaRef={textareaRef}
        syncEpoch="test"
      />
    )

    expect(html).toContain('composer-textarea-highlight')
    expect(html).toContain('composer-textarea-highlight-content')
    expect(html).toContain('composer-mention-token')
    expect(html).toContain('@Reviewer')
  })

  /*
   * 1.0.4-AR1 — pure-function coverage for the scroll-sync helper.
   *
   * The bug pre-AR1: the listener attachment was hosted inside the
   * value-dep effect, so every keystroke tore down + re-attached
   * the scroll listener. Chromium's input-driven
   * auto-scroll-to-caret inside `<textarea>` does not always emit
   * a separate `scroll` event — sometimes it folds the scroll
   * adjustment into the same input dispatch — so on long prompts
   * the overlay stayed pinned to the top while the textarea below
   * scrolled.
   *
   * The fix splits attachment into a textareaRef-only effect and
   * adds a sibling `input` listener that schedules
   * `requestAnimationFrame(syncScroll)`. The transform math
   * itself stays in this small pure helper, which lets us pin
   * its behavior here without a DOM. Live-wiring is covered by
   * the structural snapshot above + the manual smoke test in the
   * dev app.
   */
  it('coerces non-finite scroll offsets (NaN / Infinity) to a no-op transform', () => {
    expect(composerHighlightScrollTransform(Number.NaN, Number.NaN)).toBe(
      'translate3d(0px, 0px, 0)'
    )
    expect(composerHighlightScrollTransform(Infinity, -Infinity)).toBe('translate3d(0px, 0px, 0)')
  })

  it('emits identical-shape transforms for every offset (no fallthrough on large pixels)', () => {
    expect(composerHighlightScrollTransform(1024, 4096)).toBe('translate3d(-1024px, -4096px, 0)')
  })
})
