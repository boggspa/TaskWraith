import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveGitLaneWritePaths, deriveWorkspaceMutationClaims } from './WorkspaceMutationClaims'

const workspacePath = resolve('/repo')
const worktreePath = resolve('/lane-worktree')
const mutation = { workspacePath, worktreePath }
const patch = [
  'diff --git a/src/old.ts b/src/new.ts',
  'similarity index 100%',
  'rename from src/old.ts',
  'rename to src/new.ts',
  ''
].join('\n')

describe('Git lane write paths', () => {
  it.each(['pathspec', 'private_index'])(
    'separates %s slice paths from the metadata lock',
    async (mode) => {
      const call = {
        ...mutation,
        action: 'git_commit',
        args: {
          mode,
          message: 'Commit owned paths',
          paths: ['src/old.ts', 'src/new.ts'],
          ...(mode === 'private_index' ? { patch } : {})
        }
      }
      expect(deriveGitLaneWritePaths(call)).toEqual([
        resolve(worktreePath, 'src/old.ts'),
        resolve(worktreePath, 'src/new.ts')
      ])
      expect(await deriveWorkspaceMutationClaims(call)).toEqual([
        expect.objectContaining({ kind: 'file', targetPath: resolve(worktreePath, '.git') })
      ])
    }
  )

  it.each([
    { paths: ['src/old.ts'] },
    { paths: 'src/old.ts' },
    { path: 'src/old.ts' },
    { paths: ['src/old.ts'], all: true },
    { paths: ['src/old.ts'], update: true }
  ])('uses the executor path aliases and scoped all/update semantics: %j', (args) => {
    expect(deriveGitLaneWritePaths({ ...mutation, action: 'git_stage', args })).toEqual([
      resolve(worktreePath, 'src/old.ts')
    ])
  })

  it('checks both rename endpoints in a staging patch even if paths claims something else', () => {
    expect(
      deriveGitLaneWritePaths({
        ...mutation,
        action: 'git_stage',
        args: { paths: ['unrelated.ts'], patch }
      })
    ).toEqual([resolve(worktreePath, 'src/old.ts'), resolve(worktreePath, 'src/new.ts')])
  })

  it('resolves staging patches from the executor working directory', () => {
    expect(
      deriveGitLaneWritePaths({
        ...mutation,
        action: 'git_stage',
        args: { cwd: 'nested', patch }
      })
    ).toEqual([
      resolve(worktreePath, 'nested/src/old.ts'),
      resolve(worktreePath, 'nested/src/new.ts')
    ])
  })

  it.each([{ all: true }, { update: true }])(
    'requires the whole workspace for unscoped staging: %j',
    (args) => {
      expect(deriveGitLaneWritePaths({ ...mutation, action: 'git_stage', args })).toEqual([
        worktreePath
      ])
    }
  )

  it.each([
    { action: 'git_stage', args: {} },
    { action: 'git_stage', args: { patch: 'not a diff' } },
    { action: 'git_stage', args: { paths: ['../escape.ts'] } },
    { action: 'git_commit', args: { mode: 'pathspec', message: 'Empty', paths: [] } },
    { action: 'git_commit', args: { mode: 'pathspec', message: 'Escape', paths: ['../escape.ts'] } }
  ])('rejects unprovable or external slices: %j', (call) => {
    expect(() => deriveGitLaneWritePaths({ ...mutation, ...call })).toThrow()
  })
})
