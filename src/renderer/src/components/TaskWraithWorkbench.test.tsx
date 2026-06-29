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
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="Workbench views"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('aria-controls="workbench-editor-panel"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('aria-keyshortcuts="Meta+P Control+P"')
    expect(html).toContain('aria-keyshortcuts="Meta+1 Control+1"')
    expect(html).toContain('aria-keyshortcuts="Meta+2 Control+2"')
  })
})
