import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TaskWraithWorkbench } from './TaskWraithWorkbench'

describe('TaskWraithWorkbench shell', () => {
  it('renders editor command controls and lifted status summary', () => {
    const html = renderToStaticMarkup(
      <TaskWraithWorkbench
        workspacePath="/repo"
        workspaceName="Repo"
        refreshTick={0}
        onDirtyChange={() => {}}
      />
    )

    expect(html).toContain('TaskWraith Workbench')
    expect(html).toContain('Quick Open')
    expect(html).toContain('Save All')
    expect(html).toContain('No open files')
    expect(html).toContain('No wrap')
    expect(html).toContain('aria-keyshortcuts="Meta+P Control+P"')
  })
})
