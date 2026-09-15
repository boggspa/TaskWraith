/**
 * Real-process production Host smoke for ensemble projection and seat control.
 *
 * This spawns the compiled pure-Node production Host and uses HostProjectionClient
 * over the published authenticated socket. It proves the Host/profile/projection/
 * transport/seat-toggle chain only. It does NOT start Electron Desktop, run the
 * desktop EnsembleOrchestrator, dispatch an ensemble round, or prove that a user's
 * restarted Desktop completes a round end to end.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HostProjectionClient } from '../host-client/HostProjectionClient'
import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import {
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { HOST_PROFILE_AUTHORITY_LEASE_FILENAME } from './HostProfileAuthorityLease'
import { HostProfileDomainStore } from './HostProfileDomainStore'

const OLD_GENERAL_RESPONSE_LINE_BYTES = 256_000
const LARGE_THREAD_COUNT = 220
// The hosted Windows runner is several times slower than the POSIX legs, and
// this test compiles the Host with tsc inside its own budget (~13 s locally).
const WIN32 = process.platform === 'win32'
const WAIT_BUDGET_MS = WIN32 ? 60_000 : 12_000
const PROJECTION_BUDGET_MS = WIN32 ? 180_000 : 30_000
const EXIT_BUDGET_MS = WIN32 ? 30_000 : 10_000
vi.setConfig({ testTimeout: WIN32 ? 300_000 : 45_000 })
const paths: string[] = []
const children: ChildProcess[] = []

function outputOf(child: ChildProcess): { stdout: string; stderr: string } {
  return (
    (
      child as ChildProcess & {
        __ensembleSmokeOutput?: { stdout: string; stderr: string }
      }
    ).__ensembleSmokeOutput ?? { stdout: '', stderr: '' }
  )
}

function waitFor(check: () => boolean, label: string, timeoutMs = WAIT_BUDGET_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() >= deadline) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${label}`))
      }
    }, 25)
    timer.unref?.()
  })
}

async function waitForAsync<T>(
  check: () => Promise<T | null>,
  label: string,
  timeoutMs = PROJECTION_BUDGET_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== null) return value
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  // @portability-ok Windows cannot deliver SIGTERM: child.kill() terminates the
  // process outright, and the exit is asserted by waitForExit either way.
  if (WIN32) child.kill()
  else child.kill('SIGTERM')
}

function waitForExit(child: ChildProcess, timeoutMs = EXIT_BUDGET_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => {
      reject(new Error(`production Host did not exit: ${JSON.stringify(outputOf(child))}`))
    }, timeoutMs)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function compileProductionCli(root: string): string {
  const outDir = join(root, 'out')
  const compile = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(process.cwd(), 'src', 'host-runtime', 'tsconfig.json'),
      '--outDir',
      outDir
    ],
    { cwd: process.cwd(), encoding: 'utf8' }
  )
  expect(compile.status, `${compile.stdout || ''}${compile.stderr || ''}`).toBe(0)
  const workers = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'build-history-workers.cjs'),
      '--outdir',
      join(outDir, 'host-node')
    ],
    { cwd: process.cwd(), encoding: 'utf8' }
  )
  expect(workers.status, workers.stderr).toBe(0)
  const cli = join(outDir, 'host-runtime', 'cli.js')
  expect(existsSync(cli)).toBe(true)
  chmodSync(cli, 0o755)
  return cli
}

function spawnProductionHost(cli: string, profile: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [cli, 'serve', '--mode', 'production', '--profile', profile],
    {
      cwd: process.cwd(),
      env: { ...process.env, PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const output = { stdout: '', stderr: '' }
  child.stdout?.on('data', (chunk) => {
    output.stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    output.stderr += String(chunk)
  })
  ;(child as ChildProcess & { __ensembleSmokeOutput?: typeof output }).__ensembleSmokeOutput =
    output
  children.push(child)
  return child
}

function hostCommand(
  name: HostCommand['name'],
  commandId: string,
  target: Record<string, string>,
  arguments_: Record<string, unknown>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey: `smoke-${commandId}`,
    actor: {
      actorId: 'ensemble-smoke-client',
      clientId: 'ensemble-smoke-client',
      clientClass: 'test'
    },
    name,
    target,
    arguments: arguments_,
    issuedAt: '2026-08-28T00:00:00.000Z'
  }
}

function seedProfile(
  profile: string,
  workspace: string
): {
  ensembleThreadId: string
  hostileParticipantId: string
} {
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  let id = 0
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => `ensemble-smoke-id-${++id}`,
    now: () => 1_787_904_000_000
  })
  const registered = store.registerWorkspace({
    path: workspace,
    displayName: 'Ensemble smoke workspace'
  })

  const ensembleThreadId = 'ensemble-smoke-thread'
  const hostileParticipantId = 'p'.repeat(490)
  store.persistThreadRecord({
    threadId: ensembleThreadId,
    expectedRevision: 0,
    record: {
      appChatId: ensembleThreadId,
      scope: 'workspace',
      workspaceId: registered.id,
      workspacePath: registered.realPath,
      title: 'Real-process ensemble smoke',
      provider: 'muse',
      chatKind: 'ensemble',
      archived: false,
      pinned: false,
      messages: [],
      updatedAt: 1_787_904_000_000,
      ensemble: {
        participants: [
          {
            id: 'seat-worker',
            provider: 'muse',
            role: 'Worker',
            model: 'muse-spark-1.2',
            stageRole: 'worker',
            order: 0,
            enabled: true,
            status: 'idle',
            instructions: ''
          },
          {
            id: 'seat-review',
            provider: 'grok',
            role: 'Reviewer',
            model: 'grok-4.6',
            stageRole: 'reviewer',
            order: 1,
            enabled: true,
            status: 'idle',
            instructions: ''
          },
          {
            id: 'seat-disabled',
            provider: 'codex',
            role: 'Disabled',
            model: 'gpt-5.6',
            stageRole: 'background',
            order: 2,
            enabled: false,
            status: 'idle',
            instructions: ''
          },
          {
            id: hostileParticipantId,
            provider: 'muse',
            role: 'Hostile',
            model: 'muse-spark-1.2',
            stageRole: 'worker',
            order: 3,
            enabled: true,
            status: 'idle',
            instructions: ''
          }
        ]
      }
    }
  })

  for (let index = 0; index < LARGE_THREAD_COUNT; index += 1) {
    const threadId = `large-thread-${String(index).padStart(3, '0')}`
    const prefix = `large-preview-${String(index).padStart(3, '0')}-`
    const content = `${prefix}${'x'.repeat(2_000)}`.slice(0, 2_000)
    store.persistThreadRecord({
      threadId,
      expectedRevision: 0,
      record: {
        appChatId: threadId,
        scope: 'workspace',
        workspaceId: registered.id,
        workspacePath: registered.realPath,
        title: `Large thread ${index}`,
        provider: 'muse',
        chatKind: 'single',
        archived: false,
        pinned: false,
        messages: [
          {
            id: `message-${index}`,
            role: 'assistant',
            content,
            timestamp: '2026-08-28T00:00:00.000Z'
          }
        ],
        updatedAt: 1_787_904_000_000 + index
      }
    })
  }

  return { ensembleThreadId, hostileParticipantId }
}

afterEach(async () => {
  const activeChildren = children.splice(0)
  for (const child of activeChildren) terminate(child)
  await Promise.all(activeChildren.map((child) => waitForExit(child).catch(() => undefined)))
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

describe('real production Host ensemble smoke', () => {
  it('serves a large quarantined ensemble roster and toggles a seat over the real socket', async () => {
    // Canonicalize the fixture root: win32 temp roots carry 8.3 short-name
    // segments that the Host and the client must agree on byte-for-byte.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-ensemble-smoke-subprocess-')))
    paths.push(root)
    const profile = join(root, 'profile')
    const workspace = join(root, 'workspace')
    const cli = compileProductionCli(root)
    const { ensembleThreadId, hostileParticipantId } = seedProfile(profile, workspace)
    const child = spawnProductionHost(cli, profile)
    let client: HostProjectionClient | null = null

    try {
      try {
        await waitFor(
          () =>
            existsSync(taskWraithHostDiscoveryPath(profile)) &&
            existsSync(taskWraithHostTokenPath(profile)),
          'production discovery'
        )
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; child=${JSON.stringify({
            exitCode: child.exitCode,
            signalCode: child.signalCode,
            ...outputOf(child)
          })}`
        )
      }
      client = new HostProjectionClient({
        userDataPath: profile,
        client: {
          clientId: 'ensemble-smoke-client',
          clientClass: 'test',
          clientVersion: '1.0'
        },
        capabilities: [
          'bootstrap',
          'snapshot',
          'commands',
          'receipts',
          'health',
          'history',
          'ensemble'
        ],
        connectTimeoutMs: 5_000,
        requestTimeoutMs: 10_000
      })

      const welcome = await client.connect()
      expect(welcome.hostVersion).toBe('node-host-v1')
      expect(welcome.capabilities).toEqual(
        expect.arrayContaining(['snapshot', 'commands', 'receipts', 'ensemble'])
      )

      const initial = await client.getSnapshot()
      expect(initial.snapshot.threads.length).toBeLessThanOrEqual(LARGE_THREAD_COUNT + 1)

      // The first projection is deliberately usable while the decoder is still
      // building a cold catalogue. Wait for explicit metadata coverage before
      // asserting the historical large-packet transport boundary.
      const complete = await waitForAsync(async () => {
        const page = await client!.queryThreadCatalogue<{
          coverage: 'partial' | 'complete'
        }>({ method: 'list', limit: 1 })
        if (page.coverage !== 'complete') return null
        const snapshot = await client!.getSnapshot()
        return snapshot.snapshot.threads.length === LARGE_THREAD_COUNT + 1 ? snapshot : null
      }, 'complete cold metadata projection')
      const snapshotBytes = Buffer.byteLength(JSON.stringify(complete), 'utf8')
      expect(snapshotBytes).toBeGreaterThan(OLD_GENERAL_RESPONSE_LINE_BYTES)
      expect(complete.snapshot.threads).toHaveLength(LARGE_THREAD_COUNT + 1)
      expect(
        complete.snapshot.threads.find((thread) => thread.id === ensembleThreadId)
      ).toMatchObject({ chatKind: 'ensemble' })
      expect(complete.snapshot.participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'seat-worker',
            threadId: ensembleThreadId,
            providerId: 'muse',
            role: 'Worker',
            modelId: 'muse-spark-1.2',
            stage: 'worker',
            enabled: true
          }),
          expect.objectContaining({
            id: 'seat-review',
            threadId: ensembleThreadId,
            providerId: 'grok',
            role: 'Reviewer',
            modelId: 'grok-4.6',
            stage: 'reviewer',
            enabled: true
          }),
          expect.objectContaining({
            id: 'seat-disabled',
            threadId: ensembleThreadId,
            providerId: 'codex',
            role: 'Disabled',
            modelId: 'gpt-5.6',
            stage: 'background',
            enabled: false
          })
        ])
      )
      expect(
        complete.snapshot.participants.some(
          (participant) => participant.id === hostileParticipantId
        )
      ).toBe(false)

      expect.soft(complete.snapshot.warnings).toContainEqual(
        expect.objectContaining({
          warningId: 'projection_rows_omitted:participants',
          code: 'projection_rows_omitted',
          message: expect.stringContaining('family participants omitted 1')
        })
      )

      const toggle = await client.submitCommand(
        hostCommand(
          'ensemble.seat.toggle',
          'cmd-ensemble-seat-toggle',
          { threadId: ensembleThreadId },
          { participantId: 'seat-review', enabled: false }
        )
      )
      expect.soft(toggle.status).toBe('succeeded')

      const afterToggle = await client.getSnapshot()
      expect
        .soft(
          afterToggle.snapshot.participants.find(
            (participant) =>
              participant.threadId === ensembleThreadId && participant.id === 'seat-review'
          )
        )
        .toMatchObject({ enabled: false })
    } finally {
      client?.close()
      const graceful = spawnSync(
        process.execPath,
        [cli, 'stop', '--profile', realpathSync(profile)],
        {
          cwd: process.cwd(),
          env: { ...process.env, PATH: '' },
          encoding: 'utf8',
          timeout: EXIT_BUDGET_MS
        }
      )
      if (graceful.status === 0) {
        await waitForExit(child)
      } else {
        terminate(child)
        await waitForExit(child)
      }
      expect(
        graceful.status,
        `${graceful.stdout || ''}${graceful.stderr || ''}${JSON.stringify(outputOf(child))}`
      ).toBe(0)
    }

    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostSocketPath(profile))).toBe(false)
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)
  })
})
