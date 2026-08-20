import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArchivedThreadsSettings } from './ArchivedThreadsSettings'

describe('ArchivedThreadsSettings', () => {
  it('renders the archive explanation and refresh affordance', () => {
    const html = renderToStaticMarkup(<ArchivedThreadsSettings />)

    expect(html).toContain('Archived threads stay on this device')
    expect(html).toContain('Import an external provider thread')
    expect(html).toContain('never scans provider folders automatically')
    expect(html).toContain('cannot resume the native provider session')
    for (const label of ['Codex', 'Claude', 'Cursor', 'AntiGravity']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('Choose transcript file…')
    expect(html).toContain('Loading…')
  })
})
