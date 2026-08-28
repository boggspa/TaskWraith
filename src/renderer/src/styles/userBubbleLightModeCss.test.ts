import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('light-mode user bubble CSS', () => {
  it('uses a neutral gray, dark-text bubble only for the Default setting', () => {
    const css = readCss('08-theme-picker-overrides.css')
    const selector =
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]):is(\n' +
      '  [data-user-bubble-color="system"],\n' +
      '  :not([data-user-bubble-color])\n' +
      ') .message-bubble.user {'
    const block = cssBlockStartingAt(css, selector)

    expect(block).toContain('background: var(--unified-soft-surface-bg)')
    expect(block).toContain(
      'border-color: color-mix(in srgb, var(--unified-soft-surface-border) 96%, transparent)'
    )
    expect(block).toContain('color: var(--text-primary)')
  })

  it('keeps named Settings choices on the dedicated tint override path', () => {
    const css = readCss('02-transcript-messages-fx.css')

    expect(css).toContain(
      '[data-user-bubble-color]:not([data-user-bubble-color="system"]) .message-bubble.user'
    )
    expect(css).toContain(
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])[data-user-bubble-color]:not([data-user-bubble-color="system"]) .message-bubble.user'
    )
  })

  it('keeps every provider silhouette on the shared compact user-message inset', () => {
    const css = readCss('02-transcript-messages-fx.css')
    const sharedBubble = cssBlockStartingAt(css, '\n.message-bubble.user {')

    expect(sharedBubble).toContain('--user-bubble-padding: 9px 17px')
    expect(sharedBubble).toContain('padding: var(--user-bubble-padding)')

    for (const provider of ['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama']) {
      const providerBubble = cssBlockStartingAt(
        css,
        `.app-transcript.provider-${provider} .message-bubble.user {`
      )
      expect(providerBubble).toContain('padding: var(--user-bubble-padding)')
    }
  })
})
