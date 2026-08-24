import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

describe('code-block and terminal chrome CSS', () => {
  it('keeps assistant code blocks free of animated accent rims', () => {
    const css = readCss('05-polish-fx-layouts.css')

    expect(css).not.toContain('.message-bubble.assistant .message-code-shell::after')
    expect(css).not.toContain('code-shell-rim-chase')
  })
})
