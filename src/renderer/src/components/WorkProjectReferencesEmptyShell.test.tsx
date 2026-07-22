import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorkProjectReferencesEmptyShell } from './WorkProjectReferencesEmptyShell'

describe('WorkProjectReferencesEmptyShell', () => {
  it('renders a non-mutating empty state for Work with no selected project', () => {
    const html = renderToStaticMarkup(<WorkProjectReferencesEmptyShell />)

    expect(html).toContain('aria-label="Project references"')
    expect(html).toContain('References')
    expect(html).toContain('Select a Project in Work')
    expect(html).not.toContain('project-references-dock-close')
  })
})
