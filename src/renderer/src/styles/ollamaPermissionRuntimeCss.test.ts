import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/08-theme-picker-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('Ollama permission/runtime composer CSS', () => {
  it('restores label spacing only for the unified Ollama trigger in Codex and Claude shells', () => {
    const css = readCss()
    const codexGenericTrigger = css.indexOf(
      '[data-composer-style="codex"] .composer-combined-picker-trigger {'
    )
    const claudeGenericTrigger = css.indexOf(
      '[data-composer-style="claude"] .composer-combined-picker-trigger {'
    )
    const ollamaTriggerSelector =
      '[data-composer-style="codex"] .composer-ollama-permission-runtime-trigger,'
    const ollamaBlockStart = css.indexOf(ollamaTriggerSelector)

    expect(codexGenericTrigger).toBeGreaterThanOrEqual(0)
    expect(claudeGenericTrigger).toBeGreaterThanOrEqual(0)
    expect(ollamaBlockStart).toBeGreaterThan(codexGenericTrigger)
    expect(ollamaBlockStart).toBeGreaterThan(claudeGenericTrigger)

    const ollamaBlock = cssBlockStartingAt(css, ollamaTriggerSelector)
    expect(ollamaBlock).toContain(
      '[data-composer-style="claude"] .composer-ollama-permission-runtime-trigger'
    )
    expect(ollamaBlock).toContain('gap: 6px !important')
    expect(ollamaBlock).not.toContain('[data-composer-control="permission"]')
    expect(ollamaBlock).not.toContain('.composer-combined-picker-trigger {')
  })
})
