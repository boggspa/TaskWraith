import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThemeAppearancePreviewStack } from './ThemeAppearancePreviewStack'

describe('ThemeAppearancePreviewStack', () => {
  it('renders a selectable mini-window for every Appearance theme', () => {
    const html = renderToStaticMarkup(
      <ThemeAppearancePreviewStack
        themeAppearance="forest"
        additionsColor="#2DB777"
        deletionsColor="#EC3D35"
        onThemeChange={() => {}}
      />
    )

    expect(html).toContain('aria-label="Theme previews"')
    expect(html).toContain('data-theme-preview="system"')
    expect(html).toContain('data-theme-preview="light"')
    expect(html).toContain('data-theme-preview="forest"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('Forest')
  })

  it('uses the supplied user diff colors in the code preview', () => {
    const html = renderToStaticMarkup(
      <ThemeAppearancePreviewStack
        themeAppearance="dark"
        additionsColor="#12C4A0"
        deletionsColor="#F15A70"
      />
    )

    expect(html).toContain('Theme-aware code diff')
    expect(html).toContain('--theme-preview-diff-additions:#12C4A0')
    expect(html).toContain('--theme-preview-diff-deletions:#F15A70')
    expect(html).toContain('sidebar-elevated')
    expect(html).toContain('configurable colors')
  })
})
