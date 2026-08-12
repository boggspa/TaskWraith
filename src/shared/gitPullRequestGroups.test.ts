import { describe, expect, it } from 'vitest'
import {
  stripTaskWraithCommitGroup,
  taskWraithCommitGroupHashes,
  withTaskWraithCommitGroup
} from './gitPullRequestGroups'

const FIRST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SECOND = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('TaskWraith pull request commit groups', () => {
  it('round-trips original commit membership through an invisible body marker', () => {
    const body = withTaskWraithCommitGroup('## Summary\n\nFocused work.', [FIRST, SECOND])

    expect(body).toContain('## Summary')
    expect(body).toContain('<!-- taskwraith-commit-group:v1')
    expect(taskWraithCommitGroupHashes(body)).toEqual([FIRST, SECOND])
    expect(stripTaskWraithCommitGroup(body)).toBe('## Summary\n\nFocused work.')
  })

  it('replaces stale markers, deduplicates hashes, and discards malformed values', () => {
    const firstBody = withTaskWraithCommitGroup('Description', [FIRST])
    const updated = withTaskWraithCommitGroup(firstBody, [SECOND, SECOND, 'not-a-hash'])

    expect(taskWraithCommitGroupHashes(updated)).toEqual([SECOND])
    expect(updated.match(/taskwraith-commit-group:v1/g)).toHaveLength(1)
    expect(stripTaskWraithCommitGroup(updated)).toBe('Description')
  })

  it('leaves ordinary pull request bodies untouched', () => {
    expect(taskWraithCommitGroupHashes('Human-authored body')).toEqual([])
    expect(stripTaskWraithCommitGroup('Human-authored body')).toBe('Human-authored body')
  })
})
