import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MeterRow, nextExpandedContextRow } from './ContextMeterPopover'

describe('ContextMeterPopover accordion', () => {
  it('keeps at most one participant expanded', () => {
    let expanded: string | null = null
    expanded = nextExpandedContextRow(expanded, 'participant-a')
    expect(expanded).toBe('participant-a')
    expanded = nextExpandedContextRow(expanded, 'participant-b')
    expect(expanded).toBe('participant-b')
    expanded = nextExpandedContextRow(expanded, 'participant-b')
    expect(expanded).toBeNull()
  })

  it('associates the expanded row toggle with a labelled details region', () => {
    const html = renderToStaticMarkup(
      <MeterRow
        row={{
          id: 'participant-a',
          primary: 'Builder',
          detail: 'Claude · Sonnet',
          provider: 'claude',
          providerClass: 'claude',
          usedTokens: 20_000,
          windowTokens: 200_000,
          percent: 10
        }}
        expanded
        onToggleExpanded={() => {}}
      />
    )
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1]
    const labelledBy = html.match(/role="region" aria-labelledby="([^"]+)"/)?.[1]

    expect(controls).toBeTruthy()
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain(`id="${controls}" role="region"`)
    expect(labelledBy).toBe(`${controls}-toggle`)
    expect(html).toContain(`id="${labelledBy}"`)
  })

  it('renders the per-model ingest slider only for override-eligible models', () => {
    const base = {
      id: 'participant-a',
      primary: 'Scout',
      detail: 'Ollama · Qwen3 4B',
      providerClass: 'ollama',
      usedTokens: 5_000,
      windowTokens: 262_144,
      percent: 2
    }
    const eligible = renderToStaticMarkup(
      <MeterRow
        row={{ ...base, provider: 'ollama', modelId: 'qwen3:4b' }}
        expanded
        onToggleExpanded={() => {}}
      />
    )
    expect(eligible).toContain('data-testid="ensemble-ingest-override"')

    const ineligible = renderToStaticMarkup(
      <MeterRow
        row={{ ...base, provider: 'claude', providerClass: 'claude', modelId: 'claude-sonnet-5' }}
        expanded
        onToggleExpanded={() => {}}
      />
    )
    expect(ineligible).not.toContain('data-testid="ensemble-ingest-override"')
    // Ineligible models size ingest automatically — no slider, no dead space.
    const sparkEligible = renderToStaticMarkup(
      <MeterRow
        row={{ ...base, provider: 'codex', providerClass: 'codex', modelId: 'gpt-5.3-codex-spark' }}
        expanded
        onToggleExpanded={() => {}}
      />
    )
    expect(sparkEligible).toContain('data-testid="ensemble-ingest-override"')
  })
})
