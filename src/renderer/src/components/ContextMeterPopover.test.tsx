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
})
