import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FirstRunEnsembleTaskCard } from './FirstRunEnsembleTaskCard'
import { FIRST_RUN_ENSEMBLE_TASK } from '../lib/firstRunEnsembleTask'

describe('FirstRunEnsembleTaskCard', () => {
  it('renders a visible inspection-only sample without claiming to set posture', () => {
    const html = renderToStaticMarkup(<FirstRunEnsembleTaskCard />)

    expect(html).toContain(`data-first-run-ensemble-task="${FIRST_RUN_ENSEMBLE_TASK.id}"`)
    expect(html).toContain('Try this first: a governed workspace review')
    expect(html).toContain('Suggested safe setup')
    expect(html).not.toContain('>Read-only<')
    expect(html).toContain('Nothing runs or changes until you paste and send it yourself.')
    expect(html).toContain('## Ranked verdict')
    expect(html).toContain('Copy task')
  })

  it('keeps the copy control user-authored and does not expose an auto-run action', () => {
    const html = renderToStaticMarkup(<FirstRunEnsembleTaskCard copyText={vi.fn()} />)

    expect(html).not.toContain('Run now')
    expect(html).not.toContain('Start Ensemble')
    expect(html).not.toContain('auto')
    expect(html).toContain('paste and send it yourself')
  })
})
