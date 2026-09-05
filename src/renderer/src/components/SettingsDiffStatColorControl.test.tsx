import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DIFF_STAT_COLORS } from '../../../shared/diffStatColors'
import { SettingsDiffStatColorControl } from './SettingsDiffStatColorControl'

describe('SettingsDiffStatColorControl', () => {
  it('renders the tone-scoped card with the parsed colour, drafts, and an enabled reset', () => {
    const html = renderToStaticMarkup(
      <SettingsDiffStatColorControl
        tone="additions"
        label="Additions"
        value="#FF0000"
        fallback={DEFAULT_DIFF_STAT_COLORS.additions}
        onChange={() => {}}
      />
    )

    expect(html).toContain('settings-diff-stat-color-card--additions')
    expect(html).toContain('Additions')
    // #FF0000 is exactly hue 0, full saturation, half lightness.
    expect(html).toContain('HSL 0 / 100% / 50%')
    expect(html).toContain('--settings-diff-stat-color:#FF0000')
    expect(html).toContain('background-color:#FF0000')
    expect(html).toContain('value="#FF0000"')
    expect(html).toContain('value="255, 0, 0"')
    // The colour differs from the fallback, so reset must be clickable.
    expect(html).not.toContain('disabled=""')
  })

  it('drives every slider from the parsed colour', () => {
    const html = renderToStaticMarkup(
      <SettingsDiffStatColorControl
        tone="additions"
        label="Additions"
        value="#FF0000"
        fallback={DEFAULT_DIFF_STAT_COLORS.additions}
        onChange={() => {}}
      />
    )

    expect(html).toContain('aria-label="Additions hue"')
    expect(html).toContain('aria-label="Additions saturation"')
    expect(html).toContain('aria-label="Additions luma"')
    // Fill percentages: hue 0 of 0-359, saturation 100 of 0-100, luma 50 of 0-100.
    expect(html).toContain('--ensemble-context-slider-fill:0%')
    expect(html).toContain('--ensemble-context-slider-fill:100%')
    expect(html).toContain('--ensemble-context-slider-fill:50%')
    expect(html).toContain('aria-label="Additions hex color"')
    expect(html).toContain('aria-label="Additions RGB color"')
  })

  it('disables reset exactly at the fallback colour', () => {
    const html = renderToStaticMarkup(
      <SettingsDiffStatColorControl
        tone="additions"
        label="Additions"
        value={DEFAULT_DIFF_STAT_COLORS.additions}
        fallback={DEFAULT_DIFF_STAT_COLORS.additions}
        onChange={() => {}}
      />
    )

    expect(html).toContain('disabled=""')
    expect(html).toContain(`value="${DEFAULT_DIFF_STAT_COLORS.additions}"`)
  })

  it('falls back to the tone default for unparseable input', () => {
    const html = renderToStaticMarkup(
      <SettingsDiffStatColorControl
        tone="deletions"
        label="Deletions"
        value="garbage"
        fallback={DEFAULT_DIFF_STAT_COLORS.deletions}
        onChange={() => {}}
      />
    )

    expect(html).toContain('settings-diff-stat-color-card--deletions')
    expect(html).toContain(`--settings-diff-stat-color:${DEFAULT_DIFF_STAT_COLORS.deletions}`)
    expect(html).toContain(`value="${DEFAULT_DIFF_STAT_COLORS.deletions}"`)
    // #EC3D35 parses to hue 3, saturation 83%, lightness 57%.
    expect(html).toContain('HSL 3 / 83% / 57%')
    expect(html).toContain('aria-label="Deletions hue"')
    // Unparseable input lands on the fallback, so reset is disabled again.
    expect(html).toContain('disabled=""')
  })

  it('normalizes three-digit hex before display', () => {
    const html = renderToStaticMarkup(
      <SettingsDiffStatColorControl
        tone="additions"
        label="Additions"
        value="#f00"
        fallback={DEFAULT_DIFF_STAT_COLORS.additions}
        onChange={() => {}}
      />
    )

    expect(html).toContain('value="#FF0000"')
    expect(html).toContain('HSL 0 / 100% / 50%')
  })
})
