import { resolve } from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  executeCreateDirectory,
  executeCancelActiveRun,
  executeDeletePath,
  executeFindFiles,
  executeGetDiagnostics,
  executeGitBlame,
  executeGitCreatePr,
  executeGitLog,
  executeGitPush,
  executeGitShow,
  executeInspectChatAttachment,
  executeKillBackgroundProcess,
  executeListActiveRuns,
  executeListBackgroundProcesses,
  executeListChatAttachments,
  executeMovePath,
  executeReadBackgroundProcess,
  executeRenamePath,
  executeRunTask,
  executeStartBackgroundProcess,
  summarizeTestOutput,
  resolveMcpScopedPath,
  type HostCommandResult,
  type WorkspaceToolExecutorDependencies
} from './WorkspaceToolExecutors'

function makeDeps(
  runHostCommand: WorkspaceToolExecutorDependencies['host']['runHostCommand']
): WorkspaceToolExecutorDependencies {
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

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

describe('summarizeTestOutput', () => {
  it('keeps green vitest output green when pass titles and aggregates contain failed', () => {
    const summary = summarizeTestOutput(
      [
        ' \u2713 src/main/mcp/WorkspaceToolExecutors.test.ts > summarizeTestOutput > keeps zero failed output green',
        ' Test Files  1 passed (1)',
        '      Tests  0 failed | 3 passed (3)'
      ].join('\n')
    )

    expect(summary.status).toBe('passed')
    expect(summary.totals.failed).toBe(0)
    expect(summary.totals.failedCount).toBe(0)
    expect(summary.failures).toEqual([])
  })

  it('keeps clean typecheck-style output green', () => {
    const summary = summarizeTestOutput('Type check passed with 0 errors.\n')

    expect(summary.status).toBe('passed')
    expect(summary.totals.failed).toBe(0)
    expect(summary.totals.failedCount).toBe(0)
  })

  it('detects real fail markers and positive failed aggregates', () => {
    const summary = summarizeTestOutput(
      [
        ' FAIL  src/main/example.test.ts > rejects invalid input',
        'AssertionError: expected true to be false',
        ' Test Files  1 failed | 2 passed (3)',
        '      Tests  1 failed | 5 passed (6)'
      ].join('\n')
    )

    expect(summary.status).toBe('failed')
    expect(summary.totals.failed).toBeGreaterThan(0)
    expect(summary.totals.failedCount).toBe(1)
  })

  it('detects a mixed pass and real failure output', () => {
    const summary = summarizeTestOutput(
      [
        ' \u2713 src/main/example.test.ts > keeps passing title even if it says failure',
        ' \u00d7 src/main/example.test.ts:12:5 > reports a real failure',
        '      Tests  1 failed | 1 passed (2)'
      ].join('\n')
    )

    expect(summary.status).toBe('failed')
    expect(summary.totals.failed).toBe(1)
    expect(summary.failures[0]?.file).toBe('src/main/example.test.ts')
    expect(summary.failures[0]?.fileLine).toBe(12)
  })
})

describe('executeRunTask', () => {
  it('forwards test args without injecting --run when the vitest script already uses run mode', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'taskwraith-run-task-'))
    try {
      await writeFile(
        resolve(workspace, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } })
      )
      const commands: string[][] = []
      const deps = makeDeps(async (command) => {
        commands.push(command as string[])
        return commandResult([' Test Files  1 passed (1)', '      Tests  1 passed (1)'].join('\n'))
      })

      const result = await executeRunTask(
        deps,
        { task: 'test', args: ['src/foo.test.ts'] },
        workspace
      )

      expect(commands[0]).toEqual(['npm', 'run', 'test', '--', 'src/foo.test.ts'])
      expect(result).toMatchObject({
        task: 'test',
        command: ['npm', 'run', 'test', '--', 'src/foo.test.ts'],
        exitCode: 0
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('injects --run for vitest test scripts that do not already force run mode', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'taskwraith-run-task-'))
    try {
      await writeFile(
        resolve(workspace, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest' } })
      )
      const commands: string[][] = []
      const deps = makeDeps(async (command) => {
        commands.push(command as string[])
        return commandResult([' Test Files  1 passed (1)', '      Tests  1 passed (1)'].join('\n'))
      })

      await executeRunTask(deps, { task: 'test', args: ['src/foo.test.ts'] }, workspace)

      expect(commands[0]).toEqual(['npm', 'run', 'test', '--', '--run', 'src/foo.test.ts'])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

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

describe('executeGetDiagnostics', () => {
  it('runs TypeScript with fixed argv and returns structured problems without marking findings as tool failure', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const commands: string[][] = []
    const deps = makeDeps(async (command) => {
      commands.push(command as string[])
      return commandResult(
        [
          `${resolve(workspace, 'src/App.ts')}(10,5): error TS2322: Type 'string' is not assignable to type 'number'.`,
          '  Assignment came from test data.'
        ].join('\n'),
        2
      )
    })

    const result = await executeGetDiagnostics(
      deps,
      { project: 'tsconfig.json', maxDiagnostics: 10 },
      { scope: 'workspace', cwd: workspace, workspacePath: workspace },
      workspace
    )

    expect(commands[0]).toEqual([
      'npx',
      '--no-install',
      'tsc',
      '--noEmit',
      '--pretty',
      'false',
      '--project',
      resolve(workspace, 'tsconfig.json')
    ])
    expect(result).toMatchObject({
      ok: true,
      tool: 'get_diagnostics',
      status: 'problems',
      hasProblems: true,
      count: 1,
      diagnostics: [
        {
          source: 'typescript',
          severity: 'error',
          path: 'src/App.ts',
          line: 10,
          column: 5,
          code: 'TS2322'
        }
      ],
      runs: [
        {
          source: 'typescript',
          command: [
            'npx',
            '--no-install',
            'tsc',
            '--noEmit',
            '--pretty',
            'false',
            '--project',
            'tsconfig.json'
          ],
          project: 'tsconfig.json',
          exitCode: 2,
          ok: true
        }
      ]
    })
    expect(result.diagnostics[0].message).toContain('Assignment came from test data.')
  })

  it('parses ESLint JSON and filters diagnostics by workspace path', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'taskwraith-mcp-diagnostics-'))
    try {
      await mkdir(resolve(workspace, 'src'))
      await writeFile(resolve(workspace, 'src/App.ts'), 'const value = 1\n')
      const deps = makeDeps(async () =>
        commandResult(
          JSON.stringify([
            {
              filePath: resolve(workspace, 'src/App.ts'),
              messages: [
                {
                  ruleId: 'no-unused-vars',
                  severity: 2,
                  message: 'value is assigned a value but never used.',
                  line: 1,
                  column: 7,
                  endLine: 1,
                  endColumn: 12
                }
              ]
            },
            {
              filePath: resolve(workspace, 'other.ts'),
              messages: [{ ruleId: 'semi', severity: 1, message: 'Missing semicolon.', line: 1 }]
            }
          ]),
          1
        )
      )

      const result = await executeGetDiagnostics(
        deps,
        { source: 'eslint', path: 'src', maxDiagnostics: 10 },
        { scope: 'workspace', cwd: workspace, workspacePath: workspace },
        workspace
      )

      expect(result).toMatchObject({
        ok: true,
        status: 'problems',
        source: 'eslint',
        path: 'src',
        totalDiagnostics: 1,
        diagnostics: [
          {
            source: 'eslint',
            severity: 'error',
            path: 'src/App.ts',
            line: 1,
            column: 7,
            endLine: 1,
            endColumn: 12,
            code: 'no-unused-vars'
          }
        ]
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects global scope and outside-workspace path filters', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const deps = makeDeps(async () => commandResult(''))

    await expect(
      executeGetDiagnostics(deps, {}, { scope: 'global', cwd: workspace }, workspace)
    ).rejects.toThrow('This tool requires an active workspace.')

    await expect(
      executeGetDiagnostics(
        deps,
        { path: '../outside' },
        { scope: 'workspace', cwd: workspace, workspacePath: workspace },
        workspace
      )
    ).rejects.toThrow('Path is outside the workspace.')
  })
})

describe('active run workspace tools', () => {
  it('lists active provider sessions, queue jobs, chat labels, and bounded events', () => {
    const deps = makeDeps(async () => commandResult(''))
    deps.runs.getActiveByProvider = (provider) =>
      provider === 'codex'
        ? [{ provider, runId: 'run-active', appChatId: 'chat-1', status: 'running' } as any]
        : []
    deps.store.getRunQueueJobs = () => [
      {
        id: 'job-1',
        runId: 'run-queued',
        provider: 'codex',
        source: 'manual',
        status: 'queued',
        priority: 0,
        attempt: 1,
        chatId: 'chat-1',
        promptPreview: 'ship it',
        createdAt: '2026-06-29T10:00:00.000Z',
        updatedAt: '2026-06-29T10:01:00.000Z'
      } as any,
      {
        id: 'job-2',
        runId: 'run-done',
        provider: 'codex',
        source: 'manual',
        status: 'completed',
        priority: 0,
        attempt: 1,
        chatId: 'chat-1',
        createdAt: '2026-06-29T09:00:00.000Z',
        updatedAt: '2026-06-29T09:01:00.000Z'
      } as any
    ]
    deps.store.getChat = () =>
      ({
        appChatId: 'chat-1',
        title: 'Focused chat',
        provider: 'codex',
        scope: 'workspace',
        chatKind: 'single',
        workspaceId: 'workspace-1',
        messages: [],
        runs: [{ runId: 'run-active', provider: 'codex', status: 'running' }]
      }) as any
    deps.runs.getRunEvents = (filter) => {
      const runId = filter?.runId || 'unknown'
      return [
        {
          id: `${runId}-old`,
          sequence: 1,
          runId,
          kind: 'status',
          phase: 'started',
          source: 'main',
          timestamp: '2026-06-29T10:00:00.000Z',
          summary: 'old'
        } as any,
        {
          id: `${runId}-new`,
          sequence: 2,
          runId,
          kind: 'status',
          phase: 'completed',
          source: 'main',
          timestamp: '2026-06-29T10:01:00.000Z',
          summary: 'new'
        } as any
      ]
    }

    const result = executeListActiveRuns(
      deps,
      { provider: 'codex', includeEvents: true, eventLimit: 1 },
      { scope: 'workspace', cwd: '/tmp/ws', workspacePath: '/tmp/ws' }
    ) as any

    expect(result.counts).toEqual({ activeSessions: 1, activeQueueJobs: 1, chats: 1 })
    expect(result.activeSessions).toEqual([
      { provider: 'codex', runId: 'run-active', appChatId: 'chat-1', status: 'running' }
    ])
    expect(result.queueJobs[0]).toMatchObject({
      runId: 'run-queued',
      status: 'queued',
      promptPreview: 'ship it'
    })
    expect(result.chats[0]).toMatchObject({ chatId: 'chat-1', title: 'Focused chat' })
    expect(result.events.map((event: any) => event.summary)).toEqual(['new', 'new'])
  })

  it('requires an exact run id before cancelling ambiguous active runs', async () => {
    const deps = makeDeps(async () => commandResult(''))
    const cancelled: Array<{ provider: string; runId?: string }> = []
    deps.runs.getActiveByProvider = (provider) =>
      provider === 'codex'
        ? [
            { provider, runId: 'run-a', appChatId: 'chat-a', status: 'running' } as any,
            { provider, runId: 'run-b', appChatId: 'chat-b', status: 'running' } as any
          ]
        : []
    deps.runs.cancelProviderRun = async (provider, runId) => {
      cancelled.push({ provider, runId })
      return true
    }

    await expect(
      executeCancelActiveRun(
        deps,
        { provider: 'codex', intent: 'Stop stale run' },
        { scope: 'workspace', cwd: '/tmp/ws', workspacePath: '/tmp/ws' }
      )
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Multiple') })
    expect(cancelled).toEqual([])

    await expect(
      executeCancelActiveRun(
        deps,
        { provider: 'codex', runId: 'run-b', intent: 'Stop stale run' },
        { scope: 'workspace', cwd: '/tmp/ws', workspacePath: '/tmp/ws' }
      )
    ).resolves.toMatchObject({
      ok: true,
      provider: 'codex',
      runId: 'run-b',
      message: 'Cancellation requested.'
    })
    expect(cancelled).toEqual([{ provider: 'codex', runId: 'run-b' }])
  })
})

describe('background process workspace tools', () => {
  it('starts a chat-scoped workspace process through the host registry', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const calls: Array<{ command: string; cwd: string; options: unknown }> = []
    const deps = makeDeps(async () => commandResult(''))
    deps.host.startBackgroundProcess = async (command, cwd, options) => {
      calls.push({ command, cwd, options })
      return { ok: true, processId: 'bg-1', running: true }
    }

    const result = await executeStartBackgroundProcess(
      deps,
      {
        command: 'npm run dev',
        cwd: 'packages/app',
        name: 'vite',
        initialWaitMs: 25,
        maxInitialChars: 4096
      },
      { scope: 'workspace', cwd: workspace, workspacePath: workspace, appChatId: 'chat-1' },
      workspace
    )

    expect(result).toMatchObject({ ok: true, processId: 'bg-1', running: true })
    expect(calls).toEqual([
      {
        command: 'npm run dev',
        cwd: resolve(workspace, 'packages/app'),
        options: {
          appChatId: 'chat-1',
          name: 'vite',
          initialWaitMs: 25,
          maxInitialChars: 4096
        }
      }
    ])
  })

  it('rejects background process cwd escapes and missing active chat ids', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const deps = makeDeps(async () => commandResult(''))
    deps.host.startBackgroundProcess = async () => ({ ok: true })

    await expect(
      executeStartBackgroundProcess(
        deps,
        { command: 'npm run dev', cwd: '../outside' },
        { scope: 'workspace', cwd: workspace, workspacePath: workspace, appChatId: 'chat-1' },
        workspace
      )
    ).rejects.toThrow('Path is outside the workspace.')

    await expect(
      executeStartBackgroundProcess(
        deps,
        { command: 'npm run dev' },
        { scope: 'workspace', cwd: workspace, workspacePath: workspace },
        workspace
      )
    ).rejects.toThrow('requires an active chat')
  })

  it('lists, reads, and kills only through chat-scoped host registry ids', async () => {
    const deps = makeDeps(async () => commandResult(''))
    const seen: Record<string, unknown>[] = []
    deps.host.listBackgroundProcesses = (filter) => {
      seen.push({ tool: 'list', ...filter })
      return { ok: true, count: 1 }
    }
    deps.host.readBackgroundProcess = (processId, options) => {
      seen.push({ tool: 'read', processId, ...options })
      return { ok: true, processId, stdout: { text: 'ready' } }
    }
    deps.host.killBackgroundProcess = async (processId, options) => {
      seen.push({ tool: 'kill', processId, ...options })
      return { ok: true, processId, signal: options.signal }
    }
    const context = {
      scope: 'workspace' as const,
      cwd: '/tmp/ws',
      workspacePath: '/tmp/ws',
      appChatId: 'chat-1'
    }

    expect(executeListBackgroundProcesses(deps, context)).toMatchObject({ ok: true, count: 1 })
    expect(
      executeReadBackgroundProcess(
        deps,
        { processId: 'bg-1', stdoutOffset: 10, stderrOffset: 4, maxChars: 2000, stream: 'stdout' },
        context
      )
    ).toMatchObject({ ok: true, processId: 'bg-1' })
    await expect(
      executeKillBackgroundProcess(deps, { processId: 'bg-1', signal: 'SIGKILL' }, context)
    ).resolves.toMatchObject({ ok: true, processId: 'bg-1', signal: 'SIGKILL' })

    expect(seen).toEqual([
      { tool: 'list', appChatId: 'chat-1' },
      {
        tool: 'read',
        processId: 'bg-1',
        appChatId: 'chat-1',
        stdoutOffset: 10,
        stderrOffset: 4,
        maxChars: 2000,
        stream: 'stdout'
      },
      { tool: 'kill', processId: 'bg-1', appChatId: 'chat-1', signal: 'SIGKILL' }
    ])
  })
})

describe('chat attachment workspace tools', () => {
  it('lists current-chat attachments and omits paths by default', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'tw-attachment-list-'))
    const imagePath = resolve(workspace, 'screen.png')
    await writeFile(imagePath, PNG_1X1)
    const deps = makeDeps(async () => commandResult(''))
    deps.store.getChat = (chatId) =>
      ({
        appChatId: chatId,
        title: 'Attachment chat',
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'see attached',
            timestamp: '2026-06-30T10:00:00.000Z',
            metadata: {
              imagePaths: [imagePath],
              mediaRefs: [
                {
                  id: 'media-1',
                  kind: 'image',
                  format: 'raster',
                  source: 'tool_result',
                  name: 'generated.png',
                  mimeType: 'image/png',
                  sha256: 'abc123',
                  byteLength: 42,
                  status: 'available'
                }
              ]
            }
          }
        ],
        runs: []
      }) as any

    const result = executeListChatAttachments(
      deps,
      {},
      { scope: 'workspace', cwd: workspace, workspacePath: workspace, appChatId: 'chat-1' }
    ) as any

    expect(result).toMatchObject({
      ok: true,
      chatId: 'chat-1',
      count: 2,
      totalAttachments: 2
    })
    expect(result.attachments[0]).toMatchObject({
      attachmentId: 'msg-1:image-path:0',
      kind: 'image',
      pathScope: 'workspace',
      hasPath: true
    })
    expect(result.attachments[0]).not.toHaveProperty('path')
    expect(result.attachments[1]).toMatchObject({
      attachmentId: 'media-1',
      source: 'message_media_ref',
      pathScope: 'transcript_asset',
      sha256: 'abc123'
    })
  })

  it('inspects an image attachment by id and returns a rich image block', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'tw-attachment-inspect-'))
    const imagePath = resolve(workspace, 'screen.png')
    await writeFile(imagePath, PNG_1X1)
    const deps = makeDeps(async () => commandResult(''))
    deps.store.getChat = (chatId) =>
      ({
        appChatId: chatId,
        title: 'Attachment chat',
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'see attached',
            timestamp: '2026-06-30T10:00:00.000Z',
            metadata: {
              imagePaths: [imagePath]
            }
          }
        ],
        runs: []
      }) as any

    const result = await executeInspectChatAttachment(
      deps,
      { attachmentId: 'msg-1:image-path:0' },
      { scope: 'workspace', cwd: workspace, workspacePath: workspace, appChatId: 'chat-1' }
    )

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({
      ok: true,
      imageReturned: true,
      attachment: {
        attachmentId: 'msg-1:image-path:0',
        kind: 'image',
        mimeType: 'image/png',
        variant: 'full'
      }
    })
    expect(result.content).toEqual([
      { type: 'image', mimeType: 'image/png', data: PNG_1X1.toString('base64') }
    ])
  })
})

describe('file lifecycle workspace tools', () => {
  async function withWorkspace<T>(fn: (workspace: string) => Promise<T>): Promise<T> {
    const workspace = await mkdtemp(resolve(tmpdir(), 'taskwraith-mcp-lifecycle-'))
    try {
      return await fn(workspace)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  it('creates directories inside the active workspace only', async () => {
    await withWorkspace(async (workspace) => {
      const context = { scope: 'workspace' as const, cwd: workspace, workspacePath: workspace }
      const result = await executeCreateDirectory({ path: 'src/generated' }, context)

      expect(result).toMatchObject({
        ok: true,
        tool: 'create_directory',
        path: 'src/generated',
        created: true
      })
      await expect(executeCreateDirectory({ path: '../outside' }, context)).rejects.toThrow(
        'Path is outside the workspace.'
      )
    })
  })

  it('deletes files and empty directories without recursive removal', async () => {
    await withWorkspace(async (workspace) => {
      const context = { scope: 'workspace' as const, cwd: workspace, workspacePath: workspace }
      await mkdir(resolve(workspace, 'empty'))
      await mkdir(resolve(workspace, 'nonempty'))
      await writeFile(resolve(workspace, 'note.txt'), 'hello')
      await writeFile(resolve(workspace, 'nonempty', 'child.txt'), 'nope')

      await expect(executeDeletePath({ path: 'nonempty' }, context)).rejects.toThrow()
      await expect(readFile(resolve(workspace, 'nonempty', 'child.txt'), 'utf8')).resolves.toBe(
        'nope'
      )

      await expect(executeDeletePath({ path: 'note.txt' }, context)).resolves.toMatchObject({
        ok: true,
        kind: 'file',
        path: 'note.txt'
      })
      await expect(executeDeletePath({ path: 'empty' }, context)).resolves.toMatchObject({
        ok: true,
        kind: 'directory',
        path: 'empty'
      })
    })
  })

  it('moves paths with explicit overwrite and optional parent creation', async () => {
    await withWorkspace(async (workspace) => {
      const context = { scope: 'workspace' as const, cwd: workspace, workspacePath: workspace }
      await writeFile(resolve(workspace, 'from.txt'), 'from')
      await writeFile(resolve(workspace, 'existing.txt'), 'existing')

      await expect(
        executeMovePath({ from: 'from.txt', to: 'existing.txt' }, context)
      ).rejects.toThrow('destination already exists')

      await expect(
        executeMovePath(
          { from: 'from.txt', to: 'nested/to.txt', createParents: true, overwrite: false },
          context
        )
      ).resolves.toMatchObject({
        ok: true,
        tool: 'move_path',
        from: 'from.txt',
        to: 'nested/to.txt',
        kind: 'file'
      })
      await expect(readFile(resolve(workspace, 'nested/to.txt'), 'utf8')).resolves.toBe('from')

      await writeFile(resolve(workspace, 'replacement.txt'), 'replacement')
      await expect(
        executeMovePath(
          { from: 'replacement.txt', to: 'nested/to.txt', overwrite: true },
          context
        )
      ).resolves.toMatchObject({ overwritten: true })
      await expect(readFile(resolve(workspace, 'nested/to.txt'), 'utf8')).resolves.toBe(
        'replacement'
      )
    })
  })

  it('renames within the same directory and rejects path-shaped names/global scope', async () => {
    await withWorkspace(async (workspace) => {
      const context = { scope: 'workspace' as const, cwd: workspace, workspacePath: workspace }
      await writeFile(resolve(workspace, 'old.txt'), 'content')

      await expect(
        executeRenamePath({ path: 'old.txt', newName: '../bad.txt' }, context)
      ).rejects.toThrow('newName must be a basename')

      await expect(
        executeRenamePath({ path: 'old.txt', newName: 'new.txt' }, context)
      ).resolves.toMatchObject({
        ok: true,
        tool: 'rename_path',
        from: 'old.txt',
        to: 'new.txt'
      })
      await expect(readFile(resolve(workspace, 'new.txt'), 'utf8')).resolves.toBe('content')

      await expect(
        executeDeletePath({ path: 'new.txt' }, { scope: 'global', cwd: workspace })
      ).rejects.toThrow('This tool requires an active workspace.')
    })
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

  it('pushes the current branch with upstream inference and refreshed status', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const commands: string[][] = []
    const deps = makeDeps(async (command) => {
      commands.push(command as string[])
      if (command[1] === 'branch') return commandResult('feature/mcp-publish\n')
      if (command[1] === 'rev-parse') return commandResult('', 1)
      if (command[1] === 'push') return commandResult('branch pushed\n')
      if (command[1] === 'status') return commandResult('## feature/mcp-publish...origin/feature/mcp-publish\n')
      if (command[1] === 'branch' && command[2] === '--show-current') return commandResult('feature/mcp-publish\n')
      return commandResult('')
    })

    const result = await executeGitPush(deps, {}, workspace)

    expect(commands.slice(0, 3)).toEqual([
      ['git', 'branch', '--show-current'],
      ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      ['git', 'push', '-u', 'origin', 'feature/mcp-publish']
    ])
    expect(result).toMatchObject({
      ok: true,
      branch: 'feature/mcp-publish',
      setUpstream: true,
      exitCode: 0
    })
  })

  it('runs gh pr create with redacted title/body command metadata', async () => {
    const workspace = resolve('/tmp/taskwraith-workspace-tools')
    const commands: string[][] = []
    const deps = makeDeps(async (command) => {
      commands.push(command as string[])
      return commandResult('https://github.com/example/repo/pull/42\n')
    })

    const result = await executeGitCreatePr(
      deps,
      {
        title: 'Ship MCP publishing',
        body: 'Detailed release notes',
        draft: true,
        base: 'main'
      },
      workspace
    )

    expect(commands[0]).toEqual([
      'gh',
      'pr',
      'create',
      '--title',
      'Ship MCP publishing',
      '--body',
      'Detailed release notes',
      '--draft',
      '--base',
      'main'
    ])
    expect(result).toMatchObject({
      ok: true,
      command: [
        'gh',
        'pr',
        'create',
        '--title',
        '[title]',
        '--body',
        '[body]',
        '--draft',
        '--base',
        'main'
      ],
      url: 'https://github.com/example/repo/pull/42'
    })
  })
})
