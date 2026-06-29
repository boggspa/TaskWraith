import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  executeFindFiles,
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
