import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsDiffStatPreview } from './SettingsDiffStatPreview'

describe('SettingsDiffStatPreview', () => {
  it('renders an enormous example with the selected diff colors', () => {
    const html = renderToStaticMarkup(
      <SettingsDiffStatPreview additionsColor="#2DB777" deletionsColor="#EC3D35" />
    )
    const lineCounts = Array.from(html.matchAll(/[+−]([\d,]+)/g), ([, value]) =>
      Number(value.replaceAll(',', ''))
    )

    expect(html).toContain('A perfectly normal “small cleanup”')
    expect(html).toContain('At this size, the color read is doing real work.')
    expect(html).toContain('--settings-diff-stat-additions:#2DB777')
    expect(html).toContain('--settings-diff-stat-deletions:#EC3D35')
    expect(lineCounts).toHaveLength(2)
    expect(lineCounts.every((lineCount) => lineCount >= 1_000_000 && lineCount <= 9_999_999)).toBe(
      true
    )
  })
})
