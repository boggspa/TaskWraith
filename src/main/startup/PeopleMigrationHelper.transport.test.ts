import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPeopleMigrationIsolated } from './PeopleMigrationHelper'
import { readPeopleMigrationLease } from './PeopleMigrationHelperLease'

const fixture = vi.hoisted(() => ({
  profile: '',
  script: '',
  metadataBytes: 0,
  bodyReads: 0,
  child: undefined as ChildProcess | undefined,
  complete: () => {}
}))
vi.mock('../devAppName', () => ({ instanceLaunchBootstrapArgs: [] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: true,
      getPath: () => fixture.profile,
      getName: () => 'Migration IPC Test',
      getAppPath: () => ''
    })
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const file = String(args[0])
      if (
        fixture.profile &&
        file.startsWith(fixture.profile) &&
        (file.includes('/chats/') || file.endsWith('/execution.json'))
      )
        fixture.bodyReads += 1
      return (fs.readFileSync as (...args: unknown[]) => unknown)(...args)
    }
  }
})
vi.mock('node:child_process', async (original) => {
  const childProcess = await original<typeof import('node:child_process')>()
  return {
    ...childProcess,
    spawn: (_executable: string, _args: string[], options: unknown) => {
      // Exercise the real private Node IPC pipe and advanced serialization while
      // replacing only the Electron executable with this isolated protocol peer.
      const child = childProcess.spawn(
        process.execPath,
        [fixture.script, String(fixture.metadataBytes)],
        options as Parameters<typeof childProcess.spawn>[2]
      )
      fixture.child = child
      child.on('message', (message: { type?: string }) => {
        if (message.type === 'complete') fixture.complete()
      })
      return child
    }
  }
})
const directories: string[] = []
afterEach(async () => {
  const child = fixture.child
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
  }
  fixture.child = undefined
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
function setup(metadataBytes: number) {
  fixture.profile = mkdtempSync(join(tmpdir(), 'people-migration-ipc-review-'))
  directories.push(fixture.profile)
  fixture.script = join(fixture.profile, 'peer.cjs')
  fixture.metadataBytes = metadataBytes
  fixture.bodyReads = 0
  mkdirSync(join(fixture.profile, 'chats'))
  writeFileSync(
    join(fixture.profile, 'chats', 'large.json'),
    'synthetic donor bytes'.repeat(150000)
  )
  let ready!: () => void
  const complete = new Promise<void>((resolve) => {
    ready = resolve
  })
  fixture.complete = ready
  writeFileSync(
    fixture.script,
    `
    const size = Number(process.argv[2])
    let request
    process.on('message', (message) => {
      if (message.type === 'initialize') {
        request = message
        process.send({ type: 'armed', nonce: request.nonce })
        return
      }
      if (message.type !== 'run' || message.nonce !== request.nonce) process.exit(1)
      const retireShareIds = Array.from({ length: Math.ceil(size / 180) + 8 }, (_, index) => 'share_' + String(index).padStart(12, '0') + 'q'.repeat(180))
      const recovery = { schemaVersion: 1, planId: 'a'.repeat(64), planDigest: 'b'.repeat(64), sourceDigest: 'c'.repeat(64), source: {}, decisions: {}, phase: 'committed', preparedAt: 1, updatedAt: 2 }
      const result = {
        schemaVersion: 1, terminalPlanId: 'd'.repeat(64),
        migration: { schemaVersion: 1, planId: recovery.planId, phase: 'committed', executionCreatedThisRun: false, routes: [], invitations: [], recovery },
        finalization: { schemaVersion: 1, phase: 'committed', planId: recovery.planId, finalizationDigest: 'e'.repeat(64), retireShareIds, retainedWorkspaceBootstrapShareIds: [], terminalAdmissionEscrowDigest: null, terminalInvitationCount: 0, recovery }
      }
      process.send({ type: 'complete', nonce: request.nonce, result }, () => setTimeout(() => process.exit(0), 80))
    })
    process.send({ type: 'ready', pid: process.pid })
  `
  )
  return complete
}

describe('People migration completion transport', () => {
  it.each([256 * 1024, 2 * 1024 * 1024])(
    'carries more than %i bytes of completion metadata over real IPC without reading donor bodies in the parent',
    async (minimum) => {
      const complete = setup(minimum + 1)
      let settled = false
      const pending = runPeopleMigrationIsolated({ runtimeInstanceId: 'test-runtime' }).finally(
        () => {
          settled = true
        }
      )
      await complete
      expect(settled).toBe(false)
      expect(readPeopleMigrationLease(fixture.profile)?.value.childPid).toBe(fixture.child?.pid)
      const result = await pending
      expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(minimum)
      expect(result.finalization.retireShareIds.length).toBeGreaterThan(0)
      expect(result.legacyWriteGate.isQuiesced()).toBe(true)
      expect(readPeopleMigrationLease(fixture.profile)).toBeNull()
      expect(fixture.bodyReads).toBe(0)
    }
  )

  it('rejects result handoff if deletion appears after completion but before proven child exit', async () => {
    const complete = setup(1024)
    const pending = runPeopleMigrationIsolated({ runtimeInstanceId: 'test-runtime' })
    void pending.catch(() => {})
    await complete
    writeFileSync(join(fixture.profile, 'history-deletion-intent.json'), '{}', { mode: 0o600 })
    await expect(pending).rejects.toThrow('History deletion owns the collaboration source')
    expect(readPeopleMigrationLease(fixture.profile)).toBeNull()
    expect(fixture.bodyReads).toBe(0)
  })
})
