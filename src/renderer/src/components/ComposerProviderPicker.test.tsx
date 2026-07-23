import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ComposerProviderPicker,
  ComposerProviderPickerRows,
  providerRunUnavailableReason,
  resolveProviderRows
} from './ComposerProviderPicker'

function renderTrigger(
  overrides: Partial<Parameters<typeof ComposerProviderPicker>[0]> = {}
): string {
  return renderToStaticMarkup(
    <ComposerProviderPicker
      provider="codex"
      composerStyle="codex"
      grokAvailable={false}
      cursorAvailable={false}
      onSelect={() => undefined}
      title="Provider"
      {...overrides}
    />
  )
}

describe('ComposerProviderPicker trigger', () => {
  it('renders as the composer provider control with the active provider label', () => {
    const html = renderTrigger()

    expect(html).toContain('data-composer-control="provider"')
    expect(html).toContain('composer-picker-label')
    expect(html).toContain('composer-provider-button')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('sidebar-provider-icon')
    expect(html).toContain('data-provider-logo="codex"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-codex')
    // Trigger reflects the active provider's display name.
    expect(html).toContain('Codex')
  })

  it('uses the ensemble-binding title for both the trigger title and aria-label', () => {
    const html = renderTrigger({ title: 'Selected participant provider' })

    expect(html).toContain('title="Selected participant provider"')
    expect(html).toContain('aria-label="Selected participant provider"')
  })

  it('reflects the disabled state on the trigger', () => {
    const html = renderTrigger({ disabled: true })

    expect(html).toContain('disabled')
  })

  it('applies Ollama display-brand hue + label overrides from the active model', () => {
    const html = renderTrigger({
      provider: 'ollama',
      activeModelId: 'qwen3.5:9b'
    })

    expect(html).toContain('provider-alibaba')
    expect(html).toContain('Alibaba')
    expect(html).toContain('--composer-provider-accent:var(--provider-alibaba-color, currentColor)')
  })
})

describe('resolveProviderRows (gated visibility + option order)', () => {
  it('explains why historical Gemini chats cannot run while keeping live providers clear', () => {
    expect(providerRunUnavailableReason('gemini')).toBe(
      'Gemini managed runs are unavailable. Switch this chat to a live provider to continue.'
    )
    expect(providerRunUnavailableReason('claude')).toBeNull()
    expect(providerRunUnavailableReason('cursor')).toBeNull()
    expect(providerRunUnavailableReason('antigravity')).toContain('unavailable')
    expect(providerRunUnavailableReason('antigravity', ['antigravity'])).toBeNull()
  })

  it('hides optional providers unless their availability flags are set', () => {
    expect(resolveProviderRows(false, false).map((r) => r.id)).toEqual([
      'codex',
      'claude',
      'kimi',
      'ollama'
    ])
  })

  it('offers Grok and Path-B Cursor when both availability flags are set', () => {
    expect(resolveProviderRows(true, true).map((r) => r.id)).toEqual([
      'codex',
      'claude',
      'kimi',
      'grok',
      'cursor',
      'ollama'
    ])
  })

  it('offers Cursor when its availability flag is set without requiring Grok', () => {
    expect(resolveProviderRows(false, true).map((r) => r.id)).toEqual([
      'codex',
      'claude',
      'kimi',
      'cursor',
      'ollama'
    ])
  })

  it('labels each row with the provider display name + a descriptor', () => {
    const rows = resolveProviderRows(true, true)
    const claude = rows.find((r) => r.id === 'claude')
    expect(claude?.label).toBe('Claude')
    expect(claude?.description).toBeTruthy()
  })

  it('never offers the retired gemini provider', () => {
    expect(resolveProviderRows(true, true).map((r) => r.id)).not.toContain('gemini')
    expect(resolveProviderRows(false, false).map((r) => r.id)).not.toContain('gemini')
  })

  it('annotates paused providers with their saved reroute target', () => {
    const rows = resolveProviderRows(true, true, {
      codex: {
        paused: true,
        reroute: { provider: 'ollama' }
      }
    })
    const codex = rows.find((r) => r.id === 'codex')

    expect(codex?.pauseLabel).toBe('Paused')
    expect(codex?.rerouteLabel).toBe('reroutes to Ollama')
  })

  it('always offers live-selectable providers even when discovery omits them', () => {
    // A provider is selected — and signed in, if needed — BY picking it, so a
    // background discovery snapshot must never hide a live provider. Here the
    // snapshot only lists claude+cursor, yet every live row still shows.
    expect(
      resolveProviderRows(true, true, undefined, {
        snapshot: { ready: true, providerIds: ['claude', 'cursor'] },
        pendingFallbackProvider: 'codex'
      }).map((row) => row.id)
    ).toEqual(['codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])
  })

  it('offers AntiGravity only when the configured snapshot has admitted it', () => {
    // AntiGravity is the sole discovery-gated row; live providers show alongside it.
    expect(
      resolveProviderRows(false, false, undefined, {
        snapshot: { ready: true, providerIds: ['codex', 'antigravity'] }
      }).map((row) => row.id)
    ).toEqual(['codex', 'claude', 'kimi', 'ollama', 'antigravity'])

    expect(
      resolveProviderRows(false, false, undefined, {
        snapshot: { ready: true, providerIds: ['codex'] }
      }).map((row) => row.id)
    ).not.toContain('antigravity')
  })

  it('keeps live providers visible while discovery is still pending', () => {
    // Cold start (snapshot not ready) must not blank the picker: a user can
    // switch providers before any probe finishes.
    expect(
      resolveProviderRows(true, true, undefined, {
        snapshot: { ready: false, providerIds: [] },
        pendingFallbackProvider: 'kimi'
      }).map((row) => row.id)
    ).toEqual(['codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])
  })

  it('never surfaces retired or flag-gated providers through the configured snapshot', () => {
    // The snapshot cannot smuggle in gemini (retired) or grok (its availability
    // flag is off); only the always-offered live rows remain.
    expect(
      resolveProviderRows(false, false, undefined, {
        snapshot: { ready: true, providerIds: ['gemini', 'grok', 'codex'] }
      }).map((row) => row.id)
    ).toEqual(['codex', 'claude', 'kimi', 'ollama'])
  })
})

describe('ComposerProviderPickerRows (popover body)', () => {
  it('renders one row per provider with a provider icon and label', () => {
    const html = renderToStaticMarkup(
      <ComposerProviderPickerRows
        rows={resolveProviderRows(true, true)}
        activeProvider="claude"
        onSelect={() => undefined}
      />
    )

    // A row per live provider (gemini retired; Cursor Path-B is live)...
    expect(html).not.toContain('data-provider-value="gemini"')
    expect(html).toContain('data-provider-value="codex"')
    expect(html).toContain('data-provider-value="claude"')
    expect(html).toContain('data-provider-value="kimi"')
    expect(html).toContain('data-provider-value="grok"')
    expect(html).toContain('data-provider-value="cursor"')
    // ...each with the shared rich-popover row chrome + a provider icon.
    expect(html).toContain('composer-plus-picker-row')
    expect(html).toContain('composer-plus-picker-row-icon')
    expect(html).toContain('sidebar-provider-icon')
    for (const provider of ['codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama']) {
      expect(html).toContain(`data-provider-logo="${provider}"`)
      expect(html).not.toContain(`provider-glyph-${provider}`)
    }
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).toContain('Claude')
  })

  it('marks the active provider row as selected with a checkmark', () => {
    const html = renderToStaticMarkup(
      <ComposerProviderPickerRows
        rows={resolveProviderRows(false, false)}
        activeProvider="codex"
        onSelect={() => undefined}
      />
    )

    // The active row is the codex one, carrying is-selected + the check.
    expect(html).toMatch(/data-provider-value="codex"[^>]*class="[^"]*is-selected/)
    expect(html).toContain('composer-combined-picker-check')
    // Exactly one checkmark in the body (only the active provider).
    expect(html.match(/composer-combined-picker-check/g)?.length).toBe(1)
  })

  it('omits gated rows when their flags are off', () => {
    const html = renderToStaticMarkup(
      <ComposerProviderPickerRows
        rows={resolveProviderRows(false, false)}
        activeProvider="codex"
        onSelect={() => undefined}
      />
    )

    expect(html).not.toContain('data-provider-value="grok"')
    expect(html).not.toContain('data-provider-value="cursor"')
  })
})
