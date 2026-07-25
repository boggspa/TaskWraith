import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerThreadTimecodeBar } from './ComposerTimecodes'

describe('ComposerThreadTimecodeBar centre slot', () => {
  it('renders turn → centre → total so the satellite pill sits between the timecodes', () => {
    const html = renderToStaticMarkup(
      <ComposerThreadTimecodeBar
        running={false}
        startedAt={null}
        cumulativeBaseMs={0}
        center={<span data-testid="satellite-probe">PR</span>}
      />
    )
    const turnIndex = html.indexOf('composer-thread-timecode--turn')
    const centerIndex = html.indexOf('composer-thread-timecodes-center')
    const probeIndex = html.indexOf('satellite-probe')
    const totalIndex = html.indexOf('composer-thread-timecode--total')
    expect(turnIndex).toBeGreaterThan(-1)
    expect(centerIndex).toBeGreaterThan(turnIndex)
    expect(probeIndex).toBeGreaterThan(centerIndex)
    expect(totalIndex).toBeGreaterThan(probeIndex)
  })

  it('keeps the centre span mounted when empty so the 1fr/auto/1fr grid columns stay stable', () => {
    const html = renderToStaticMarkup(
      <ComposerThreadTimecodeBar running={false} startedAt={null} cumulativeBaseMs={0} />
    )
    expect(html).toContain('composer-thread-timecodes-center')
  })
})
