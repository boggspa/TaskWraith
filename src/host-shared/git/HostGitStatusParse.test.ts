import { describe, expect, it } from 'vitest'

import { classifyHostGitStatus, parseHostGitStatusPorcelainZ } from './HostGitStatusParse'

/** -z records are NUL-separated, with a trailing NUL after the final record. */
function porcelain(...records: string[]): string {
  return `${records.join('\0')}\0`
}

describe('parseHostGitStatusPorcelainZ', () => {
  it('parses staged and unstaged single-record entries', () => {
    const files = parseHostGitStatusPorcelainZ(porcelain('M  staged.ts', ' M unstaged.ts'))

    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ path: 'staged.ts', staged: true, unstaged: false })
    expect(files[1]).toMatchObject({ path: 'unstaged.ts', staged: false, unstaged: true })
  })

  it('consumes the rename SOURCE as a second record, not a phantom file', () => {
    // THE BUG THIS PINS: a parser that advances by 1 emits 'old-name.ts' as its
    // own untracked entry. A rename is two records; the second is the origin.
    const files = parseHostGitStatusPorcelainZ(
      porcelain('R  new-name.ts', 'old-name.ts', '?? untracked.ts')
    )

    expect(files.map((file) => file.path)).toEqual(['new-name.ts', 'untracked.ts'])
    expect(files[0]).toMatchObject({
      path: 'new-name.ts',
      originalPath: 'old-name.ts',
      kind: 'renamed'
    })
  })

  it('consumes a COPY source the same way', () => {
    const files = parseHostGitStatusPorcelainZ(porcelain('C  copy.ts', 'origin.ts'))

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'copy.ts', originalPath: 'origin.ts', kind: 'copied' })
  })

  it('does not mistake a rename source for a following real entry', () => {
    const files = parseHostGitStatusPorcelainZ(porcelain('R  a.ts', 'b.ts', 'M  c.ts', ' D d.ts'))
    expect(files.map((file) => file.path)).toEqual(['a.ts', 'c.ts', 'd.ts'])
  })

  it('handles untracked, ignored and conflicted records', () => {
    const files = parseHostGitStatusPorcelainZ(
      porcelain('?? new.ts', '!! ignored.ts', 'UU conflict.ts')
    )
    expect(files.map((file) => file.kind)).toEqual(['untracked', 'ignored', 'conflicted'])
  })

  it('preserves paths containing spaces (no quoting in -z output)', () => {
    const files = parseHostGitStatusPorcelainZ(porcelain('M  dir with spaces/file name.ts'))
    expect(files[0]?.path).toBe('dir with spaces/file name.ts')
  })

  it('ignores empty and truncated records rather than emitting junk', () => {
    expect(parseHostGitStatusPorcelainZ('')).toEqual([])
    expect(parseHostGitStatusPorcelainZ(porcelain('', 'M', 'M  ok.ts'))).toHaveLength(1)
  })

  it('marks untracked entries unstaged even though the index letter is ?', () => {
    const [file] = parseHostGitStatusPorcelainZ(porcelain('?? new.ts'))
    expect(file).toMatchObject({ staged: false, unstaged: true })
  })
})

describe('classifyHostGitStatus', () => {
  it.each([
    ['A', ' ', 'added'],
    ['M', ' ', 'modified'],
    ['D', ' ', 'deleted'],
    ['R', ' ', 'renamed'],
    ['C', ' ', 'copied'],
    ['?', '?', 'untracked'],
    ['!', '!', 'ignored'],
    ['U', 'U', 'conflicted'],
    ['D', 'D', 'conflicted'],
    ['A', 'A', 'conflicted'],
    ['X', 'Y', 'unknown']
  ])('classifies %s%s as %s', (index, workingTree, expected) => {
    expect(classifyHostGitStatus(index, workingTree)).toBe(expected)
  })
})
