import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import {
  WorkspaceLockRuntime,
  type WorkspaceLockRuntimeAcquireInput
} from '../WorkspaceLockRuntime'
import type { WorkspaceLockProcessIdentityService } from '../WorkspaceLockProcessIdentity'
import { acquireWorkspaceMutationWhenAvailable } from '../WorkspaceLockMcpAdmissionCoordinator'
import type { ProviderId } from '../store/types'
import { readScopedRegularFile, writeScopedUtf8FileWithLegacyCreate } from '../ScopedPathAccess'
import {
  executeGitCommit,
  executeRunTask,
  type WorkspaceToolExecutorDependencies,
  type HostCommandRunOptions
} from '../mcp/WorkspaceToolExecutors'
import { bindSharedWorkspaceActor, withSharedWorkspaceOperation } from './SharedWorkspaceSession'
import { listSharedWorkspaceContributions } from './SharedWorkspaceContributions'

const roots: string[] = []
const runtimes: WorkspaceLockRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporary(prefix: string): string {
  // Native realpath: the product canonicalises the workspace with
  // `fs.promises.realpath`, which on Windows expands 8.3 short names
  // (`RUNNER~1`) where the JS `fs.realpathSync` does not, and the declared
  // commit paths are resolved against this root.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  roots.push(root)
  return root
}

describe('shared master model-free concurrency acceptance', () => {
  it('integrates independent provider-labelled writers through real locks, snapshots and private commits', async () => {
    const count = Math.max(2, Math.min(16, Number(process.env.TASKWRAITH_SHARED_TEST_WRITERS) || 4))
    const root = temporary('tw-shared-parallel-')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'master')
    git('config', 'user.name', 'Shared master acceptance')
    git('config', 'user.email', 'shared@example.invalid')
    const files = Array.from({ length: count }, (_, i) => `module-${i}.txt`)
    for (const file of files) fs.writeFileSync(path.join(root, file), 'initial\n')
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'shared-acceptance',
        version: '1.0.0',
        scripts: { test: 'node check.cjs' }
      })
    )
    fs.writeFileSync(
      path.join(root, 'check.cjs'),
      `const fs=require('node:fs'); const assert=require('node:assert/strict'); for(let i=0;i<${count};i++) assert.equal(fs.readFileSync('module-'+i+'.txt','utf8'),'done-'+i+'\\n'); console.log('integrated inputs verified');`
    )
    git('add', '--', ...files, 'package.json', 'check.cjs')
    git('commit', '-qm', 'initial')
    const runtime = await WorkspaceLockRuntime.open({
      userDataRoot: temporary('tw-shared-parallel-authority-'),
      instanceId: randomUUID(),
      processIdentity: {
        initialize: async () => 'test-birth',
        currentProcessIdentity: () => 'test-birth',
        observe: async () => ({ state: 'live', processBirthIdentity: 'test-birth' }),
        dispose: () => {}
      } as unknown as WorkspaceLockProcessIdentityService
    })
    runtimes.push(runtime)
    const deps: WorkspaceToolExecutorDependencies = {
      host: {
        getTempDir: () => os.tmpdir(),
        runHostCommand: (command, cwd, options) =>
          new Promise((resolve) => {
            const [requested, ...args] = command as string[]
            // The real host runner launches argv through its own wrapper
            // shell, which resolves `npm` to `npm.cmd` on Windows. This fake
            // spawns directly, so mirror that: a bare `npm` is ENOENT on
            // win32 and Node refuses to spawn a `.cmd` without a shell.
            // @portability-ok Windows resolves the npm launcher as npm.cmd.
            const binary =
              requested === 'npm' && process.platform === 'win32' ? 'npm.cmd' : requested
            const environment =
              typeof options === 'object'
                ? (options as HostCommandRunOptions).environment
                : undefined
            execFile(
              binary,
              args,
              {
                cwd,
                encoding: 'utf8',
                shell: binary.endsWith('.cmd'),
                env: { ...process.env, npm_config_update_notifier: 'false', ...environment }
              },
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
    const waits: number[] = []
    const writes: number[] = []
    const acquire = async (input: WorkspaceLockRuntimeAcquireInput) => {
      const started = performance.now()
      const result = await acquireWorkspaceMutationWhenAvailable({
        runtime,
        acquire: () => runtime.acquire(input),
        stillWanted: () => performance.now() - started < 100000
      })
      if (!result?.ok)
        throw new Error(
          result && !result.ok ? result.message : 'Writer did not resume after contention.'
        )
      waits.push(performance.now() - started)
      return result
    }
    const started = performance.now()
    const commits = await Promise.all(
      files.map(async (file, i) => {
        const provider = (['codex', 'claude', 'ollama', 'mistral'] as ProviderId[])[i % 4]
        const owner = {
          lockOwnerId: randomUUID(),
          runId: randomUUID(),
          chatId: randomUUID(),
          provider
        }
        const inContext = <T>(tool: string, fn: () => T): T =>
          withSharedWorkspaceOperation(() => {
            bindSharedWorkspaceActor(
              { scope: 'workspace', appRunId: owner.runId, appChatId: owner.chatId },
              provider,
              tool,
              owner.lockOwnerId
            )
            return fn()
          })
        const authority = { rootPath: root, targetPath: path.join(root, file) }
        await inContext('read_file', () => readScopedRegularFile(authority, { maxBytes: 1000 }))
        const edit = await acquire({
          owner,
          mutation: {
            source: 'taskwraith-catalog',
            provider,
            workspacePath: root,
            action: 'write_file',
            args: { path: file, content: `done-${i}\n` }
          }
        })
        const fence = await runtime.acquireMutationFence(
          edit.owner,
          edit.authority.leases.map((l) => l.claim)
        )
        const writeStarted = performance.now()
        try {
          await inContext('write_file', () =>
            writeScopedUtf8FileWithLegacyCreate(authority, {
              maxBytes: 1000,
              content: `done-${i}\n`,
              beforeCommit: async () => {
                const result = await runtime.verifyAcquisitionForMutation(
                  edit.owner,
                  edit.authority.transitionId
                )
                if (!result.ok) throw new Error(result.message)
              }
            })
          )
        } finally {
          runtime.releaseMutationFence(fence)
          await runtime.releaseAcquisition(owner.runId, edit.authority.transitionId)
        }
        writes.push(performance.now() - writeStarted)
        const lease = await acquire({
          owner,
          mutation: {
            source: 'taskwraith-catalog',
            provider,
            workspacePath: root,
            action: 'git_commit',
            args: { mode: 'contribution', paths: [file], message: `complete ${file}` }
          }
        })
        const gitFence = await runtime.acquireMutationFence(
          lease.owner,
          lease.authority.leases.map((l) => l.claim)
        )
        try {
          const result = await inContext('git_commit', () =>
            executeGitCommit(
              deps,
              { mode: 'contribution', paths: [file], message: `complete ${file}` },
              root,
              {
                scope: 'workspace',
                cwd: root,
                workspacePath: root,
                appChatId: owner.chatId,
                assertMutationAuthorized: async () => {
                  const verification = await runtime.verifyAcquisitionForMutation(
                    lease.owner,
                    lease.authority.transitionId
                  )
                  if (!verification.ok) throw new Error(verification.message)
                }
              }
            )
          )
          expect(result).toMatchObject({ ok: true, paths: [file] })
          return result
        } finally {
          runtime.releaseMutationFence(gitFence)
          await runtime.releaseAcquisition(owner.runId, lease.authority.transitionId)
        }
      })
    )
    const check = await executeRunTask(deps, { task: 'test' }, root)
    expect(
      check.exitCode,
      `run_task test exited ${check.exitCode}\nstdout:\n${check.stdout}\nstderr:\n${check.stderr}`
    ).toBe(0)
    expect('verification' in check && check.verification?.state).toBe('passed')
    expect(commits).toHaveLength(count)
    expect(git('rev-list', '--count', 'HEAD')).toBe(String(count + 1))
    expect(git('status', '--porcelain')).toBe('')
    expect(git('branch', '--show-current')).toBe('master')
    expect((await listSharedWorkspaceContributions(root)).contributions).toHaveLength(0)
    expect(git('for-each-ref', '--format=%(refname)', 'refs/taskwraith/contributions/')).toBe('')
    const percentile = (values: number[], p: number) =>
      Math.round(
        [...values].sort((a, b) => a - b)[
          Math.min(values.length - 1, Math.floor(values.length * p))
        ]
      )
    process.stdout.write(
      JSON.stringify({
        scenario: 'shared-master-model-free',
        writers: count,
        integratedCommits: commits.length,
        elapsedMs: Math.round(performance.now() - started),
        writeP95Ms: percentile(writes, 0.95),
        acquisitionP95Ms: percentile(waits, 0.95),
        worktreesCreated: 0
      }) + '\n'
    )
  }, 120000)
})
