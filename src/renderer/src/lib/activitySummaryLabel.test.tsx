import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  renderActivitySummaryLabel,
  renderCollapsedStackLabelPart
} from './activitySummaryLabel'

describe('renderActivitySummaryLabel', () => {
  it('highlights Thought / Read / Edited / Ran / System verbs', () => {
    const html = renderToStaticMarkup(
      <>{renderActivitySummaryLabel('Thought for 3s · Read 2 files · Edited a.ts · Ran 1 command')}</>
    )
    expect(html).toContain('class="activity-summary-verb">Thought</span>')
    expect(html).toContain('class="activity-summary-verb">Read</span>')
    expect(html).toContain('class="activity-summary-verb">Edited</span>')
    expect(html).toContain('class="activity-summary-verb">Ran</span>')
    expect(html).not.toContain('class="activity-summary-verb">files</span>')
  })

  it('highlights System and the dual-verb Read/searched label', () => {
    expect(renderToStaticMarkup(<>{renderActivitySummaryLabel('System')}</>)).toContain(
      'class="activity-summary-verb">System</span>'
    )
    const dual = renderToStaticMarkup(
      <>{renderActivitySummaryLabel('Read 2 files and searched 3 times')}</>
    )
    expect(dual).toContain('class="activity-summary-verb">Read</span>')
    expect(dual).toContain('class="activity-summary-verb">searched</span>')
  })
})

describe('renderCollapsedStackLabelPart', () => {
  it('always wraps success verbs and keeps failed verbs red', () => {
    const ok = renderToStaticMarkup(
      <>{renderCollapsedStackLabelPart({ text: 'Edited 2 files', verb: 'Edited' })}</>
    )
    expect(ok).toContain('activity-summary-verb collapsed-activity-stack-verb')
    expect(ok).toContain('>Edited</span> 2 files')
    expect(ok).not.toContain('is-failed')

    const bad = renderToStaticMarkup(
      <>
        {renderCollapsedStackLabelPart({ text: 'Ran 1 command', verb: 'Ran', failed: true })}
      </>
    )
    expect(bad).toContain('is-failed')
    expect(bad).toContain('>Ran</span> 1 command')
  })
})
