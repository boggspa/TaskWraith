import { describe, expect, it } from 'vitest'
import { normalizeLaunchWorkspacePaths } from './useWorkspaceLaunchTargets'

describe('normalizeLaunchWorkspacePaths', () => {
  it('deduplicates workspace paths while preserving the first display form', () => {
    expect(
      normalizeLaunchWorkspacePaths([
        null,
        '',
        '/repo/app/',
        '/repo/app',
        '/repo/other',
        undefined
      ])
    ).toEqual(['/repo/app/', '/repo/other'])
  })

  it('normalizes Windows drive letters case-insensitively', () => {
    expect(normalizeLaunchWorkspacePaths(['C:\\Repo\\App', 'c:/Repo/App/'])).toEqual([
      'C:\\Repo\\App'
    ])
  })
})
