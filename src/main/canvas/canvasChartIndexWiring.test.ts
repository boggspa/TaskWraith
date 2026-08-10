import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Composition-root regression lock: CanvasService.createDriver must construct
 * CanvasChartDriver for kind === 'chart'. Without this branch, canvas_render_chart
 * opens fail closed with "Canvas driver \"chart\" is not available in this build."
 */
describe('canvas chart index createDriver wiring', () => {
  it('registers CanvasChartDriver for kind === chart in main index createDriver', () => {
    const src = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(src).toMatch(
      /import\s+\{\s*CanvasChartDriver\s*\}\s+from\s+['.\/]*canvas\/CanvasChartDriver['"]/
    )
    expect(src).toMatch(/kind\s*===\s*['"]chart['"]/)
    expect(src).toMatch(/new\s+CanvasChartDriver\s*\(/)
  })
})
