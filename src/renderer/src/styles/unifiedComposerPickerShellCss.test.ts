import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/10-provider-shell-overrides.css'),
  'utf8'
)

describe('unified composer picker shell spacing', () => {
  it('restores a small provider-to-model gap only for the Claude shell', () => {
    expect(css).toMatch(
      /\[data-composer-style="claude"\][\s\S]*?\.composer-combined-picker-trigger-provider\s*\{\s*margin-right:\s*6px;/
    )
  })

  it('releases the legacy model-only width cap for Gemini and Cursor', () => {
    expect(css).toMatch(
      /:is\(\[data-composer-style="gemini"\], \[data-composer-style="cursor"\]\)[\s\S]*?\[data-composer-control="model"\]\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?max-width:\s*min\(260px, calc\(100% - 96px\)\);/
    )
  })
})
