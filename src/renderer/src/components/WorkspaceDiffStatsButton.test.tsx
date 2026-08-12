import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceDiffStatsButton } from './WorkspaceDiffStatsButton'

describe('WorkspaceDiffStatsButton', () => {
  it('renders the complete diff summary as one native Diff Studio button', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDiffStatsButton filesChanged={2} additions={15} deletions={3} onOpen={vi.fn()} />
    )

    expect(html).toContain('<button type="button"')
    expect(html).toContain(
      'class="composer-above-bar-files-cluster composer-above-bar-stat-clickable"'
    )
    expect(html).toContain(
      'aria-label="Open Diff Studio for 2 uncommitted files in the working tree"'
    )
    expect(html).toContain(' files changed</span>')
    expect(html).toContain('composer-diff-add')
    expect(html).toContain('composer-diff-del')
  })

  it('uses singular copy and keeps zero line stats out of the row', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDiffStatsButton filesChanged={1} additions={0} deletions={0} onOpen={vi.fn()} />
    )

    expect(html).toContain('Open Diff Studio for 1 uncommitted file in the working tree')
    expect(html).toContain(' file changed</span>')
    expect(html).not.toContain('composer-above-bar-stats')
  })

  it('accepts a workspace-scoped title for secondary rows', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDiffStatsButton
        filesChanged={4}
        additions={8}
        deletions={2}
        onOpen={vi.fn()}
        title="Open Diff Studio for 4 changed files in Client demo"
      />
    )

    expect(html).toContain('aria-label="Open Diff Studio for 4 changed files in Client demo"')
    expect(html).toContain('title="Open Diff Studio for 4 changed files in Client demo"')
  })
})
