import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { ProjectReferenceSourceViewer } from './ProjectReferenceSourceViewer'

it('renders extract text and an optional PDF page map', () => {
  const html = renderToStaticMarkup(
    <ProjectReferenceSourceViewer
      title="spec.pdf"
      text={'Page one text.\n\nPage two text.'}
      pages={[
        { pageNumber: 1, startOffset: 0, endOffset: 14 },
        { pageNumber: 2, startOffset: 16, endOffset: 29 }
      ]}
      onClose={() => undefined}
    />
  )

  expect(html).toContain('spec.pdf')
  expect(html).toContain('Page one text.')
  expect(html).toContain('Page 1')
  expect(html).toContain('Page 2')
  expect(html).toContain('Close')
})
