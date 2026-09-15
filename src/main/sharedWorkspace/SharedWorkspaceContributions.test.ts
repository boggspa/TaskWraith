import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceLockRuntime } from '../WorkspaceLockRuntime'
import type { WorkspaceLockProcessIdentityService } from '../WorkspaceLockProcessIdentity'
import { applySharedWorkspaceAction } from './SharedWorkspaceActions'

import { readScopedRegularFile, writeScopedUtf8FileWithLegacyCreate } from '../ScopedPathAccess'
import {
  executeGitCommit,
  type WorkspaceToolExecutorDependencies,
  type HostCommandRunOptions
} from '../mcp/WorkspaceToolExecutors'
import { bindSharedWorkspaceActor, withSharedWorkspaceOperation } from './SharedWorkspaceSession'
import {
  listSharedWorkspaceContributions,
  prepareSharedWorkspaceEdit,
  previewSharedWorkspaceContribution
} from './SharedWorkspaceContributions'

const roots: string[] = []
const runtimes: WorkspaceLockRuntime[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

// The product canonicalises workspace paths with the native realpath
// (`fs.promises.realpath`), which on Windows also expands 8.3 short names
// (`RUNNER~1` -> `runneradmin`); the JS `fs.realpathSync` keeps the short
// name. These tests derive the journal directory and declared commit paths
// from their own root, so the fixture must use the product's flavour.
function canonicalTemporary(prefix: string): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  roots.push(root)
  return root
}

async function actionDependencies() {
  const authorityRoot = canonicalTemporary('tw-shared-authority-')
  // OS identity is injected; the actual WAL, scoped locks, projections and Git operations run on disk.
  const identity = {
    initialize: async () => 'test-process-birth',
    currentProcessIdentity: () => 'test-process-birth',
    observe: async () => ({ state: 'live' as const, processBirthIdentity: 'test-process-birth' }),
    dispose: () => {}
  } as unknown as WorkspaceLockProcessIdentityService
  const runtime = await WorkspaceLockRuntime.open({
    userDataRoot: authorityRoot,
    instanceId: randomUUID(),
    processIdentity: identity
  })
  runtimes.push(runtime)
  return { getRuntime: () => runtime, host: executorDependencies().host }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_INDEX_FILE: undefined }
  }).trim()
}

function fixture() {
  const root = canonicalTemporary('tw-shared-contribution-')
  git(root, 'init', '-q', '-b', 'master')
  // Undo and recover restore bytes through `git apply` on the working tree,
  // which honours the runner's global `core.autocrlf` (true on the Windows
  // CI image) and would rewrite this fixture's LF bytes as CRLF. The bytes
  // are the subject here, so pin the repository's own EOL policy.
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'config', 'user.name', 'Shared workspace test')
  git(root, 'config', 'user.email', 'shared@example.invalid')
  fs.writeFileSync(
    path.join(root, 'source.txt'),
    Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
  )
  git(root, 'add', '--', 'source.txt')
  git(root, 'commit', '-qm', 'initial')
  return root
}

function call<T>(chat: string, tool: string, operation: () => T, provider = 'codex'): T {
  return withSharedWorkspaceOperation(() => {
    bindSharedWorkspaceActor(
      { scope: 'workspace', appChatId: chat, appRunId: `run-${chat}` },
      provider,
      tool,
      `owner-${chat}`
    )
    return operation()
  })
}

async function edit(root: string, chat: string, file: string, content: string, provider = 'codex') {
  const authority = { rootPath: root, targetPath: path.join(root, file) }
  if (fs.existsSync(authority.targetPath))
    await call(
      chat,
      'read_file',
      () => readScopedRegularFile(authority, { maxBytes: 100000 }),
      provider
    )
  await call(
    chat,
    'write_file',
    () => writeScopedUtf8FileWithLegacyCreate(authority, { maxBytes: 100000, content }),
    provider
  )
}

function executorDependencies(): WorkspaceToolExecutorDependencies {
  return {
    host: {
      getTempDir: () => os.tmpdir(),
      runHostCommand: (command, cwd, options) =>
        new Promise((resolve) => {
          const [binary, ...args] = command as string[]
          const environment =
            typeof options === 'object' ? (options as HostCommandRunOptions).environment : undefined
          execFile(
            binary,
            args,
            { cwd, env: { ...process.env, ...environment }, encoding: 'utf8' },
            (error, stdout, stderr) =>
              resolve({
                stdout,
                stderr,
                exitCode: error ? Number(error.code) || 1 : 0,
                timedOut: false,
                durationMs: 0
              })
          )
        })
    },
    store: {} as WorkspaceToolExecutorDependencies['store'],
    runs: {} as WorkspaceToolExecutorDependencies['runs']
  }
}

describe('shared workspace contribution workflow', () => {
  it('invalidates approval when stored patch evidence changes without changing the live file', async () => {
    const root = fixture()
    const chat = randomUUID()
    await edit(root, chat, 'source.txt', 'reviewed content\n')
    const { contributions } = await listSharedWorkspaceContributions(root)
    const preview = await previewSharedWorkspaceContribution(root, contributions[0].id)
    const worktreeId = createHash('sha256').update(root).digest('hex')
    const recordPath = path.join(
      root,
      '.git',
      'taskwraith',
      'shared-workspace-v1',
      worktreeId,
      preview.id,
      `${preview.recordIds[0]}.prepared.json`
    )
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    const unreviewed = 'unreviewed replacement\n'
    record.before.blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      input: unreviewed,
      encoding: 'utf8'
    }).trim()
    record.before.hash = createHash('sha256').update(unreviewed).digest('hex')
    fs.writeFileSync(recordPath, JSON.stringify(record))
    const result = await applySharedWorkspaceAction(await actionDependencies(), {
      root,
      chatId: chat,
      id: preview.id,
      generation: preview.generation,
      action: 'undo'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('changed after the preview')
    expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('reviewed content\n')
  })
  it('does not run repository hooks for internal snapshots, while normal commits retain them', async () => {
    const root = fixture()
    const chat = randomUUID()
    const sentinel = path.join(root, 'hook-ran')
    vi.stubEnv('TW_TEST_HOOK_SENTINEL', sentinel)
    const hooks = path.join(root, '.git', 'hooks')
    git(root, 'config', 'core.hooksPath', hooks)
    // @portability-ok: Git for Windows resolves a hook shebang's interpreter
    // basename through PATH; the normal-commit sentinel below proves it ran.
    fs.writeFileSync(
      path.join(hooks, 'reference-transaction'),
      '#!/bin/sh\nprintf ran > "$TW_TEST_HOOK_SENTINEL"\n',
      { mode: 0o755 }
    )
    await edit(root, chat, 'source.txt', 'captured\n')
    expect(fs.existsSync(sentinel)).toBe(false)
    const result = await call(chat, 'git_commit', () =>
      executeGitCommit(
        executorDependencies(),
        { mode: 'contribution', message: 'normal commit', paths: ['source.txt'] },
        root,
        { scope: 'workspace', cwd: root, workspacePath: root }
      )
    )
    expect(result).toMatchObject({ ok: true })
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('ran')
  })

  it('keeps ignored writes available without enrolling their contents in Git snapshots', async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, '.gitignore'), 'private.env\n')
    await edit(root, randomUUID(), 'private.env', 'test-only-private-value\n')
    expect(fs.readFileSync(path.join(root, 'private.env'), 'utf8')).toBe(
      'test-only-private-value\n'
    )
    expect((await listSharedWorkspaceContributions(root)).contributions).toHaveLength(0)
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/taskwraith/contributions/')).toBe(
      ''
    )
  })
  it('undoes a reviewed contribution under durable locks while preserving peer files and staging', async () => {
    const root = fixture()
    const chat = randomUUID()
    const file = path.join(root, 'source.txt')
    fs.appendFileSync(file, 'peer staged tail\n')
    git(root, 'add', '--', 'source.txt')
    const before = fs.readFileSync(file, 'utf8')
    await edit(root, chat, 'source.txt', before.replace('line 0', 'our first line'))
    fs.writeFileSync(path.join(root, 'peer.ts'), 'peer work')
    const { contributions } = await listSharedWorkspaceContributions(root)
    const preview = await previewSharedWorkspaceContribution(root, contributions[0].id)
    const deps = await actionDependencies()
    expect(
      await applySharedWorkspaceAction(deps, {
        root,
        chatId: chat,
        id: preview.id,
        generation: preview.generation,
        action: 'undo'
      })
    ).toEqual({ ok: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readFileSync(path.join(root, 'peer.ts'), 'utf8')).toBe('peer work')
    expect(git(root, 'diff', '--cached')).toContain('+peer staged tail')
    expect((await listSharedWorkspaceContributions(root)).contributions).toHaveLength(0)
  })

  it('rejects a preview that becomes stale during lock acquisition without overwriting the peer', async () => {
    const root = fixture()
    const chat = randomUUID()
    await edit(root, chat, 'source.txt', 'our content\n')
    const { contributions } = await listSharedWorkspaceContributions(root)
    const preview = await previewSharedWorkspaceContribution(root, contributions[0].id)
    const deps = await actionDependencies()
    const acquire = deps.getRuntime().acquire.bind(deps.getRuntime())
    vi.spyOn(deps.getRuntime(), 'acquire').mockImplementationOnce(async (input) => {
      const result = await acquire(input)
      fs.appendFileSync(path.join(root, 'source.txt'), 'peer raced\n')
      return result
    })
    const result = await applySharedWorkspaceAction(deps, {
      root,
      chatId: chat,
      id: preview.id,
      generation: preview.generation,
      action: 'undo'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('waiting')
    expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toContain('peer raced')
  })

  // Capture is bounded at 1.5 s by design (a mutation lock never waits on
  // audit I/O), and the hosted Windows runner breaches it nondeterministically
  // (~50x macOS on fsync; run 34972722507 listed no prepared record). The
  // budget itself is the product behaviour; this case needs capture to land.
  it.skipIf(process.platform === 'win32')(
    'recovers an interrupted preparation and then permits a reviewed commit on master',
    async () => {
      const root = fixture()
      const chat = randomUUID()
      const targetPath = path.join(root, 'source.txt')
      await call(chat, 'write_file', () =>
        prepareSharedWorkspaceEdit(
          { rootPath: root, targetPath },
          fs.readFileSync(targetPath),
          Buffer.from('recovered\n'),
          false
        )
      )
      let { contributions } = await listSharedWorkspaceContributions(root)
      let preview = await previewSharedWorkspaceContribution(root, contributions[0].id)
      const deps = await actionDependencies()
      expect(
        await applySharedWorkspaceAction(deps, {
          root,
          chatId: chat,
          id: preview.id,
          generation: preview.generation,
          action: 'recover'
        })
      ).toEqual({ ok: true })
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('recovered\n')
      contributions = (await listSharedWorkspaceContributions(root)).contributions
      preview = await previewSharedWorkspaceContribution(root, contributions[0].id)
      expect(preview.state).toBe('ready')
      const result = await applySharedWorkspaceAction(deps, {
        root,
        chatId: chat,
        id: preview.id,
        generation: preview.generation,
        action: 'commit',
        message: 'land recovered contribution'
      })
      expect(result.ok).toBe(true)
      expect(result.commit).toMatch(/^[a-f0-9]+$/)
      expect(git(root, 'show', 'HEAD:source.txt')).toBe('recovered')
      expect(git(root, 'branch', '--show-current')).toBe('master')
    }
  )

  it('honors a foreign live intent claim at the real Git hook instead of bypassing it', async () => {
    const root = fixture()
    const chat = randomUUID()
    await edit(root, chat, 'source.txt', 'our content\n')
    const { contributions } = await listSharedWorkspaceContributions(root)
    const preview = await previewSharedWorkspaceContribution(root, contributions[0].id)
    const hook = path.join(root, '.git', 'hooks', 'pre-commit')
    fs.copyFileSync(path.resolve('.githooks/pre-commit'), hook)
    fs.chmodSync(hook, 0o755)
    const now = new Date()
    fs.writeFileSync(
      path.join(root, '.WORK-IN-PROGRESS-peer.md'),
      `---\nsession: peer\nagent: peer\nlockOwnerId: foreign-owner\nstarted: ${now.toISOString()}\nexpires: ${new Date(now.getTime() + 600000).toISOString()}\npaths:\n  - source.txt\n---\n`
    )
    const result = await applySharedWorkspaceAction(await actionDependencies(), {
      root,
      chatId: chat,
      id: preview.id,
      generation: preview.generation,
      action: 'commit',
      message: 'must not land'
    })
    expect(result.ok).toBe(false)
    expect(git(root, 'log', '-1', '--format=%s')).toBe('initial')
    expect((await listSharedWorkspaceContributions(root)).contributions).toHaveLength(1)
  }, 20000)
  it('captures exact changes and renewable owner claims without dirtying tracked files or creating worktrees', async () => {
    const root = fixture()
    const chat = randomUUID()
    await edit(root, chat, 'source.txt', 'changed\n')
    const result = await listSharedWorkspaceContributions(root)
    expect(result.truncated).toBe(false)
    expect(result.contributions).toHaveLength(1)
    expect(result.contributions[0]).toMatchObject({
      chatId: chat,
      paths: ['source.txt'],
      state: 'ready'
    })
    expect(git(root, 'status', '--porcelain')).toBe('M source.txt')
    expect(git(root, 'branch', '--show-current')).toBe('master')
    expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    const marker = fs
      .readdirSync(root)
      .find((n) => n.startsWith('.WORK-IN-PROGRESS-taskwraith-contribution-'))!
    expect(fs.readFileSync(path.join(root, marker), 'utf8')).toContain(`lockOwnerId: owner-${chat}`)
    expect(
      git(root, 'for-each-ref', '--format=%(refname)', 'refs/taskwraith/contributions/')
    ).toBeTruthy()
    const preview = await previewSharedWorkspaceContribution(root, result.contributions[0].id)
    expect(preview.patch).toContain('+changed')
    expect(preview.reversePatch).toContain('-changed')
  })

  it('commits the captured delta while preserving a peer’s staging in the same file', async () => {
    const root = fixture()
    const chat = randomUUID()
    const file = path.join(root, 'source.txt')
    fs.appendFileSync(file, 'peer staged tail\n')
    git(root, 'add', '--', 'source.txt')
    await edit(
      root,
      chat,
      'source.txt',
      fs.readFileSync(file, 'utf8').replace('line 0', 'our first line')
    )
    const result = await call(chat, 'git_commit', () =>
      executeGitCommit(
        executorDependencies(),
        {
          mode: 'contribution',
          message: 'our contribution',
          paths: ['source.txt']
        },
        root,
        { scope: 'workspace', cwd: root, workspacePath: root, appChatId: chat }
      )
    )
    expect(result).toMatchObject({ ok: true })
    expect(git(root, 'show', 'HEAD:source.txt')).toContain('our first line')
    expect(git(root, 'show', 'HEAD:source.txt')).not.toContain('peer staged tail')
    expect(git(root, 'diff', '--cached', '--', 'source.txt')).toContain('+peer staged tail')
    expect(git(root, 'diff', '--cached', '--', 'source.txt')).not.toContain('+our first line')
    expect(fs.readFileSync(file, 'utf8')).toContain('peer staged tail')
    expect((await listSharedWorkspaceContributions(root)).contributions).toHaveLength(0)
    expect(
      fs.readdirSync(root).some((n) => n.startsWith('.WORK-IN-PROGRESS-taskwraith-contribution-'))
    ).toBe(false)
  })

  it('commits a contribution when the workspace root is reached through a symlink', async () => {
    // The journal root is canonical; declared paths used to be related to it
    // directly, so a symlinked (or 8.3 short-named) workspace root was
    // rejected as "Contribution path escapes its workspace."
    const canonical = fixture()
    const link = path.join(canonicalTemporary('tw-shared-link-'), 'repo')
    fs.symlinkSync(canonical, link, 'junction')
    expect(fs.realpathSync.native(link)).not.toBe(link)
    const chat = randomUUID()
    await edit(link, chat, 'source.txt', 'through the link\n')
    const result = await call(chat, 'git_commit', () =>
      executeGitCommit(
        executorDependencies(),
        { mode: 'contribution', message: 'linked contribution', paths: ['source.txt'] },
        link,
        { scope: 'workspace', cwd: link, workspacePath: link, appChatId: chat }
      )
    )
    expect(result).toMatchObject({ ok: true })
    expect(git(canonical, 'show', 'HEAD:source.txt')).toBe('through the link')
    expect((await listSharedWorkspaceContributions(link)).contributions).toHaveLength(0)
  })

  it('captures new files with spaces and commits them without staging another task’s new file', async () => {
    const root = fixture()
    const chat = randomUUID()
    await edit(root, chat, 'new module.ts', 'export const ours = 1\n')
    await edit(root, randomUUID(), 'peer.ts', 'export const peer = 2\n', 'claude')
    const result = await call(chat, 'git_commit', () =>
      executeGitCommit(
        executorDependencies(),
        {
          mode: 'contribution',
          message: 'add our file',
          paths: ['new module.ts']
        },
        root,
        { scope: 'workspace', cwd: root, workspacePath: root }
      )
    )
    expect(result).toMatchObject({ ok: true })
    expect(git(root, 'show', '--format=', '--name-only', 'HEAD')).toBe('new module.ts')
    expect(git(root, 'status', '--porcelain')).toContain('?? peer.ts')
  })

  it('keeps interrupted preparation recoverable and never calls it a completed edit', async () => {
    const root = fixture()
    const targetPath = path.join(root, 'source.txt')
    const receipt = await call(randomUUID(), 'write_file', () =>
      prepareSharedWorkspaceEdit(
        { rootPath: root, targetPath },
        fs.readFileSync(targetPath),
        Buffer.from('planned'),
        false
      )
    )
    expect(receipt).not.toBeNull()
    const { contributions } = await listSharedWorkspaceContributions(root)
    expect(contributions[0].state).toBe('interrupted')
    expect((await previewSharedWorkspaceContribution(root, contributions[0].id)).patch).toContain(
      '+planned'
    )
    await receipt!.abort()
    expect((await listSharedWorkspaceContributions(root)).contributions).toHaveLength(0)
  })

  it('flags subsequent peer changes and retains a reviewable patch without overwriting them', async () => {
    const root = fixture()
    const chat = randomUUID()
    await edit(root, chat, 'source.txt', 'our change\n')
    const { contributions } = await listSharedWorkspaceContributions(root)
    fs.appendFileSync(path.join(root, 'source.txt'), 'later peer\n')
    const preview = await previewSharedWorkspaceContribution(root, contributions[0].id)
    expect(preview.state).toBe('changed')
    expect(preview.patch).toContain('+our change')
    await expect(
      call(chat, 'git_commit', () =>
        executeGitCommit(
          executorDependencies(),
          {
            mode: 'contribution',
            message: 'stale',
            paths: ['source.txt']
          },
          root,
          { scope: 'workspace', cwd: root, workspacePath: root }
        )
      )
    ).rejects.toThrow('after this contribution')
    expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toContain('later peer')
    expect(git(root, 'log', '-1', '--format=%s')).toBe('initial')
  })
})
