import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../components/Composer.tsx', import.meta.url), 'utf8')
const externalRowSource = readFileSync(
  new URL('../components/ExternalPathAboveRow.tsx', import.meta.url),
  'utf8'
)
const layoutSource = readFileSync(
  new URL('../app/views/MainAppLayout.tsx', import.meta.url),
  'utf8'
)

describe('Commits Inspector repository routing', () => {
  it('opens the primary and secondary sync values with their own checkout paths', () => {
    expect(composerSource).toContain('() => openWorkspaceCommitsInInspector(primaryGitActionPath)')
    expect(composerSource).toContain('() => openWorkspaceCommitsInInspector(group.path)')
    expect(externalRowSource).toContain(
      '<GitSyncChip snapshot={snapshot} onOpenCommits={onOpenCommits} />'
    )
  })

  it('keeps a repository override for direct navigation and current checkout fallback for Home', () => {
    expect(appSource).toContain(
      'const [commitsInspectorWorkspacePath, setCommitsInspectorWorkspacePath]'
    )
    expect(appSource).toContain("openInspectorTab('commits', targetPath)")
    expect(layoutSource).toContain("rightTab === 'commits'")
    expect(layoutSource).toContain(
      'commitsInspectorWorkspacePath ||\n                    currentGitPresentationPath ||'
    )
    expect(layoutSource).toContain('onSelectInspectorTab={(id) => openInspectorTab(id)}')
    expect(layoutSource).toContain(
      'onOpenInspector={(destination) => openInspectorTab(destination)}'
    )
  })

  it('projects a resting Multiview pane before opening its repository', () => {
    expect(appSource).toContain('openWorkspaceCommitsInInspector: (workspacePath?: string) => {')
    expect(appSource).toContain('projectMultiviewPaneToHost(viewerPaneIndex, viewerChatId)')
    expect(appSource).toContain(
      'composerHandlers.openWorkspaceCommitsInInspector(\n            workspacePath || viewerGitPresentationPath'
    )
  })
})
