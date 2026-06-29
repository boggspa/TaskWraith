import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  executeFindFiles,
  executeGitBlame,
  executeGitLog,
  executeGitShow,
  resolveMcpScopedPath,
  type HostCommandResult,
  type WorkspaceToolExecutorDependencies
} from './WorkspaceToolExecutors'

function makeDeps(runHostCommand: WorkspaceToolExecutorDependencies['host']['runHostCommand']) {
  return {
    host: {
      runHostCommand,
      getTempDir: () => '/tmp'
    },
    store: {
      getChat: () => undefined,
      getChildChats: () => [],
      getRunQueueJobs: () => []
    },
    runs: {
      getActiveByProvider: () => [],
      getRunEvents: () => [],
      cancelProviderRun: async () => false,
      saveAndBroadcastChat: () => {}
    }
  } satisfies WorkspaceToolExecutorDependencies
}

function commandResult(stdout: string, exitCode = 0): HostCommandResult {
  return {
    stdout,
    stderr: '',
    exitCode,
    timedOut: false,
    durationMs: 5
  }
}

describe('resolveMcpScopedPath', () => {
  it('allows workspace-root directory/search targets only when requested', () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const context = {
      scope: 'workspace' as const,
      cwd: workspace,
      workspacePath: workspace
    }

    expect(resolveMcpScopedPath(context, '.', { allowWorkspaceRoot: true })).toBe(workspace)
    expect(() => resolveMcpScopedPath(context, '.')).toThrow('Path is outside the workspace.')
  })

  it('continues to reject outside-workspace targets', () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const context = {
      scope: 'workspace' as const,
      cwd: workspace,
      workspacePath: workspace
    }

    expect(() =>
      resolveMcpScopedPath(context, '../outside', { allowWorkspaceRoot: true })
    ).toThrow('Path is outside the workspace.')
  })
})

describe('executeFindFiles', () => {
  it('runs rg --files with bounded workspace-relative results and safe default excludes', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const commands: string[][] = []
    const deps = makeDeps(async (command) => {
      commands.push(command as string[])
      return commandResult(
        [
          resolve(workspace, 'src/App.test.ts'),
          resolve(workspace, 'src/main/index.test.ts'),
          resolve(workspace, 'README.md')
        ].join('\n')
      )
    })
    const result = await executeFindFiles(
      deps,
      { pattern: '*.test.ts', maxResults: 2 },
      { scope: 'workspace', cwd: workspace, workspacePath: workspace },
      workspace
    )

    expect(commands[0]).toEqual([
      'rg',
      '--files',
      '--glob',
      '!.git/**',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!vendor/**',
      '--glob',
      '!Pods/**',
      '--glob',
      '!DerivedData/**',
      '--glob',
      '!dist/**',
      '--glob',
      '!build/**',
      '--glob',
      '!coverage/**',
      '--glob',
      '!.next/**',
      '--glob',
      '!out/**',
      '--glob',
      '*.test.ts',
      '--',
      workspace
    ])
    expect(result).toMatchObject({
      ok: true,
      patterns: ['*.test.ts'],
      count: 2,
      totalMatches: 3,
      truncated: true,
      files: ['src/App.test.ts', 'src/main/index.test.ts']
    })
  })

  it('supports hidden files only when explicitly requested', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    let commandSeen: string[] = []
    const deps = makeDeps(async (command) => {
      commandSeen = command as string[]
      return commandResult(resolve(workspace, '.github/workflows/ci.yml'))
    })
    const result = await executeFindFiles(
      deps,
      { pattern: '.github/**', includeHidden: true },
      { scope: 'workspace', cwd: workspace, workspacePath: workspace },
      workspace
    )

    expect(commandSeen).toContain('--hidden')
    expect(result).toMatchObject({
      files: ['.github/workflows/ci.yml'],
      includeHidden: true
    })
  })

  it('rejects outside-workspace search roots', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const deps = makeDeps(async () => commandResult(''))

    await expect(
      executeFindFiles(
        deps,
        { pattern: '*.ts', path: '../outside' },
        { scope: 'workspace', cwd: workspace, workspacePath: workspace },
        workspace
      )
    ).rejects.toThrow('Path is outside the workspace.')
  })
})

describe('git history workspace tools', () => {
  it('runs git_log with fixed argv, scoped paths, redacted filters, and parsed commits', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const commands: string[][] = []
    const deps = makeDeps(async (command) => {
      commands.push(command as string[])
      return commandResult(
        [
          ['abcd'.repeat(10), 'abcd123', 'Ada', 'ada@example.test', '2026-01-01T00:00:00+00:00', 'First'].join('\x1f'),
          ['1234'.repeat(10), '1234123', 'Grace', 'grace@example.test', '2026-01-02T00:00:00+00:00', 'Second'].join('\x1f')
        ].join('\n')
      )
    })

    const result = await executeGitLog(
      deps,
      { ref: 'HEAD~5..HEAD', path: 'src', maxCount: 2, grep: 'secret literal', author: 'Ada' },
      { scope: 'workspace', cwd: workspace, workspacePath: workspace },
      workspace
    )

    expect(commands[0]).toEqual([
      'git',
      'log',
      '--max-count=2',
      '--date=iso-strict',
      expect.stringContaining('--pretty=format:'),
      '--grep',
      'secret literal',
      '--author',
      'Ada',
      'HEAD~5..HEAD',
      '--',
      resolve(workspace, 'src')
    ])
    expect(result).toMatchObject({
      exitCode: 0,
      count: 2,
      command: [
        'git',
        'log',
        '--max-count=2',
        '--date=iso-strict',
        expect.stringContaining('--pretty=format:'),
        '--grep',
        '[grep]',
        '--author',
        '[author]',
        'HEAD~5..HEAD',
        '--',
        resolve(workspace, 'src')
      ],
      commits: [
        {
          hash: 'abcd'.repeat(10),
          shortHash: 'abcd123',
          authorName: 'Ada',
          authorEmail: 'ada@example.test',
          subject: 'First'
        },
        {
          hash: '1234'.repeat(10),
          shortHash: '1234123',
          authorName: 'Grace',
          authorEmail: 'grace@example.test',
          subject: 'Second'
        }
      ]
    })
  })

  it('rejects unsafe git refs before invoking git_show', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const deps = makeDeps(async () => commandResult(''))

    await expect(
      executeGitShow(
        deps,
        { ref: '--all' },
        { scope: 'workspace', cwd: workspace, workspacePath: workspace },
        workspace
      )
    ).rejects.toThrow('Git ref contains unsupported characters.')
  })

  it('runs git_show with optional path scoping and parsed commit metadata', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const commands: string[][] = []
    const deps = makeDeps(async (command) => {
      commands.push(command as string[])
      return commandResult(
        [
          ['abcd'.repeat(10), 'abcd123', 'Ada', 'ada@example.test', '2026-01-01T00:00:00+00:00', 'Initial'].join('\x1f'),
          '',
          ' src/App.ts | 2 ++'
        ].join('\n')
      )
    })

    const result = await executeGitShow(
      deps,
      { ref: 'HEAD', path: 'src/App.ts', includePatch: false },
      { scope: 'workspace', cwd: workspace, workspacePath: workspace },
      workspace
    )

    expect(commands[0]).toEqual([
      'git',
      'show',
      '--no-ext-diff',
      '--date=iso-strict',
      expect.stringContaining('--format='),
      '--stat',
      'HEAD',
      '--',
      resolve(workspace, 'src/App.ts')
    ])
    expect(result).toMatchObject({
      ref: 'HEAD',
      includePatch: false,
      includeStat: true,
      commit: {
        hash: 'abcd'.repeat(10),
        shortHash: 'abcd123',
        authorName: 'Ada',
        subject: 'Initial'
      }
    })
  })

  it('runs git_blame with a bounded line range and parsed porcelain rows', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const commands: string[][] = []
    const deps = makeDeps(async (command) => {
      commands.push(command as string[])
      return commandResult(
        [
          `${'a'.repeat(40)} 7 11 1`,
          'author Ada',
          'author-mail <ada@example.test>',
          'author-time 1780000000',
          'summary Tighten parser',
          'filename src/App.ts',
          '\tconst value = 1'
        ].join('\n')
      )
    })

    const result = await executeGitBlame(
      deps,
      { path: 'src/App.ts', startLine: 11, endLine: 999, maxLines: 20 },
      { scope: 'workspace', cwd: workspace, workspacePath: workspace },
      workspace
    )

    expect(commands[0]).toEqual([
      'git',
      'blame',
      '--line-porcelain',
      '-L',
      '11,30',
      '--',
      resolve(workspace, 'src/App.ts')
    ])
    expect(result).toMatchObject({
      path: 'src/App.ts',
      startLine: 11,
      endLine: 30,
      count: 1,
      entries: [
        {
          hash: 'a'.repeat(40),
          originalLine: 7,
          finalLine: 11,
          author: 'Ada',
          authorMail: 'ada@example.test',
          authorTime: 1780000000,
          summary: 'Tighten parser',
          path: 'src/App.ts',
          content: 'const value = 1'
        }
      ]
    })
  })
})
