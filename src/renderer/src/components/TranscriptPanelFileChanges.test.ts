import { describe, expect, it } from 'vitest'
import type { DiffFileSummary } from '../../../main/store/types'
import {
  buildFileChangeSummaryWindow,
  FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT,
  FILE_CHANGE_SUMMARY_MAX_VISIBLE,
  FILE_CHANGE_SUMMARY_PAGE_SIZE
} from './TranscriptPanel'

const makeSummaries = (count: number): DiffFileSummary[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${String(index).padStart(3, '0')}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    previewKind: 'none'
  }))

describe('buildFileChangeSummaryWindow', () => {
  it('starts collapsed and exposes the next bounded page size', () => {
    const window = buildFileChangeSummaryWindow(makeSummaries(30))

    expect(window.items).toHaveLength(FILE_CHANGE_SUMMARY_COLLAPSED_LIMIT)
    expect(window.hiddenCount).toBe(18)
    expect(window.canShowMore).toBe(true)
    expect(window.canShowFewer).toBe(false)
    expect(window.nextShowCount).toBe(18)
  })

  it('pages forward without jumping past the configured page size', () => {
    const window = buildFileChangeSummaryWindow(makeSummaries(90), 36)

    expect(window.visibleCount).toBe(36)
    expect(window.nextCount).toBe(36 + FILE_CHANGE_SUMMARY_PAGE_SIZE)
    expect(window.nextShowCount).toBe(FILE_CHANGE_SUMMARY_PAGE_SIZE)
    expect(window.canShowFewer).toBe(true)
  })

  it('caps extremely large summaries so expansion does not mount unbounded rows', () => {
    const window = buildFileChangeSummaryWindow(makeSummaries(200), 200)

    expect(window.visibleCount).toBe(FILE_CHANGE_SUMMARY_MAX_VISIBLE)
    expect(window.items).toHaveLength(FILE_CHANGE_SUMMARY_MAX_VISIBLE)
    expect(window.hiddenCount).toBe(80)
    expect(window.canShowMore).toBe(false)
    expect(window.canShowFewer).toBe(true)
  })
})
