import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createDiffStatPreviewExample, SettingsDiffStatPreview } from './SettingsDiffStatPreview'

describe('SettingsDiffStatPreview', () => {
  it('generates independent, enormous additions and deletions', () => {
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0.5)

    expect(createDiffStatPreviewExample(random)).toEqual({
      additions: 1_000_000,
      deletions: 5_500_000
    })
  })

  it('renders the supplied example with the selected diff colors', () => {
    const html = renderToStaticMarkup(
      <SettingsDiffStatPreview
        additionsColor="#2DB777"
        deletionsColor="#EC3D35"
        example={{ additions: 5_419_713, deletions: 8_765_432 }}
      />
    )

    expect(html).toContain('A perfectly normal “small cleanup”')
    expect(html).toContain('+5,419,713')
    expect(html).toContain('−8,765,432')
    expect(html).toContain('At this size, the color read is doing real work.')
    expect(html).toContain('--settings-diff-stat-additions:#2DB777')
    expect(html).toContain('--settings-diff-stat-deletions:#EC3D35')
  })
})
