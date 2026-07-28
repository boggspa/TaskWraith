import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
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

  it('applies every Pi upstream hue + label override from the active model', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const activeModelId = Object.keys(PI_MODEL_LABELS).find((id) =>
        id.startsWith(`${upstream}/`)
      )
      expect(activeModelId, `missing representative Pi model for ${upstream}`).toBeTruthy()
      const html = renderTrigger({ provider: 'pi', activeModelId })

      expect(html).toContain(`provider-${brand.hueClass}`)
      expect(html).toContain(`>${brand.label}<`)
      expect(html).toContain(
        `--composer-provider-accent:var(--provider-${brand.hueClass}-color, currentColor)`
      )
      expect(html).toContain('data-provider-logo="pi"')
    }
  })
})

describe('resolveProviderRows (additive visibility + option order)', () => {
  it('explains why historical Gemini chats cannot run while keeping live providers clear', () => {
    expect(providerRunUnavailableReason('gemini')).toBe(
      'Gemini is retired for new runs; historical chats remain available. Choose a currently offered provider to continue.'
    )
    expect(providerRunUnavailableReason('claude')).toBeNull()
    expect(providerRunUnavailableReason('cursor')).toBeNull()
    expect(providerRunUnavailableReason('antigravity')).toContain('consent or Gemini API setup')
    expect(providerRunUnavailableReason('antigravity', ['antigravity'])).toBeNull()
  })

  it('offers every statically live provider when legacy readiness flags are false', () => {
    expect(resolveProviderRows(false, false).map((r) => r.id)).toEqual([
      ...LIVE_SELECTABLE_PROVIDER_IDS
    ])
  })

  it('does not change the static offer set when legacy readiness flags are true', () => {
    expect(resolveProviderRows(true, true).map((r) => r.id)).toEqual([
      ...LIVE_SELECTABLE_PROVIDER_IDS
    ])
  })

  it('keeps both Cursor and Grok visible when only one legacy readiness flag is true', () => {
    const ids = resolveProviderRows(false, true).map((r) => r.id)
    expect(ids).toContain('cursor')
    expect(ids).toContain('grok')
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
    ).toEqual([...LIVE_SELECTABLE_PROVIDER_IDS])
  })

  it('offers AntiGravity only when the configured snapshot has admitted it', () => {
    // AntiGravity is the sole configured-snapshot-gated row; live providers
    // show alongside it. AntiGravity ranks immediately above local Ollama.
    expect(
      resolveProviderRows(false, false, undefined, {
        snapshot: { ready: true, providerIds: ['codex', 'antigravity'] }
      }).map((row) => row.id)
    ).toEqual([
      'codex',
      'claude',
      'kimi',
      'cursor',
      'grok',
      'antigravity',
      'ollama',
      'pi',
      'mistral'
    ])

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
    ).toEqual([...LIVE_SELECTABLE_PROVIDER_IDS])
  })

  it('never surfaces retired providers through the configured snapshot', () => {
    // The snapshot cannot smuggle in Gemini (retired). Grok remains present
    // because it is statically live even when its legacy readiness flag is off.
    expect(
      resolveProviderRows(false, false, undefined, {
        snapshot: { ready: true, providerIds: ['gemini', 'grok', 'codex'] }
      }).map((row) => row.id)
    ).toEqual([...LIVE_SELECTABLE_PROVIDER_IDS])
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

    // A row per live provider (Gemini remains retired/history-only)...
    expect(html).not.toContain('data-provider-value="gemini"')
    expect(html).toContain('data-provider-value="codex"')
    expect(html).toContain('data-provider-value="claude"')
    expect(html).toContain('data-provider-value="kimi"')
    expect(html).toContain('data-provider-value="grok"')
    expect(html).toContain('data-provider-value="cursor"')
    expect(html).toContain('data-provider-value="ollama"')
    expect(html).toContain('data-provider-value="pi"')
    expect(html).toContain('data-provider-value="mistral"')
    // ...each with the shared rich-popover row chrome + a provider icon.
    expect(html).toContain('composer-plus-picker-row')
    expect(html).toContain('composer-plus-picker-row-icon')
    expect(html).toContain('sidebar-provider-icon')
    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
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

  it('does not omit live rows when legacy readiness flags are off', () => {
    const html = renderToStaticMarkup(
      <ComposerProviderPickerRows
        rows={resolveProviderRows(false, false)}
        activeProvider="codex"
        onSelect={() => undefined}
      />
    )

    for (const provider of LIVE_SELECTABLE_PROVIDER_IDS) {
      expect(html).toContain(`data-provider-value="${provider}"`)
    }
    expect(html).not.toContain('data-provider-value="gemini"')
    expect(html).not.toContain('data-provider-value="antigravity"')
  })
})
