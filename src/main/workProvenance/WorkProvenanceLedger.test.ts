import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  readWorkProvenanceEvents,
  settleWorkProvenanceWithin,
  WorkProvenanceRecorder
} from './WorkProvenanceLedger'

const roots: string[] = []

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
    const started = Date.now()
    const result = await settleWorkProvenanceWithin(() => new Promise<string>(() => undefined), 10)
    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('disables repository fsmonitor code while sampling a mutation baseline', async () => {
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
