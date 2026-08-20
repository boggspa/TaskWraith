import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const cssPath = join(process.cwd(), 'src/renderer/src/assets/css/28-first-run-ensemble.css')
const mainCssPath = join(process.cwd(), 'src/renderer/src/assets/main.css')

describe('first-run Ensemble task styling', () => {
  it('ships the isolated shard and imports it into the renderer stylesheet', () => {
    const css = readFileSync(cssPath, 'utf8')
    const mainCss = readFileSync(mainCssPath, 'utf8')

    expect(mainCss).toContain("@import url('./css/28-first-run-ensemble.css');")
    expect(css).toContain('.first-run-ensemble-task {')
    expect(css).toContain('.first-run-ensemble-task-copy:disabled')
    expect(css).toContain('@media (max-width: 560px)')
  })
})
