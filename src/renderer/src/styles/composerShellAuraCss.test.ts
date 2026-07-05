import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/10-provider-shell-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const readMainCss = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

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

    for (const style of ['gemini', 'kimi', 'cursor', 'modular', 'terminal', 'stub', 'obsidian']) {
      expect(block).toContain(`[data-composer-style="${style}"]`)
    }
    for (const preserved of ['codex', 'claude', 'grok', 'satellite', 'alabaster']) {
      expect(block).not.toContain(`[data-composer-style="${preserved}"]`)
    }

    expect(block).toContain('.composer-above-bar-stack.fx-agent-aura')
    for (const row of [
      '.composer-above-bar',
      '.ensemble-above-row',
      '.queued-messages-above-row',
      '.composer-create-pr-row',
      '.ensemble-roster-preset-picker.is-compact'
    ]) {
      expect(block).toContain(row)
    }
    expect(block).toContain(')::after')
    for (const declaration of [
      'display: none !important',
      'content: none !important',
      'background: none !important',
      'box-shadow: none !important',
      'animation: none !important',
      'opacity: 0 !important'
    ]) {
      expect(block).toContain(declaration)
    }
  })

  it('suppresses Cursor composer aura pseudos while preserving its shell chrome', () => {
    const css = readCss()
    const block = cssBlockStartingAt(css, "Cursor's composer shell")

    expect(block).toContain('[data-composer-style="cursor"]')
    expect(block).toContain(':is(.composer-surface, .composer-above-bar-stack).fx-agent-aura::after')
    expect(block).toContain(
      ':is(.composer-surface, .composer-above-bar-stack).fx-agent-aura.fx-status-running::after'
    )
    expect(block).toContain(
      ':is(.composer-surface, .composer-above-bar-stack).fx-agent-aura.fx-status-approval::after'
    )
    expect(block).toContain(
      ':is(.composer-surface, .composer-above-bar-stack).fx-agent-aura.fx-status-failed::after'
    )
    for (const declaration of [
      'display: none !important',
      'content: none !important',
      'background: none !important',
      'box-shadow: none !important',
      'animation: none !important',
      'opacity: 0 !important'
    ]) {
      expect(block).toContain(declaration)
    }
  })

  it('suppresses the Gemini ensemble row tint overlay without broadening to other shells', () => {
    const css = readCss()
    const block = cssBlockStartingAt(css, 'Gemini ensemble rows')

    expect(block).toContain('[data-composer-style="gemini"]')
    expect(block).not.toContain('[data-composer-style="kimi"]')
    expect(block).not.toContain('[data-interface-style="gemini"]')
    expect(block).toContain('.composer-above-bar-stack.fx-agent-aura')
    for (const row of [
      '.composer-above-bar',
      '.ensemble-above-row',
      '.queued-messages-above-row',
      '.composer-create-pr-row',
      '.ensemble-roster-preset-picker.is-compact'
    ]) {
      expect(block).toContain(row)
    }
    expect(block).toContain(')::before')
    for (const declaration of [
      'display: none !important',
      'content: none !important',
      'background: none !important',
      'background-image: none !important',
      'box-shadow: none !important',
      'animation: none !important',
      'opacity: 0 !important'
    ]) {
      expect(block).toContain(declaration)
    }
  })

  it('loads provider shell overrides after the shell and ensemble shards', () => {
    const main = readMainCss()

    const polish = main.indexOf("@import url('./css/05-polish-fx-layouts.css');")
    const shells = main.indexOf("@import url('./css/07-composer-shells.css');")
    const ensemble = main.indexOf("@import url('./css/09-ensemble-work-session.css');")
    const overrides = main.indexOf("@import url('./css/10-provider-shell-overrides.css');")

    expect(polish).toBeGreaterThanOrEqual(0)
    expect(shells).toBeGreaterThan(polish)
    expect(ensemble).toBeGreaterThan(shells)
    expect(overrides).toBeGreaterThan(ensemble)
  })
})
