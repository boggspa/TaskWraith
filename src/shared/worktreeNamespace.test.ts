import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  RESERVED_BRANCH_PREFIXES,
  RESERVED_WORKTREE_NAME_PREFIXES,
  isReservedBranchName,
  isReservedWorktreeName
} from './worktreeNamespace'

describe('reserved worktree namespaces', () => {
  it('claims the prefixes the automatic allocators actually use', () => {
    for (const name of ['thread-abc-0123456789', 'fanout-lane-0123456789']) {
      expect(isReservedWorktreeName(name)).toBe(true)
    }
    expect(isReservedBranchName('taskwraith/thread-abc')).toBe(true)
    expect(isReservedBranchName('taskwraith/fanout-lane')).toBe(true)
  })

  it('matches case-insensitively', () => {
    // The derived directory segment is compared by a case-insensitive volume
    // on a default macOS install, so `Fanout-x` and `fanout-x` collide on disk
    // even though they differ as strings.
    expect(isReservedWorktreeName('Fanout-x')).toBe(true)
    expect(isReservedWorktreeName('THREAD-x')).toBe(true)
    expect(isReservedBranchName('TaskWraith/thread-x')).toBe(true)
  })

  it('does not over-claim names that merely start similarly', () => {
    for (const name of ['threading', 'thread', 'fanout', 'fan', 'review', '']) {
      expect(isReservedWorktreeName(name)).toBe(false)
    }
    for (const branch of ['taskwraith', 'taskwraith-notes', 'feature/x', '']) {
      expect(isReservedBranchName(branch)).toBe(false)
    }
    expect(isReservedWorktreeName(null)).toBe(false)
    expect(isReservedBranchName(undefined)).toBe(false)
  })

  /*
   * The whole point of this module is that the reserved list and the code that
   * MINTS those names can't drift apart — a renamed allocator prefix with a
   * stale list here silently reopens the collision. Pin both directions
   * against the allocators' own source.
   */
  it('stays in step with the allocators that mint these names', () => {
    const read = (path: string): string =>
      readFileSync(new URL(path, import.meta.url), 'utf8')
    const sources = [
      read('../main/run/ThreadWorktreeBinding.ts'),
      read('../main/run/FanoutWorktreeAllocation.ts')
    ]

    // Every literal `name:` / `branch:` template an allocator mints must be
    // covered by the reserved list.
    const minted: string[] = []
    for (const source of sources) {
      for (const match of source.matchAll(/\b(?:name|branch):\s*`([^`$]*)\$\{/g)) {
        minted.push(match[1])
      }
    }
    expect(minted.length).toBeGreaterThanOrEqual(4)
    for (const prefix of minted) {
      const covered = prefix.startsWith('taskwraith/')
        ? isReservedBranchName(`${prefix}x`)
        : isReservedWorktreeName(`${prefix}x`)
      expect(covered, `allocator mints "${prefix}…" but it is not reserved`).toBe(true)
    }

    // And nothing is reserved that no allocator mints — a stale entry would
    // block a name users could legitimately want.
    const joined = sources.join('\n')
    for (const prefix of RESERVED_WORKTREE_NAME_PREFIXES) {
      expect(joined, `"${prefix}" is reserved but no allocator mints it`).toContain(`\`${prefix}`)
    }
    for (const prefix of RESERVED_BRANCH_PREFIXES) {
      expect(joined).toContain(prefix)
    }
  })
})
