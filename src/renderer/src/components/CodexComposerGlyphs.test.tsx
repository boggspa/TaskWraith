import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  PermissionApproveGlyphIcon,
  PermissionAskGlyphIcon,
  PermissionElevatedGlyphIcon,
  PermissionPlanGlyphIcon,
  WaveformSymbolIcon
} from './AppChromeSymbols'
import { CombinedPermissionsPicker, permissionModeGlyph } from './CombinedPermissionsPicker'

const read = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')

const permissionOptions = [
  { value: 'plan', label: 'Plan' },
  { value: 'read_only', label: 'Ask' },
  { value: 'default', label: 'Accept Edits' },
  { value: 'workspace_write', label: 'Full WS Access' },
  { value: 'full_access', label: 'Full Access' }
]

const renderChip = (composerStyle: 'codex' | 'claude' | 'default', selected: string): string =>
  renderToStaticMarkup(
    <CombinedPermissionsPicker
      provider="codex"
      composerStyle={composerStyle}
      permissionOptions={permissionOptions}
      selectedPermission={selected}
      onSelectPermission={() => undefined}
    />
  )

describe('Codex composer shell glyphs', () => {
  it('draws the empty-draft send control as a five-bar waveform', () => {
    const html = renderToStaticMarkup(<WaveformSymbolIcon />)
    expect(html.match(/<path d="M[0-9.]+ [0-9.]+v[0-9.]+"/g)).toHaveLength(5)
    expect(html).toContain('<path d="M8 2.5v11"')
    // The Codex parity CSS keys the full-strength send circle off this class:
    // `:disabled` alone also covers "no workspace" and "provider unavailable",
    // where the button must not look live. Renaming it here silently re-breaks
    // that, so the class is part of the glyph's contract.
    expect(html).toContain('composer-waveform-glyph')
  })

  it('draws one permission glyph per Codex approval mode', () => {
    expect(renderToStaticMarkup(<PermissionPlanGlyphIcon />)).toContain(
      'data-permission-glyph="plan"'
    )
    expect(renderToStaticMarkup(<PermissionAskGlyphIcon />)).toContain(
      'data-permission-glyph="ask"'
    )
    expect(renderToStaticMarkup(<PermissionApproveGlyphIcon />)).toContain(
      'data-permission-glyph="approve"'
    )
    expect(renderToStaticMarkup(<PermissionElevatedGlyphIcon />)).toContain(
      'data-permission-glyph="elevated"'
    )
    // Every glyph is a 16-grid stroke icon in the shared sf-symbol wrapper.
    for (const glyph of [
      <PermissionPlanGlyphIcon key="p" />,
      <PermissionAskGlyphIcon key="a" />,
      <PermissionApproveGlyphIcon key="ap" />,
      <PermissionElevatedGlyphIcon key="e" />
    ]) {
      const html = renderToStaticMarkup(glyph)
      expect(html).toContain('class="sf-symbol-icon composer-permission-glyph"')
      expect(html).toContain('viewBox="0 0 16 16"')
    }
  })

  it('maps every real permission value to its glyph', () => {
    const name = (value: string): string | null => {
      const el = permissionModeGlyph(value)
      if (!el) return null
      return renderToStaticMarkup(el).match(/data-permission-glyph="([a-z]+)"/)?.[1] ?? null
    }
    expect(permissionOptions.map((o) => name(o.value))).toEqual([
      'plan',
      'ask',
      'approve',
      'elevated',
      'elevated'
    ])
    expect(name('something-else')).toBeNull()
  })

  it('renders the glyph on the chip for the Codex shell only', () => {
    const codex = renderChip('codex', 'default')
    expect(codex).toContain('data-permission-glyph="approve"')
    expect(codex.indexOf('data-permission-glyph')).toBeLessThan(
      codex.indexOf('composer-combined-picker-trigger-primary')
    )
    expect(renderChip('codex', 'workspace_write')).toContain('data-permission-glyph="elevated"')
    expect(renderChip('claude', 'default')).not.toContain('data-permission-glyph')
    expect(renderChip('default', 'default')).not.toContain('data-permission-glyph')
  })

  it('shows the waveform only while the Codex draft has nothing to send', () => {
    const composer = read('./Composer.tsx')
    const branch = composer.search(
      /appearance\.composerStyle === 'codex'\s*&&\s*!hasSendablePromptContent\s*\?\s*\(/
    )
    expect(branch).toBeGreaterThan(-1)
    expect(composer.slice(branch, branch + 600)).toContain('<WaveformSymbolIcon />')
    expect(composer.slice(branch, branch + 900)).toContain('<ArrowUpSendIcon />')
  })
})
