import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { ComposerShellPreview, getComposerPreviewMeta } from './ComposerShellPreview'
import type { ComposerStyle } from '../../../main/store/types'

/**
 * ComposerShellPreview is the single source of truth for the inert composer
 * "shell preview" card rendered in Settings → Appearance AND the onboarding
 * First-Launch sheet. Before it existed, those two surfaces hand-maintained two
 * separate replicas + two separate per-shell metadata tables that had already
 * drifted (the onboarding copy lacked the `terminal` case and carried stale
 * codex/kimi copy).
 *
 * These tests are the drift guard: they pin the structural class contract the
 * live composer's `data-composer-style`-keyed CSS depends on, for EVERY shell in
 * the `ComposerStyle` union, plus the inertness + the per-shell send glyph.
 */

// Mirror of the `ComposerStyle` union (main/store/types.ts). If a shell is added
// to the union, add it here too — the count assertion below fails loudly if the
// two ever diverge.
const ALL_SHELLS: ComposerStyle[] = [
  'default',
  'codex',
  'claude',
  'cursor',
  'grok',
  'gemini',
  'kimi',
  'modular',
  'terminal',
  'stub',
  'satellite',
  'obsidian',
  'alabaster'
]

function render(style: ComposerStyle, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <ComposerShellPreview composerStyle={style} themeAppearance="dark" {...extra} />
  )
}

// The inner markup of the run/send button — lets us assert the glyph differs by
// shell without coupling to specific SVG path data.
function sendGlyph(html: string): string {
  const m = html.match(/aria-label="Preview send button">(.*?)<\/button>/s)
  return m ? m[1] : '__no-send-button__'
}

describe('ComposerShellPreview — shell parity', () => {
  it('renders the exact shell class contract for every composer shell', () => {
    for (const style of ALL_SHELLS) {
      const html = render(style)
      // The card scopes the shell + theme locally (the live composer keys its
      // CSS off these attributes on an ancestor).
      expect(html).toContain('class="settings-composer-preview-card"')
      expect(html).toContain(`data-composer-style="${style}"`)
      expect(html).toContain(`data-interface-style="${style}"`)
      // The composer-area carries the dual class the prior previews + the live
      // composer use; the tightly-coupled FirstLaunchSheet test asserts this too.
      expect(html).toContain(`composer-area settings-composer-preview-area interface-${style}`)
      // Structural skeleton that the shell CSS targets.
      expect(html).toContain('composer-above-bar style-unified')
      expect(html).toContain('class="composer-surface settings-composer-preview-surface"')
      expect(html).toContain('class="composer-inner-module"')
      expect(html).toContain('class="composer-bottom-controls"')
      expect(html).toContain('class="composer-telemetry-row"')
      expect(html.match(/composer-run-timecode/g)?.length).toBe(1)
      // The refractive-glass lens the live composer renders as the first child of
      // the surface — previously absent from both replicas.
      expect(html).toContain('class="composer-refraction-lens"')
    }
  })

  it('keeps the ComposerStyle list in lockstep (catch a new shell)', () => {
    // 13 known shells today. If the union grows, ALL_SHELLS must grow with it.
    expect(ALL_SHELLS.length).toBe(13)
    expect(new Set(ALL_SHELLS).size).toBe(ALL_SHELLS.length)
  })
})

describe('ComposerShellPreview — single metadata source', () => {
  it('returns distinct, non-throwing copy for every shell', () => {
    for (const style of ALL_SHELLS) {
      const meta = getComposerPreviewMeta(style)
      expect(meta.providerLabel).toBeTruthy()
      expect(meta.modelLabel).toBeTruthy()
      expect(meta.permissionLabel).toBeTruthy()
      expect(meta.placeholder).toBeTruthy()
    }
  })

  it('covers the cases the old onboarding copy had drifted on', () => {
    // `terminal` was MISSING from the onboarding table (fell through to default);
    // it now resolves to its own copy from the one shared source.
    expect(getComposerPreviewMeta('terminal').modelLabel).toBe('Shell')
    expect(getComposerPreviewMeta('terminal')).not.toEqual(getComposerPreviewMeta('default'))
    // The canonical claude/codex copy (kept in step with the live composer chip).
    expect(getComposerPreviewMeta('claude').modelLabel).toBe('Opus 4.8')
    expect(getComposerPreviewMeta('claude').permissionLabel).toBe('Plan')
    expect(getComposerPreviewMeta('codex').modelLabel).toBe('GPT-5.5')
  })

  it('renders the resolved metadata into the card', () => {
    const html = render('claude')
    expect(html).toContain('Opus 4.8')
    expect(html).toContain('Plan')
    expect(html).toContain('Claude')
  })
})

describe('ComposerShellPreview — per-shell send glyph', () => {
  it('uses a distinct send glyph for claude vs the pill shells vs native', () => {
    const claude = sendGlyph(render('claude')) // ClaudeReturnSymbolIcon
    const codex = sendGlyph(render('codex')) // ArrowUpSendIcon
    const nativeDefault = sendGlyph(render('default')) // RunSymbolIcon
    const modular = sendGlyph(render('modular')) // RunSymbolIcon (same branch as default)

    expect(claude).not.toBe('__no-send-button__')
    expect(claude).not.toEqual(codex)
    expect(codex).not.toEqual(nativeDefault)
    expect(claude).not.toEqual(nativeDefault)
    // Shells in the same branch share the glyph.
    expect(modular).toEqual(nativeDefault)
  })

  it('labels the above-bar action per shell (Create PR for codex/grok)', () => {
    expect(render('codex')).toContain('Create PR')
    expect(render('grok')).toContain('Create PR')
    expect(render('claude')).toContain('Review changes')
    expect(render('default')).toContain('Review changes')
  })

  it('places the context donut beside the model picker only for the Codex shell', () => {
    const codex = render('codex')
    const codexContext = codex.indexOf('data-composer-control="context"')
    const codexModel = codex.indexOf('data-composer-control="model"')
    expect(codexContext).toBeGreaterThan(-1)
    expect(codexContext).toBeLessThan(codexModel)

    const claude = render('claude')
    expect(claude).not.toContain('data-composer-control="context"')
    const claudeActions = claude.indexOf('class="composer-inline-actions"')
    const claudeContext = claude.indexOf('settings-composer-preview-context', claudeActions)
    const claudeModel = claude.indexOf('data-composer-control="model"')
    expect(claudeActions).toBeGreaterThan(-1)
    expect(claudeContext).toBeGreaterThan(claudeActions)
    expect(claudeContext).toBeGreaterThan(claudeModel)
  })
})

describe('ComposerShellPreview — inertness + modes', () => {
  it('renders a focusable textarea when editable, an inert placeholder otherwise', () => {
    const editable = render('claude', { editable: true, value: 'hello' })
    expect(editable).toContain('<textarea')
    expect(editable).toContain('hello')

    const inert = render('claude')
    expect(inert).not.toContain('<textarea')
    // The placeholder text is rendered into an aria-hidden div instead.
    expect(inert).toContain('Describe a task or ask a question')
  })

  it('marks every control inert (tabindex -1 + aria-hidden regions)', () => {
    const html = render('claude')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-hidden="true"')
    // No live click handlers can be asserted via SSR, but the send button must
    // carry the inert tabindex.
    expect(html).toMatch(/composer-action-btn run-btn"[^>]*tabindex="-1"/)
  })

  it('injects the transcript + composer fonts only when provided', () => {
    const withFonts = render('claude', {
      transcriptFontFamily: 'ZZTranscriptFont',
      composerFontFamily: 'ZZComposerFont',
      editable: true
    })
    expect(withFonts).toContain('ZZTranscriptFont')
    expect(withFonts).toContain('ZZComposerFont')

    // Onboarding passes neither → the preview must not leak those families.
    const noFonts = render('claude')
    expect(noFonts).not.toContain('ZZTranscriptFont')
    expect(noFonts).not.toContain('ZZComposerFont')
  })

  it('scopes the chosen theme onto the card', () => {
    expect(render('claude', { themeAppearance: 'blue' })).toContain('data-theme="blue"')
  })
})
