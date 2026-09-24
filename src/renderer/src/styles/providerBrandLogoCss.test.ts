import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readProviderLogoCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/02-transcript-messages-fx.css'),
    'utf8'
  )

describe('provider brand logo CSS', () => {
  it('switches supplied light- and dark-surface PNGs without recolouring them', () => {
    const css = readProviderLogoCss()
    const block = css.slice(
      css.indexOf('/* First-party artwork for semantic provider/model labels.'),
      css.indexOf(
        '/* Preserve each supplied canvas while balancing tiny inline slots optically. */'
      )
    )

    expect(block).toContain('.provider-brand-logo-image-light')
    expect(block).toContain('.provider-brand-logo-image-dark')
    // Quote-tolerant: the stylesheet's attribute selectors may be formatted
    // with either quote style.
    expect(block).toMatch(/\[data-theme=["']light["']\]/)
    expect(block).toMatch(/\[data-theme=["']system["']\]/)
    expect(block).toContain('@media (prefers-color-scheme: light)')
    expect(block).not.toContain('filter:')
    expect(block).not.toContain('mix-blend-mode:')
  })

  it('accounts for inverse sidebars and theme-immune composer shells', () => {
    const css = readProviderLogoCss()

    expect(css).toMatch(/\[data-theme=["']obsidian["']\]\s*\.app-sidebar/)
    expect(css).toMatch(/\[data-theme=["']alabaster["']\]\s*\.app-sidebar/)
    expect(css).toMatch(/\[data-composer-style=["']obsidian["']\]/)
    expect(css).toContain('.composer-combined-picker-popover.shell-obsidian')
    expect(css).toMatch(/\[data-composer-style=["']alabaster["']\]/)
    expect(css).toContain('.composer-combined-picker-popover.shell-alabaster')
  })
})
