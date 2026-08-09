import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n')

describe('sidebar section header pill surfaces', () => {
  const cssPath = 'src/renderer/src/assets/css/21-sidebar-section-pills.css'

  it('loads after the existing sidebar and theme shards', () => {
    const main = readRepoFile('src/renderer/src/assets/main.css')
    const themeOverrides = main.indexOf("@import url('./css/08-theme-picker-overrides.css');")
    const sectionPills = main.indexOf("@import url('./css/21-sidebar-section-pills.css');")

    expect(themeOverrides).toBeGreaterThanOrEqual(0)
    expect(sectionPills).toBeGreaterThan(themeOverrides)
  })

  it('wears the SAME material as the Model Usage pane, not a solid lozenge', () => {
    const css = readRepoFile(cssPath)
    const pane = readRepoFile('src/renderer/src/components/ModelUsageCard.css')
    const theme = readRepoFile('src/renderer/src/styles/theme.css')

    // The two pieces of chrome floating on the sidebar background must agree.
    // Both consume one semantic alias, whose canonical dark/light values live
    // in theme.css, so neither component can silently restate a different fill.
    expect(pane).toContain('background-color: var(--tw-sidebar-neutral-material-bg)')
    expect(css).toContain(
      '--sidebar-section-header-pill-bg: var(--tw-sidebar-neutral-material-bg)'
    )
    expect(theme).toContain('--tw-neutral-material-bg-dark: rgba(22, 22, 22, 0.65)')
    expect(theme).toContain('--tw-neutral-material-bg-light: rgba(255, 255, 255, 0.65)')
    expect(theme).toContain('[data-theme="citrus"]')
    // No solid 90% fill survives in either family.
    expect(css).not.toContain('rgba(0, 0, 0, 0.9)')
    expect(css).not.toContain('rgba(255, 255, 255, 0.9)')
  })

  it('carries the blur that makes a 65% fill a material, and an opaque fallback without it', () => {
    const css = readRepoFile(cssPath)

    // A 65% fill with nothing blurred behind it is not glass, it is a washed-out
    // pill — so the translucent form is gated on transparency being allowed,
    // exactly as the pane's own glass rules are.
    expect(css).toContain("[data-reduce-transparency='false']")
    expect(css).toContain('backdrop-filter: var(--tw-neutral-material-backdrop)')
    expect(css).toContain("[data-reduce-transparency='true']")
    expect(css).toContain(
      '--sidebar-section-header-pill-bg-solid: var(--tw-sidebar-neutral-material-solid)'
    )
    expect(css).toContain('backdrop-filter: var(--tw-neutral-material-backdrop-soft)')
    expect(css).toContain('@supports not ((backdrop-filter: blur(1px))')
  })

  it('adds a small unpainted gap between the search chrome and first section', () => {
    const css = readRepoFile(cssPath)
    const spacerBlock = css.match(/\.app-sidebar \.sidebar-hierarchy-scroll \{([^}]*)\}/)?.[1]

    expect(spacerBlock).toContain('padding-top: 12px')
    expect(spacerBlock).not.toContain('background')
    expect(spacerBlock).not.toContain('margin')
  })

  it('targets only the header toggle background without fading its contents or sidebar rows', () => {
    const css = readRepoFile(cssPath)
    const themedStateSelectors = css.match(
      /\[data-theme\]\[data-appearance\]\[data-reduce-transparency\]/g
    )

    expect(css).toContain('.sidebar-section-header-toggle:is(:hover, :focus-visible)')
    expect(themedStateSelectors).toHaveLength(2)
    expect(css).toContain('background: var(--sidebar-section-header-pill-bg) !important')
    expect(css).not.toContain('opacity:')
    expect(css).not.toContain('.sidebar-view-tabs')
    expect(css).not.toContain('.sidebar-section-count')
    expect(css).not.toContain('.sidebar-chat-item')
    expect(css).not.toContain('.sidebar-workspace-group')
  })
})
