import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  assertCommittedPathsCovered,
  nulSeparatedPaths,
  parseGitCommitSliceRequest,
  repoRelativePaths,
  resolveGitReportedPaths
} from './GitCommitSlice'
import {
  executeGitCommit,
  type HostCommandResult,
  type WorkspaceToolExecutorDependencies
} from './WorkspaceToolExecutors'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout
}

function integrationDeps(): WorkspaceToolExecutorDependencies {
  return {
    host: {
      getTempDir: tmpdir,
      runHostCommand: async (command, cwd, options): Promise<HostCommandResult> => {
        const startedAt = Date.now()
        const argv = command as string[]
        const environment = typeof options === 'object' && options ? options.environment || {} : {}
        try {
          const result = await execFileAsync(argv[0], argv.slice(1), {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, ...environment }
          })
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
            timedOut: false,
            durationMs: Date.now() - startedAt
          }
        } catch (error: any) {
          return {
            stdout: String(error?.stdout || ''),
            stderr: String(error?.stderr || error?.message || ''),
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            timedOut: false,
            durationMs: Date.now() - startedAt
          }
        }
      }
    },
    store: {
      getChat: () => undefined,
      getChildChats: () => [],
      getSubThreadMailbox: (parentChatId) => ({
        schemaVersion: 1,
        parentChatId,
        nextSequence: 1,
        events: []
      }),
      getRunQueueJobs: () => []
    },
    runs: {
      getActiveByProvider: () => [],
      getRunEvents: () => [],
      cancelProviderRun: async () => false,
      saveAndBroadcastChat: () => {}
    }
  }
}

describe('parseGitCommitSliceRequest', () => {
  it('requires an explicit path-scoped mode and paths', () => {
    expect(() => parseGitCommitSliceRequest({ message: 'unsafe bare commit' })).toThrow(
      /mode="pathspec" or mode="private_index"/
    )
    expect(() =>
      parseGitCommitSliceRequest({ message: 'empty paths', mode: 'pathspec', paths: [] })
    ).toThrow(/at least one exact path/)
  })

  it('keeps pathspec and private-index requests mutually exclusive', () => {
    expect(
      parseGitCommitSliceRequest({
        message: 'commit whole paths',
        mode: 'pathspec',
        paths: ['src/a.ts', 'src/a.ts', 'src/b.ts']
      })
    ).toEqual({
      message: 'commit whole paths',
      mode: 'pathspec',
      paths: ['src/a.ts', 'src/b.ts']
    })
    expect(() =>
      parseGitCommitSliceRequest({
        message: 'wrong mode',
        mode: 'pathspec',
        paths: ['src/a.ts'],
        patch: 'diff --git a/src/a.ts b/src/a.ts'
      })
    ).toThrow(/does not accept patch/)
    expect(() =>
      parseGitCommitSliceRequest({
        message: 'missing patch',
        mode: 'private_index',
        paths: ['src/a.ts']
      })
    ).toThrow(/requires a patch/)
  })
})

describe('commit-slice path coverage', () => {
  const root = resolve('/tmp/repo')

  it('parses Git NUL output and resolves repository-relative names', () => {
    const reported = nulSeparatedPaths('src/a.ts\0src/new.ts\0')
    expect(repoRelativePaths(root, resolveGitReportedPaths(root, reported))).toEqual([
      'src/a.ts',
      'src/new.ts'
    ])
  })

  it('accepts exact files and declared directories', () => {
    expect(() =>
      assertCommittedPathsCovered(
        [resolve(root, 'src/a.ts'), resolve(root, 'tests')],
        [resolve(root, 'src/a.ts'), resolve(root, 'tests/a.test.ts')]
      )
    ).not.toThrow()
  })

  it('rejects undeclared changes while allowing an unchanged declared path', () => {
    expect(() =>
      assertCommittedPathsCovered([resolve(root, 'src/a.ts')], [resolve(root, 'src/b.ts')])
    ).toThrow(/escaped its declared paths/)
    expect(() =>
      assertCommittedPathsCovered(
        [resolve(root, 'src/a.ts'), resolve(root, 'src/b.ts')],
        [resolve(root, 'src/a.ts')]
      )
    ).not.toThrow()
  })
})

it('rejects a declared path missing from a strict private-index slice', () => {
  const root = resolve('/tmp/repo')
  expect(() =>
    assertCommittedPathsCovered(
      [resolve(root, 'src/a.ts'), resolve(root, 'src/new-file.ts')],
      [resolve(root, 'src/a.ts')],
      { requireDeclaredPaths: true }
    )
  ).toThrow(/missingPaths/)
})

describe('private-index commit integration', () => {
  it('commits only the supplied hunk and preserves unrelated shared-index staging', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'taskwraith-commit-slice-integration-'))
    try {
      await git(workspace, ['init'])
      await git(workspace, ['config', 'user.name', 'TaskWraith Test'])
      await git(workspace, ['config', 'user.email', 'taskwraith@example.test'])
      await writeFile(resolve(workspace, 'a.txt'), 'one\ntwo\n')
      await writeFile(resolve(workspace, 'b.txt'), 'base\n')
      await git(workspace, ['add', '--', 'a.txt', 'b.txt'])
      await git(workspace, ['commit', '-m', 'base'])

      await writeFile(resolve(workspace, 'a.txt'), 'ONE\nTWO\n')
      await writeFile(resolve(workspace, 'b.txt'), 'staged\n')
      await git(workspace, ['add', '--', 'b.txt'])

      const result = await executeGitCommit(
        integrationDeps(),
        {
          message: 'commit selected a hunk',
          mode: 'private_index',
          paths: ['a.txt'],
          patch: [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1,2 +1,2 @@',
            '-one',
            '+ONE',
            ' two',
            ''
          ].join('\n')
        },
        workspace,
        {
          scope: 'workspace',
          cwd: workspace,
          workspacePath: workspace,
          assertMutationAuthorized: () => {},
          assertMutationStillLive: () => {}
        }
      )

      expect(result).toMatchObject({ ok: true, mode: 'private_index', paths: ['a.txt'] })
      expect(await git(workspace, ['show', 'HEAD:a.txt'])).toBe('ONE\ntwo\n')
      expect(await readFile(resolve(workspace, 'a.txt'), 'utf8')).toBe('ONE\nTWO\n')
      expect((await git(workspace, ['diff', '--cached', '--name-only'])).trim()).toBe('b.txt')
      expect(await git(workspace, ['diff', '--', 'a.txt'])).toContain('+TWO')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a private-index patch that omits a requested untracked file before commit', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'taskwraith-commit-slice-missing-path-'))
    try {
      await git(workspace, ['init'])
      await git(workspace, ['config', 'user.name', 'TaskWraith Test'])
      await git(workspace, ['config', 'user.email', 'taskwraith@example.test'])
      await writeFile(resolve(workspace, 'a.txt'), 'base\n')
      await git(workspace, ['add', '--', 'a.txt'])
      await git(workspace, ['commit', '-m', 'base'])
      const baseHead = (await git(workspace, ['rev-parse', 'HEAD'])).trim()

      await writeFile(resolve(workspace, 'a.txt'), 'changed\n')
      await writeFile(resolve(workspace, 'new.txt'), 'untracked\n')

      await expect(
        executeGitCommit(
          integrationDeps(),
          {
            message: 'must not omit requested new file',
            mode: 'private_index',
            paths: ['a.txt', 'new.txt'],
            patch: [
              'diff --git a/a.txt b/a.txt',
              '--- a/a.txt',
              '+++ b/a.txt',
              '@@ -1 +1 @@',
              '-base',
              '+changed',
              ''
            ].join('\n')
          },
          workspace,
          {
            scope: 'workspace',
            cwd: workspace,
            workspacePath: workspace,
            assertMutationAuthorized: () => {},
            assertMutationStillLive: () => {}
          }
        )
      ).rejects.toThrow(/missingPaths.*new\.txt.*git diff --no-index/i)
      expect((await git(workspace, ['rev-parse', 'HEAD'])).trim()).toBe(baseHead)
      expect(await readFile(resolve(workspace, 'new.txt'), 'utf8')).toBe('untracked\n')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
