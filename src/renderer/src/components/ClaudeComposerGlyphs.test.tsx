import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ClaudeMicrophoneSymbolIcon,
  ClaudeReturnSymbolIcon,
  ContextWheel,
  MicrophoneSymbolIcon,
  StopCircleSymbolIcon,
  StopSymbolIcon
} from './AppChromeSymbols'
import { composerPermissionOptions } from '../lib/planModeLabels'
import { CombinedPermissionsPicker, toClaudeSentenceCase } from './CombinedPermissionsPicker'

const read = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')
const pickerSource = read('./CombinedPermissionsPicker.tsx')

const permissionOptions = [
  { value: 'default', label: 'Accept Edits' },
  { value: 'plan', label: 'Plan' }
]

const renderPermission = (composerStyle: 'claude' | 'codex'): string =>
  renderToStaticMarkup(
    <CombinedPermissionsPicker
      provider="claude"
      composerStyle={composerStyle}
      permissionOptions={permissionOptions}
      selectedPermission="default"
      onSelectPermission={() => undefined}
    />
  )

describe('Claude composer shell glyphs', () => {
  it('draws the stop control as a ring with a filled rounded square, leaving the shared square alone', () => {
    const claude = renderToStaticMarkup(<StopCircleSymbolIcon />)
    expect(claude).toContain('<circle cx="8" cy="8" r="6.4"')
    expect(claude).toContain(
      '<rect x="5.4" y="5.4" width="5.2" height="5.2" rx="1.2" fill="currentColor" stroke="none"'
    )

    const shared = renderToStaticMarkup(<StopSymbolIcon />)
    expect(shared).not.toContain('<circle')
    expect(shared).toContain('<rect')
  })

  it("draws the Claude mic without the shared glyph's base bar", () => {
    const shared = renderToStaticMarkup(<MicrophoneSymbolIcon />)
    expect(shared).toContain('M5.9 13.6h4.2')

    const claude = renderToStaticMarkup(<ClaudeMicrophoneSymbolIcon />)
    expect(claude).not.toContain('M5.9 13.6h4.2')
    expect(claude).toContain('<rect x="5.9" y="2" width="4.2" height="7.6" rx="2.1"')
    expect(claude).toContain('M3.6 7.6a4.4 4.4 0 0 0 8.8 0')
    expect(claude).toContain('M8 12v2.2')
  })

  it('draws the return arrow as a top bar turning down into an arrowed bottom bar at a 1.25px stroke', () => {
    const html = renderToStaticMarkup(<ClaudeReturnSymbolIcon />)
    expect(html).toContain('stroke-width="1.25"')
    expect(html).toContain('M6.6 4h5.4a1.6 1.6 0 0 1 1.6 1.6v2.7a1.6 1.6 0 0 1-1.6 1.6H2.4')
    expect(html).toContain('M6 6.3 2.4 9.9 6 13.5')
  })

  it('renders the Claude context ring at a 2px on-screen stroke (2.33 in the 14-unit box at 12px)', () => {
    const claude = renderToStaticMarkup(<ContextWheel percent={40} label="40%" claudeShell />)
    expect(claude).toContain('stroke-width="2.33"')
    const shared = renderToStaticMarkup(<ContextWheel percent={40} label="40%" />)
    expect(shared).toContain('stroke-width="1.7"')
  })

  it('only the Claude shell branches the stop and mic glyphs', () => {
    const composer = read('./Composer.tsx')
    const stopBranch = composer.indexOf(
      "appearance.composerStyle === 'claude' ? (\n                                  <StopCircleSymbolIcon />"
    )
    expect(stopBranch).toBeGreaterThan(0)
    expect(composer.slice(stopBranch, stopBranch + 400)).toContain('<StopSymbolIcon />')

    const voice = read('./ComposerVoiceInput.tsx')
    expect(voice).toContain(
      "composerStyle === 'claude' ? (\n            <ClaudeMicrophoneSymbolIcon />"
    )
    expect(voice).toContain('<MicrophoneSymbolIcon />')
  })

  it('sentence-cases the permission label for the Claude shell only', () => {
    expect(renderPermission('claude')).toContain('>Accept edits<')
    expect(renderPermission('codex')).toContain('>Accept Edits<')

    // The real label set, single source of truth for solo + ensemble pickers.
    const realLabels = composerPermissionOptions().map((option) => option.label)
    expect(realLabels).toEqual(['Plan', 'Ask', 'Accept Edits', 'Full WS Access', 'Full Access'])
    expect(realLabels.map(toClaudeSentenceCase)).toEqual([
      'Plan',
      'Ask',
      'Accept edits',
      'Full WS access',
      'Full access'
    ])

    // Menu rows take the same casing as the chip (source guard: the popover
    // only renders open, which renderToStaticMarkup cannot reach).
    expect(pickerSource).toMatch(
      /composer-combined-picker-row-label">\s*\{displayLabel\(option\.label\)\}\s*<\/span>/
    )
    expect(pickerSource).toContain('{displayLabel(selectedOption.label)}')
    expect(pickerSource).toContain(
      "composerStyle === 'claude' ? toClaudeSentenceCase(label) : label"
    )
  })
})
