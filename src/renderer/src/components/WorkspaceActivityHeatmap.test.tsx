import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkspaceActivityHeatmap } from './WorkspaceActivityHeatmap'

const heatmapSource = readFileSync(
  new URL('./WorkspaceActivityHeatmap.tsx', import.meta.url),
  'utf8'
)
const heatmapCss = readFileSync(
  new URL('../assets/css/02-transcript-messages-fx.css', import.meta.url),
  'utf8'
)

describe('WorkspaceActivityHeatmap', () => {
  it('renders an empty heatmap shell before the async snapshot arrives', () => {
    const html = renderToStaticMarkup(
      <WorkspaceActivityHeatmap workspacePath="/repo" dayCount={90} />
    )

    expect(html).toContain('Workspace Activity')
    expect(html).toContain('usage-heatmap--workspace-activity')
    expect(html).toContain('90D <strong>0</strong>')
    expect((html.match(/workspace-activity-heatmap-cell/g) || []).length).toBe(90 * 12)
  })

  it('uses a fixed GitHub-green ramp instead of the workspace accent', () => {
    expect(heatmapSource).toContain("const WORKSPACE_ACTIVITY_HEATMAP_GREEN = '#39d353'")
    expect(heatmapSource).toContain(
      "'--usage-heatmap-cell-color': WORKSPACE_ACTIVITY_HEATMAP_GREEN"
    )
    expect(heatmapSource).toContain("'--usage-heatmap-cell-opacity': cell.intensity")
    expect(heatmapCss).toContain('var(--usage-heatmap-cell-color, #39d353)')
  })
})
