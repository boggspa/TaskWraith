import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_ACCENT_COLOR } from '../../../shared/themeAccentColor'
import { SettingsSharedAccentControl } from './SettingsSharedAccentControl'

describe('SettingsSharedAccentControl', () => {
  it('renders one shared colour editor with a hard-corner message preview', () => {
    const html = renderToStaticMarkup(
      <SettingsSharedAccentControl
        color="#C040FF"
        themeAppearance="dark"
        cornerStyle="hard"
        transcriptFontFamily="Selected Preview Font"
        onColorChange={() => {}}
        onCornerStyleChange={() => {}}
      />
    )

    expect(html).toContain('Bubble color')
    expect(html).toContain('Default')
    expect(html).toContain('HSL')
    expect(html).toContain('Message bubble hue')
    expect(html).toContain('Message bubble hex color')
    expect(html).toContain('Message bubble preview')
    expect(html).toContain('settings-shared-accent-preview-bubble is-hard')
    expect(html).toContain('Looks good — this color is your message bubble’s alone.')
    // This picker stopped owning the app accent when --accent moved to the OS
    // accent; copy that still promises an interface accent is a false promise.
    expect(html).not.toMatch(/[Aa]ccent and (chat|message) bubble/)
    expect(html).not.toContain('Accent preview')
    expect(html).toContain('--transcript-font-family:Selected Preview Font')
    expect(html).not.toContain('Selected accent')
    expect(html).toContain('aria-pressed="true"')
  })

  it('renders the semantic default with its light appearance value', () => {
    const html = renderToStaticMarkup(
      <SettingsSharedAccentControl
        color={DEFAULT_THEME_ACCENT_COLOR}
        themeAppearance="light"
        cornerStyle="rounded"
        transcriptFontFamily="system-ui"
        onColorChange={() => {}}
        onCornerStyleChange={() => {}}
      />
    )

    expect(html).toContain('#FAFAFA')
    expect(html).toContain('disabled=""')
    expect(html).toContain('>Default</button>')
  })
})
