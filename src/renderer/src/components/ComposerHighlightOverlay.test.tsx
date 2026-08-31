import type { RefObject } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import { ComposerHighlightOverlay } from './ComposerHighlightOverlay'
import {
  composerHighlightScrollTransform,
  syncComposerHighlightMetrics,
  syncComposerHighlightScroll
} from './composerHighlightSync'

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

  it('matches the textarea client viewport when a scrollbar consumes inline space', () => {
    const values: Record<string, string> = {
      'box-sizing': 'border-box',
      'border-left-width': '1px',
      'border-right-width': '1px',
      'border-top-width': '1px',
      'border-bottom-width': '1px',
      'padding-left': '8px',
      'padding-right': '8px',
      'padding-top': '6px',
      'padding-bottom': '6px',
      'font-family': 'system-ui',
      'overflow-wrap': 'break-word',
      'white-space': 'pre-wrap'
    }
    const computedStyle = {
      boxSizing: 'border-box',
      getPropertyValue: (property: string) => values[property] || ''
    }
    const style = {
      setProperty(property: string, value: string) {
        values[`copied:${property}`] = value
      },
      width: '',
      minHeight: '',
      borderStyle: '',
      borderColor: '',
      transform: ''
    }
    const content = { style } as unknown as Pick<HTMLDivElement, 'style'>

    syncComposerHighlightMetrics(
      {
        clientWidth: 286,
        clientHeight: 108,
        scrollHeight: 240,
        scrollLeft: 0,
        scrollTop: 32
      },
      content,
      computedStyle
    )

    // 286px is the textarea's padding box after its scrollbar gutter is
    // removed. Adding only the two borders recreates the mirror border box;
    // using the 294px wrapper width here would wrap at different words.
    expect(content.style.width).toBe('288px')
    expect(content.style.minHeight).toBe('242px')
    expect(content.style.transform).toBe('translate3d(0px, -32px, 0)')
    expect(values['copied:font-family']).toBe('system-ui')
    expect(values['copied:overflow-wrap']).toBe('break-word')
    expect(values['copied:white-space']).toBe('pre-wrap')
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

  it('hides structured participant routing syntax behind the formatted tag', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value="Ask [@Reviewer](ensemble-dm://ensemble-reviewer) for a second pass."
        participants={[participant()]}
        textareaRef={textareaRef}
        syncEpoch="test"
      />
    )

    expect(html).toContain('@Reviewer')
    expect(html).not.toContain('ensemble-dm://')
    expect(html).not.toContain('[@Reviewer]')
  })

  it('renders roster-group mentions with the OS-following accent in mention-only mode', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value="@All ask @Reviewers and @BG."
        participants={[]}
        textareaRef={textareaRef}
        syncEpoch="test"
      />
    )

    expect((html.match(/composer-mention-token--group/g) || []).length).toBe(3)
    expect(html).toContain('color:var(--accent)')
    expect(html).not.toContain('--user-bubble-base')
    expect(html).not.toContain('--provider-')
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

  /*
   * 1.0.5 — Tier-A markdown highlighting (richText mode). The main
   * composer opts in; the ensemble brief editor does not — so the
   * default path must stay byte-identical to the mention-only
   * rendering above.
   */
  it('renders markdown flag spans alongside mention tokens in richText mode', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value={'Ask @Reviewer to **review** `parse()` now'}
        participants={[participant()]}
        textareaRef={textareaRef}
        syncEpoch="test"
        richText
      />
    )

    expect(html).toContain('composer-mention-token')
    expect(html).toContain('@Reviewer')
    expect(html).toContain('composer-md-bold')
    expect(html).toContain('composer-md-marker')
    expect(html).toContain('composer-md-code')
    expect(html).toContain('review')
    expect(html).toContain('parse()')
  })

  it('does not emit markdown spans when richText is off (brief-editor path)', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value={'plain **bold** and `code` with @Reviewer'}
        participants={[participant()]}
        textareaRef={textareaRef}
        syncEpoch="test"
      />
    )

    expect(html).toContain('composer-mention-token')
    expect(html).not.toContain('composer-md-')
  })

  it('keeps structured routing syntax hidden in richText mode', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value={'Ask [@Reviewer](ensemble-dm://ensemble-reviewer) for **more**'}
        participants={[participant()]}
        textareaRef={textareaRef}
        syncEpoch="test"
        richText
      />
    )

    expect(html).toContain('@Reviewer')
    expect(html).not.toContain('ensemble-dm://')
    expect(html).toContain('composer-md-bold')
  })

  it('applies a bold flag to a mention wrapped in **…** without splitting the token', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value={'**ping @Reviewer**'}
        participants={[participant()]}
        textareaRef={textareaRef}
        syncEpoch="test"
        richText
      />
    )

    expect(html).toContain('composer-mention-token composer-md-bold')
    expect(html).toContain('@Reviewer')
  })

  it('keeps a group mention intact inside rich markdown highlighting', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value={'**ping @Workers**'}
        participants={[]}
        textareaRef={textareaRef}
        syncEpoch="test"
        richText
      />
    )

    expect(html).toContain('composer-mention-token--group composer-md-bold')
    expect(html).toContain('@Workers')
    expect(html).toContain('color:var(--accent)')
    expect(html).not.toContain('--user-bubble-base')
  })

  it('still renders the ghost suggestion span in richText mode', () => {
    const html = renderToStaticMarkup(
      <ComposerHighlightOverlay
        value=""
        participants={[]}
        textareaRef={textareaRef}
        syncEpoch="test"
        richText
        ghostText="suggested continuation"
      />
    )

    expect(html).toContain('composer-ghost-suggestion')
    expect(html).toContain('suggested continuation')
  })
})
