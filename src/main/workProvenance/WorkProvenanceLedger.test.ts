import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readWorkProvenanceEvents,
  settleWorkProvenanceWithin,
  WorkProvenanceRecorder
} from './WorkProvenanceLedger'

const roots: string[] = []

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'work-provenance-test-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', '.'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'provenance@test'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'provenance'], { cwd: root })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', '--', 'src/a.ts'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })
  return root
}

function recorder(): WorkProvenanceRecorder {
  let next = 0
  return new WorkProvenanceRecorder({
    now: () => new Date('2026-08-03T02:00:00.000Z'),
    nextId: () => `event-${++next}`
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('WorkProvenanceRecorder', () => {
  it('persists an exact brokered receipt with stable run and task attribution', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'tool-1',
      toolName: 'replace',
      actor: {
        runId: 'run-1',
        chatId: 'chat-1',
        chatTitle: 'Fix the parser',
        provider: 'codex',
        participantId: 'writer',
        displayName: 'Codex / Writer'
      },
      targets: [
        {
          path: join(root, 'src', 'a.ts'),
          kind: 'hunk',
          hunk: { baseline: 'baseline', startLine: 0, endLine: 1 }
        }
      ]
    })
    expect(operation).not.toBeNull()

    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2\n')
    const captured = await operation!.capture('success')
    await provenance.persist(captured)

    const events = await readWorkProvenanceEvents(root)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'origin',
      confidence: 'exact',
      source: 'taskwraith-broker',
      path: 'src/a.ts',
      actor: {
        runId: 'run-1',
        chatId: 'chat-1',
        chatTitle: 'Fix the parser',
        provider: 'codex',
        participantId: 'writer'
      },
      operation: {
        id: 'tool-1',
        name: 'replace',
        outcome: 'success',
        exclusive: true,
        preexistingDirty: false
      },
      claim: { kind: 'hunk', hunk: { startLine: 0, endLine: 1 } },
      before: { state: 'file' },
      after: { state: 'file' }
    })
    const origin = events[0]
    expect(origin.kind === 'origin' && origin.before?.sha256).not.toBe(
      origin.kind === 'origin' ? origin.after.sha256 : undefined
    )
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(
      ' M src/a.ts\n'
    )
  })

  it('keeps exact edits distinct from dirt that already existed at operation start', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 8\n')
    const provenance = recorder()
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'tool-on-dirty-file',
      toolName: 'replace',
      actor: { runId: 'run-dirty' },
      targets: [{ path: join(root, 'src', 'a.ts'), kind: 'file' }]
    })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 9\n')
    await provenance.persist(await operation!.capture('success'))

    expect(await readWorkProvenanceEvents(root)).toMatchObject([
      {
        kind: 'origin',
        confidence: 'exact',
        operation: { id: 'tool-on-dirty-file', preexistingDirty: true }
      }
    ])
  })

  it('does not invent a receipt for a no-op tool call', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'tool-noop',
      toolName: 'write_file',
      actor: { runId: 'run-noop' },
      targets: [{ path: join(root, 'src', 'a.ts'), kind: 'file' }]
    })
    await provenance.persist(await operation!.capture('success'))
    expect(await readWorkProvenanceEvents(root)).toEqual([])
  })

  it('records a weaker whole-run observation for an opaque native provider', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const observed = await provenance.beginObservedNativeRun({
      workspacePath: root,
      runId: 'native-1',
      actor: { runId: 'native-1', provider: 'antigravity', displayName: 'GemProWork' }
    })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 3\n')
    await provenance.finishObservedNativeRun(observed!, 'completed')

    expect(await readWorkProvenanceEvents(root)).toMatchObject([
      {
        kind: 'origin',
        confidence: 'observed-native',
        source: 'taskwraith-native-run',
        path: 'src/a.ts',
        operation: { id: 'native-1', name: 'provider-run', exclusive: true }
      }
    ])
  })

  it('never calls an unscoped broker observation exclusive', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'shell-unscoped',
      toolName: 'run_shell_command',
      actor: { runId: 'shell-run', provider: 'grok', displayName: 'GrokWork' },
      targets: [],
      observeWorkspaceWhenUnscoped: true
    })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 4\n')
    await provenance.persist(await operation!.capture('success'))

    expect(await readWorkProvenanceEvents(root)).toMatchObject([
      {
        kind: 'origin',
        confidence: 'ambiguous',
        source: 'taskwraith-broker',
        path: 'src/a.ts',
        operation: { id: 'shell-unscoped', exclusive: false }
      }
    ])
  })

  it('does not duplicate a brokered exact receipt as a weaker native-run observation', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const observed = await provenance.beginObservedNativeRun({
      workspacePath: root,
      runId: 'hybrid-1',
      actor: { runId: 'hybrid-1', provider: 'grok', displayName: 'GrokWork' }
    })
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'tool-hybrid',
      toolName: 'replace',
      actor: { runId: 'hybrid-1', provider: 'grok', displayName: 'GrokWork' },
      targets: [{ path: join(root, 'src', 'a.ts'), kind: 'file' }],
      authority: {
        lockOwnerId: 'owner-hybrid',
        authorityInstanceId: 'desktop-hybrid',
        acquisitionTransitionId: 'transition-hybrid'
      }
    })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 5\n')
    await provenance.persist(await operation!.capture('success'))
    await provenance.finishObservedNativeRun(observed!, 'completed')

    expect(await readWorkProvenanceEvents(root)).toMatchObject([
      {
        kind: 'origin',
        confidence: 'exact',
        source: 'taskwraith-broker',
        authority: {
          lockOwnerId: 'owner-hybrid',
          authorityInstanceId: 'desktop-hybrid',
          acquisitionTransitionId: 'transition-hybrid'
        }
      }
    ])
  })

  it('keeps the native observation when the file changes again after the exact tool receipt', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const observed = await provenance.beginObservedNativeRun({
      workspacePath: root,
      runId: 'hybrid-2',
      actor: { runId: 'hybrid-2', provider: 'cursor', displayName: 'CursorWork' }
    })
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'tool-hybrid-2',
      toolName: 'replace',
      actor: { runId: 'hybrid-2', provider: 'cursor', displayName: 'CursorWork' },
      targets: [{ path: join(root, 'src', 'a.ts'), kind: 'file' }]
    })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 6\n')
    await provenance.persist(await operation!.capture('success'))
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 7\n')
    await provenance.finishObservedNativeRun(observed!, 'completed')

    const origins = (await readWorkProvenanceEvents(root)).filter(
      (event) => event.kind === 'origin'
    )
    expect(origins.map((event) => event.confidence)).toEqual(['exact', 'observed-native'])
    expect(origins[0].after.sha256).not.toBe(origins[1].after.sha256)
  })

  it('labels overlapping native runs ambiguous instead of blaming either one exactly', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const observedA = await provenance.beginObservedNativeRun({
      workspacePath: root,
      runId: 'native-a',
      actor: { runId: 'native-a', provider: 'antigravity' }
    })
    const observedB = await provenance.beginObservedNativeRun({
      workspacePath: root,
      runId: 'native-b',
      actor: { runId: 'native-b', provider: 'antigravity' }
    })
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 4\n')
    await provenance.finishObservedNativeRun(observedA!, 'completed')
    await provenance.finishObservedNativeRun(observedB!, 'completed')

    const origins = (await readWorkProvenanceEvents(root)).filter(
      (event) => event.kind === 'origin'
    )
    expect(origins.length).toBeGreaterThan(0)
    expect(origins.every((event) => event.confidence === 'ambiguous')).toBe(true)
  })

  it('keeps a reused native run id isolated by worktree identity', async () => {
    const firstRoot = makeRepo()
    const secondRoot = makeRepo()
    const provenance = recorder()
    const first = await provenance.beginObservedNativeRun({
      workspacePath: firstRoot,
      runId: 'reused-run',
      actor: { runId: 'reused-run', displayName: 'First worktree' }
    })
    const second = await provenance.beginObservedNativeRun({
      workspacePath: secondRoot,
      runId: 'reused-run',
      actor: { runId: 'reused-run', displayName: 'Second worktree' }
    })
    expect(first?.key).not.toBe(second?.key)

    writeFileSync(join(firstRoot, 'src', 'a.ts'), 'export const a = 10\n')
    writeFileSync(join(secondRoot, 'src', 'a.ts'), 'export const a = 11\n')
    await provenance.finishObservedNativeRun(first!, 'completed')
    await provenance.finishObservedNativeRun(second!, 'completed')

    expect(await readWorkProvenanceEvents(firstRoot)).toHaveLength(1)
    expect(await readWorkProvenanceEvents(secondRoot)).toHaveLength(1)
  })

  it('bounds provider-seam provenance work without leaking late rejection', async () => {
    let observedSignal: AbortSignal | undefined
    const started = Date.now()
    const result = await settleWorkProvenanceWithin((signal) => {
      observedSignal = signal
      return new Promise<string>(() => undefined)
    }, 10)
    expect(result).toBeNull()
    expect(observedSignal?.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('makes an aborted one-shot capture permanently null', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const target = join(root, 'src', 'a.ts')
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'aborted-capture',
      toolName: 'replace',
      actor: { runId: 'aborted-capture' },
      targets: [{ path: target, kind: 'file' }]
    })
    writeFileSync(target, 'export const a = 12\n')

    const entered = deferred()
    const release = deferred()
    const resumed = deferred()
    const realLstat = fs.lstat.bind(fs)
    let held = false
    vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (!held && String(path).endsWith(join('src', 'a.ts'))) {
        held = true
        entered.resolve()
        await release.promise
        const stat = await realLstat(path)
        resumed.resolve()
        return stat
      }
      return realLstat(path)
    })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let capture!: Promise<Awaited<ReturnType<NonNullable<typeof operation>['capture']>>>
    const settlement = settleWorkProvenanceWithin(() => {
      capture = operation!.capture('success')
      return capture
    }, 20)
    await entered.promise
    await vi.advanceTimersByTimeAsync(20)
    expect(await settlement).toBeNull()
    expect(await capture).toBeNull()
    expect(await operation!.capture('retry')).toBeNull()
    release.resolve()
    await resumed.promise
    await Promise.resolve()
    await provenance.persist(await operation!.capture('retry-again'))
    expect(await readWorkProvenanceEvents(root)).toEqual([])
  })

  it('does not start delayed capture I/O from an expired deadline context', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const target = join(root, 'src', 'a.ts')
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'delayed-aborted-capture',
      toolName: 'replace',
      actor: { runId: 'delayed-aborted-capture' },
      targets: [{ path: target, kind: 'file' }]
    })
    writeFileSync(target, 'export const a = 13\n')

    const lstat = vi.spyOn(fs, 'lstat')
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    let delayedCapture: Promise<
      Awaited<ReturnType<NonNullable<typeof operation>['capture']>>
    > | null = null
    try {
      expect(
        await settleWorkProvenanceWithin(() => {
          setTimeout(() => {
            delayedCapture = operation!.capture('success')
          }, 30)
          return new Promise<never>(() => undefined)
        }, 10)
      ).toBeNull()

      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      expect(delayedCapture).not.toBeNull()
      expect(await delayedCapture!).toBeNull()
      await new Promise((resolveWait) => setImmediate(resolveWait))
      expect(lstat).not.toHaveBeenCalled()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('removes an aborted native baseline before a later run begins', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const target = join(root, 'src', 'a.ts')
    writeFileSync(target, 'export const a = 20\n')

    const entered = deferred()
    const release = deferred()
    const realLstat = fs.lstat.bind(fs)
    let held = false
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (!held && String(path).endsWith(join('src', 'a.ts'))) {
        held = true
        entered.resolve()
        await release.promise
      }
      return realLstat(path)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let firstBegin!: ReturnType<WorkProvenanceRecorder['beginObservedNativeRun']>
    const settlement = settleWorkProvenanceWithin(() => {
      firstBegin = provenance.beginObservedNativeRun({
        workspacePath: root,
        runId: 'native-aborted',
        actor: { runId: 'native-aborted' }
      })
      return firstBegin
    }, 20)
    await entered.promise
    await vi.advanceTimersByTimeAsync(20)
    expect(await settlement).toBeNull()
    lstat.mockRestore()

    const later = await provenance.beginObservedNativeRun({
      workspacePath: root,
      runId: 'native-later',
      actor: { runId: 'native-later' }
    })
    expect(later).not.toBeNull()
    release.resolve()
    expect(await firstBegin).toBeNull()
    writeFileSync(target, 'export const a = 21\n')
    await provenance.finishObservedNativeRun(later!, 'completed')

    expect(await readWorkProvenanceEvents(root)).toMatchObject([
      {
        kind: 'origin',
        confidence: 'observed-native',
        operation: { id: 'native-later', exclusive: true }
      }
    ])
  })

  it('removes an aborted native finish before a later run begins', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const target = join(root, 'src', 'a.ts')
    const finishing = await provenance.beginObservedNativeRun({
      workspacePath: root,
      runId: 'native-finishing',
      actor: { runId: 'native-finishing' }
    })
    writeFileSync(target, 'export const a = 25\n')

    const entered = deferred()
    const release = deferred()
    const realLstat = fs.lstat.bind(fs)
    let held = false
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (!held && String(path).endsWith(join('src', 'a.ts'))) {
        held = true
        entered.resolve()
        await release.promise
      }
      return realLstat(path)
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let firstFinish!: ReturnType<WorkProvenanceRecorder['finishObservedNativeRun']>
    const settlement = settleWorkProvenanceWithin(() => {
      firstFinish = provenance.finishObservedNativeRun(finishing!, 'completed')
      return firstFinish
    }, 20)
    await entered.promise
    await vi.advanceTimersByTimeAsync(20)
    expect(await settlement).toBeNull()
    lstat.mockRestore()

    const later = await provenance.beginObservedNativeRun({
      workspacePath: root,
      runId: 'native-after-finish',
      actor: { runId: 'native-after-finish' }
    })
    expect(later).not.toBeNull()
    release.resolve()
    await firstFinish
    writeFileSync(target, 'export const a = 26\n')
    await provenance.finishObservedNativeRun(later!, 'completed')

    expect(await readWorkProvenanceEvents(root)).toMatchObject([
      {
        kind: 'origin',
        confidence: 'observed-native',
        operation: { id: 'native-after-finish', exclusive: true }
      }
    ])
  })

  it('serializes persistence and drops a queued receipt when its deadline expires', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const target = join(root, 'src', 'a.ts')
    const firstOperation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'persist-first',
      toolName: 'replace',
      actor: { runId: 'persist-first' },
      targets: [{ path: target, kind: 'file' }]
    })
    writeFileSync(target, 'export const a = 30\n')
    const firstCaptured = await firstOperation!.capture('success')
    const secondOperation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'persist-queued',
      toolName: 'replace',
      actor: { runId: 'persist-queued' },
      targets: [{ path: target, kind: 'file' }]
    })
    writeFileSync(target, 'export const a = 31\n')
    const secondCaptured = await secondOperation!.capture('success')

    const linked = deferred()
    const releaseLink = deferred()
    const realLink = fs.link.bind(fs)
    let held = false
    vi.spyOn(fs, 'link').mockImplementation(async (existingPath, newPath) => {
      await realLink(existingPath, newPath)
      if (!held) {
        held = true
        linked.resolve()
        await releaseLink.promise
      }
    })

    const firstPersist = provenance.persist(firstCaptured)
    await linked.promise
    let queuedPersist!: Promise<void>
    const queuedSettlement = settleWorkProvenanceWithin(() => {
      queuedPersist = provenance.persist(secondCaptured)
      return queuedPersist
    }, 20)
    expect((await queuedSettlement) == null).toBe(true)
    await queuedPersist
    releaseLink.resolve()
    await firstPersist

    const origins = (await readWorkProvenanceEvents(root)).filter(
      (event) => event.kind === 'origin'
    )
    expect(origins).toHaveLength(1)
    expect(origins[0].operation?.id).toBe('persist-first')
    const eventsDirectory = join(
      firstCaptured!.workspace.gitCommonDir,
      'taskwraith',
      'work-provenance-v1',
      'events'
    )
    expect(readdirSync(eventsDirectory).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('finishes durable publication when the deadline expires after hard-link commit', async () => {
    const root = makeRepo()
    const provenance = recorder()
    const target = join(root, 'src', 'a.ts')
    const operation = await provenance.beginBrokeredMutation({
      workspacePath: root,
      operationId: 'persist-committed',
      toolName: 'replace',
      actor: { runId: 'persist-committed' },
      targets: [{ path: target, kind: 'file' }]
    })
    writeFileSync(target, 'export const a = 40\n')
    const captured = await operation!.capture('success')

    const linked = deferred()
    const releaseLink = deferred()
    const realLink = fs.link.bind(fs)
    vi.spyOn(fs, 'link').mockImplementation(async (existingPath, newPath) => {
      await realLink(existingPath, newPath)
      linked.resolve()
      await releaseLink.promise
    })
    const open = vi.spyOn(fs, 'open')
    let persistence!: Promise<void>
    const settlement = settleWorkProvenanceWithin(() => {
      persistence = provenance.persist(captured)
      return persistence
    }, 50)
    await linked.promise
    expect((await settlement) == null).toBe(true)
    releaseLink.resolve()
    await persistence

    expect(await readWorkProvenanceEvents(root)).toMatchObject([
      { kind: 'origin', operation: { id: 'persist-committed' } }
    ])
    const eventsDirectory = join(
      captured!.workspace.gitCommonDir,
      'taskwraith',
      'work-provenance-v1',
      'events'
    )
    expect(
      open.mock.calls.some(
        ([path, flags]) => String(path) === eventsDirectory && String(flags) === 'r'
      )
    ).toBe(true)
    expect(readdirSync(eventsDirectory).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('disables repository fsmonitor code while sampling a mutation baseline', async () => {
    if (process.platform === 'win32') return
    const root = makeRepo()
    const sentinel = join(root, 'fsmonitor-invoked')
    const hook = join(root, '.git', 'fsmonitor-probe.sh')
    writeFileSync(hook, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\nexit 1\n`)
    chmodSync(hook, 0o755)
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: root })

    const operation = await recorder().beginBrokeredMutation({
      workspacePath: root,
      operationId: 'fsmonitor-safe',
      toolName: 'replace',
      actor: { runId: 'fsmonitor-safe' },
      targets: [{ path: join(root, 'src', 'a.ts'), kind: 'file' }]
    })

    expect(operation).not.toBeNull()
    expect(existsSync(sentinel)).toBe(false)
  })

  it('declines cleanly outside a Git repository and never creates workspace litter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'work-provenance-nongit-'))
    roots.push(root)
    const provenance = recorder()
    await expect(
      provenance.beginBrokeredMutation({
        workspacePath: root,
        operationId: 'tool-1',
        toolName: 'write_file',
        actor: { runId: 'run-1' },
        targets: [{ path: join(root, 'a.ts'), kind: 'file' }]
      })
    ).resolves.toBeNull()
    expect(() => readFileSync(join(root, '.git', 'taskwraith'))).toThrow()
  })
})
