import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArchivedThreadsSettings } from './ArchivedThreadsSettings'

describe('ArchivedThreadsSettings', () => {
  it('renders the archive explanation and refresh affordance', () => {
    const html = renderToStaticMarkup(<ArchivedThreadsSettings />)

    expect(html).toContain('Archived threads stay on this device')
    expect(html).toContain('Loading…')
  })
})
