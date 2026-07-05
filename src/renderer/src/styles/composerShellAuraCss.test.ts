import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/10-provider-shell-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, marker: string): string => {
  const start = source.indexOf(marker)
  expect(start, `Missing marker: ${marker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for marker: ${marker}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('composer shell row aura CSS', () => {
  it('suppresses row-level agent aura only for shells that own above-row chrome', () => {
    const css = readCss()
    const block = cssBlockStartingAt(css, 'Shell sign-off')

    for (const style of ['gemini', 'kimi', 'modular', 'terminal', 'stub', 'obsidian']) {
      expect(block).toContain(`[data-composer-style="${style}"]`)
    }
    for (const preserved of ['codex', 'claude', 'cursor', 'grok', 'satellite', 'alabaster']) {
      expect(block).not.toContain(`[data-composer-style="${preserved}"]`)
    }

    expect(block).toContain('.composer-above-bar-stack.fx-agent-aura')
    expect(block).toContain('.ensemble-roster-preset-picker.is-compact')
    expect(block).toContain(')::after')
    expect(block).toContain('display: none !important')
    expect(block).toContain('box-shadow: none !important')
    expect(block).toContain('background: none !important')
  })
})
