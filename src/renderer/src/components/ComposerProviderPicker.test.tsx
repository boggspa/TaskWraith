import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ComposerProviderPicker,
  ComposerProviderPickerRows,
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
    expect(html).toContain('provider-glyph')
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
  it('hides grok + cursor unless their availability flags are set', () => {
    expect(resolveProviderRows(false, false).map((r) => r.id)).toEqual([
      'codex',
      'claude',
      'kimi',
      'ollama'
    ])
  })

  it('appends grok then cursor when both are available (preserving option order)', () => {
    expect(resolveProviderRows(true, true).map((r) => r.id)).toEqual([
      'codex',
      'claude',
      'kimi',
      'grok',
      'cursor',
      'ollama'
    ])
  })

  it('can append cursor without grok', () => {
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

    // A row per live provider (gemini retired)...
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
