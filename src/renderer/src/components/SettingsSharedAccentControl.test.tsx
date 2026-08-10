import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsSharedAccentControl } from './SettingsSharedAccentControl'

describe('SettingsSharedAccentControl', () => {
  it('renders one shared colour editor with a hard-corner message preview', () => {
    const html = renderToStaticMarkup(
      <SettingsSharedAccentControl
        color="#C040FF"
        cornerStyle="hard"
        transcriptFontFamily="Selected Preview Font"
        onColorChange={() => {}}
        onCornerStyleChange={() => {}}
      />
    )

    expect(html).toContain('Shared color')
    expect(html).toContain('HSL')
    expect(html).toContain('Accent and chat bubble hue')
    expect(html).toContain('Accent and chat bubble hex color')
    expect(html).toContain('Accent and message bubble preview')
    expect(html).toContain('settings-shared-accent-preview-bubble is-hard')
    expect(html).toContain('Looks good — your accent and message bubble now stay in sync.')
    expect(html).toContain('--transcript-font-family:Selected Preview Font')
    expect(html).not.toContain('Selected accent')
    expect(html).toContain('aria-pressed="true"')
  })
})
