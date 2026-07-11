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

  it('uses a 90% black background in dark themes and 90% white in light themes', () => {
    const css = readRepoFile(cssPath)

    expect(css).toContain('--sidebar-section-header-pill-bg: rgba(0, 0, 0, 0.9)')
    expect(css).toContain(
      ":is([data-theme='light'], [data-theme='citrus'], [data-theme='mist'], [data-theme='sage'])"
    )
    expect(css).toContain('--sidebar-section-header-pill-bg: rgba(255, 255, 255, 0.9)')
  })

  it('targets only the header toggle background without fading its contents or sidebar rows', () => {
    const css = readRepoFile(cssPath)

    expect(css).toContain('.sidebar-section-header-toggle:is(:hover, :focus-visible)')
    expect(css).toContain('background: var(--sidebar-section-header-pill-bg) !important')
    expect(css).not.toContain('opacity:')
    expect(css).not.toContain('.sidebar-view-tabs')
    expect(css).not.toContain('.sidebar-section-count')
    expect(css).not.toContain('.sidebar-chat-item')
    expect(css).not.toContain('.sidebar-workspace-group')
  })
})
