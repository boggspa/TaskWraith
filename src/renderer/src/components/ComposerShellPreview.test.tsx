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

function previewProvider(style: ComposerStyle): string {
  if (['codex', 'claude', 'cursor', 'grok', 'gemini', 'kimi'].includes(style)) return style
  return 'codex'
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
      // Composer shells are purely composer chrome now — the retired app-wide
      // `data-interface-style` repaint hook is no longer stamped, and the
      // transcript mock no longer carries an `interface-*` class.
      expect(html).not.toContain('data-interface-style')
      expect(html).toContain(
        `settings-composer-preview-chat app-transcript provider-${previewProvider(style)}"`
      )
      // The composer-area still carries the `interface-*` class the live
      // composer keys its chrome off (`.composer-area.interface-*`).
      expect(html).toContain(`composer-area settings-composer-preview-area interface-${style}`)
      // Structural skeleton that the shell CSS targets.
      expect(html).toContain('composer-above-bar style-unified')
      expect(html).toContain('composer-workspace-above-row')
      expect(html).toContain('class="composer-surface settings-composer-preview-surface"')
      expect(html).toContain('class="composer-inner-module"')
      expect(html).toContain('class="composer-bottom-controls"')
      expect(html).toContain('class="composer-telemetry-row"')
      expect(html).toContain('class="composer-telemetry-cluster"')
      expect(html).toContain('composer-telemetry-side composer-telemetry-side--left')
      expect(html).toContain('composer-telemetry-side composer-telemetry-side--right')
      expect(html).not.toContain('composer-run-timecode')
      expect(html.match(/class="composer-thread-timecodes"/g)?.length).toBe(1)
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

  it('merges provider identity into the model control for every shell', () => {
    for (const style of ALL_SHELLS) {
      const html = render(style)
      expect(html, style).not.toContain('data-composer-control="provider"')
      expect(html, style).toContain('data-composer-control="model"')
      const providerIdentity = html.indexOf('composer-combined-picker-trigger-provider')
      const modelIdentity = html.indexOf('composer-combined-picker-trigger-primary')
      expect(providerIdentity, style).toBeGreaterThan(-1)
      expect(modelIdentity, style).toBeGreaterThan(providerIdentity)
    }
  })

  it('mounts the live picker primitives instead of generic preview controls', () => {
    for (const style of ALL_SHELLS) {
      const html = render(style)
      expect(html, style).toContain('composer-image-picker-btn composer-plus-picker-trigger')
      expect(html, style).toContain('data-composer-control="model"')
      expect(html, style).toContain('data-composer-control="permission"')
      expect(html, style).toContain('class="composer-context-trigger')
      expect(html, style).toContain('class="composer-copy-transcript-button')
      expect(html, style).toContain('data-composer-control="workspace"')
      expect(html, style).not.toContain('settings-composer-preview-control')
      expect(html, style).not.toContain('settings-composer-preview-context')
    }
  })

  it('feeds the canonical controls each shell\'s sample selections', () => {
    const samples: Array<
      [ComposerStyle, string, string, string, string]
    > = [
      ['codex', 'codex', '5.5', 'full_access', 'Full Workspace Access'],
      ['claude', 'claude', 'Opus 4.8', 'plan', 'Plan'],
      ['cursor', 'cursor', 'Composer 2.5', 'default', 'Default Approval'],
      ['grok', 'grok', 'Grok Composer 2.5 Fast', 'default', 'Default Approval'],
      ['gemini', 'gemini', 'Pro 3.1', 'default', 'Default Approval'],
      ['kimi', 'kimi', 'K2.7 Code', 'read_only', 'Read workspace'],
      ['default', 'codex', 'Auto', 'default', 'Default Approval'],
      ['terminal', 'codex', 'Shell', 'default', 'Ask before tools']
    ]

    for (const [style, provider, model, permission, permissionLabel] of samples) {
      const html = render(style)
      expect(html, style).toContain(`data-provider="${provider}"`)
      expect(html, style).toContain(model)
      expect(html, style).toContain(`data-permission-value="${permission}"`)
      expect(html, style).toContain(permissionLabel)
    }

    const kimi = render('kimi')
    expect(kimi).toContain('data-selected-reasoning="on"')
    expect(kimi).toContain('Thinking')

    const native = render('default')
    expect(native).toContain('composer-combined-picker-trigger-provider-label">TaskWraith')
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

  it('uses the commit icon above-bar action for every icon shell', () => {
    const textActionShells = new Set<ComposerStyle>(['claude', 'cursor'])

    for (const style of ALL_SHELLS) {
      const html = render(style)
      if (textActionShells.has(style)) {
        expect(html, style).toContain('class="composer-above-bar-action"')
        expect(html, style).toContain(style === 'claude' ? 'Create PR' : 'Commit')
        expect(html, style).not.toContain('composer-above-bar-action--git-commit-icon')
        expect(html, style).not.toContain('composer-git-commit-trigger-icon')
      } else {
        expect(html, style).toContain(
          'class="composer-above-bar-action composer-above-bar-action--git-commit-icon"'
        )
        expect(html, style).toContain('composer-git-commit-trigger-icon')
      }
    }
  })

  it('renders the Claude Create PR action as a text pill rather than an icon action', () => {
    const html = render('claude')
    const actionPill = html.match(
      /<div class="composer-above-bar-pill composer-above-bar-pill--action">(.*?)<\/div>/s
    )?.[1]

    expect(actionPill).toContain('class="composer-above-bar-action"')
    expect(actionPill).toContain('Create PR')
    expect(actionPill).not.toContain('Review changes')
    expect(actionPill).not.toContain('composer-above-bar-action--git-commit-icon')
    expect(actionPill).not.toContain('composer-git-commit-trigger-icon')
  })

  it('renders the above-row branch label without italic emphasis markup', () => {
    const html = render('codex')

    expect(html).toContain(
      '<span class="composer-above-bar-secondary-branch git-tone-main">main</span>'
    )
    expect(html).not.toContain('<em class="composer-above-bar-secondary-branch')
  })

  it('places the context donut beside the model picker only for the Codex shell', () => {
    const codex = render('codex')
    const codexContext = codex.indexOf('data-composer-control="context"')
    const codexModel = codex.indexOf('data-composer-control="model"')
    expect(codexContext).toBeGreaterThan(-1)
    expect(codexContext).toBeLessThan(codexModel)

    const claude = render('claude')
    const claudeActions = claude.indexOf('class="composer-inline-actions"')
    const claudeContext = claude.indexOf('data-composer-control="context"', claudeActions)
    const claudeModel = claude.indexOf('data-composer-control="model"')
    expect(claudeActions).toBeGreaterThan(-1)
    expect(claudeContext).toBeGreaterThan(claudeActions)
    expect(claudeContext).toBeGreaterThan(claudeModel)

    const cursor = render('cursor')
    expect(cursor).toContain('composer-context-trigger composer-context-trigger--cursor')
    expect(cursor).toContain('composer-context-trigger-pct')
    expect(cursor).toContain('24%')
  })

  it('matches live workspace-row placement for floated and stacked shells', () => {
    for (const style of ['codex', 'cursor'] satisfies ComposerStyle[]) {
      const html = render(style)
      const row = html.indexOf('composer-workspace-above-row')
      const stack = html.indexOf('class="composer-above-bar-stack"')
      expect(row, style).toBeGreaterThan(-1)
      expect(row, style).toBeLessThan(stack)
      expect(html, style).toContain('composer-above-bar--cursor-lead')
    }

    const grok = render('grok')
    const grokStack = grok.indexOf('class="composer-above-bar-stack"')
    const grokRow = grok.indexOf('composer-workspace-above-row')
    expect(grokRow).toBeGreaterThan(grokStack)
    expect(grok).not.toContain('composer-above-bar--cursor-lead')
  })
})

describe('ComposerShellPreview — inertness + modes', () => {
  it('renders the same first-class textarea as editable or inert', () => {
    const editable = render('claude', { editable: true, value: 'hello' })
    expect(editable).toContain('<textarea')
    expect(editable).toContain('hello')
    expect(editable).not.toMatch(/composer-textarea-wrap"[^>]*inert/)

    const inert = render('claude')
    expect(inert).toContain('<textarea')
    expect(inert).toMatch(/composer-textarea-wrap"[^>]*inert=""[^>]*aria-hidden="true"/)
    expect(inert).toContain('placeholder="Describe a task or ask a question"')
    expect(inert).toContain('readOnly=""')
    expect(inert).toContain('tabindex="-1"')
  })

  it('marks live controls inert without disabled-state chrome', () => {
    const html = render('claude')
    expect(html).toMatch(/composer-inline-pickers"[^>]*inert=""[^>]*aria-hidden="true"/)
    expect(html).toMatch(/composer-telemetry-row"[^>]*inert=""[^>]*aria-hidden="true"/)
    expect(html).toMatch(/composer-workspace-above-row[^>]*inert=""[^>]*aria-hidden="true"/)
    expect(html).not.toMatch(/composer-plus-picker-trigger[^>]*disabled/)
    expect(html).not.toMatch(/data-composer-control="model"[^>]*disabled/)
    expect(html).not.toMatch(/data-composer-control="permission"[^>]*disabled/)
    expect(html).not.toMatch(/composer-action-btn run-btn[^>]*disabled/)
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
