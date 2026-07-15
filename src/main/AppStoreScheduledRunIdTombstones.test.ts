import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './store'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-scheduled-run-id-tombstones-${process.pid}`
)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath,
    getVersion: () => '1.0.0'
  }
}))

const ledgerPath = join(userDataPath, 'scheduled-run-id-tombstones.jsonl')

function recordRoot(runId: string, taskId: string): void {
  AppStore.recordScheduledRunIdTombstone({
    runId,
    rootRunId: runId,
    taskId,
    kind: 'root'
  })
}

describe('AppStore scheduled run-id tombstones', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('retains a root identity after its terminal scheduled task is deleted', () => {
    const chat = AppStore.createChat('workspace-1', '/tmp/taskwraith-workspace-1')
    const task = AppStore.saveScheduledTask({
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace-1',
      chatId: chat.appChatId,
      provider: 'codex',
      prompt: 'Run later.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'plan',
      sessionTrust: false,
      imageAttachments: [],
      runAt: '2026-07-14T12:00:00.000Z',
      timezone: 'Europe/London'
    })

    AppStore.recordScheduledRunIdTombstone({
      runId: 'scheduled-root-after-delete',
      rootRunId: 'scheduled-root-after-delete',
      taskId: task.id,
      kind: 'root'
    })
    AppStore.deleteScheduledTask(task.id)

    expect(AppStore.getScheduledTasks()).toEqual([])
    expect(AppStore.hasScheduledRunIdTombstone('scheduled-root-after-delete')).toBe(true)
  })

  it('retains a child identity when ordinary run-event retention purges its audit file', () => {
    recordRoot('scheduled-root-for-child', 'scheduled-task-for-child')
    AppStore.recordScheduledRunIdTombstone({
      runId: 'scheduled-child-after-purge',
      rootRunId: 'scheduled-root-for-child',
      taskId: 'scheduled-task-for-child',
      kind: 'loop-child'
    })
    AppStore.appendRunEvent({
      runId: 'scheduled-child-after-purge',
      provider: 'codex',
      kind: 'lifecycle',
      phase: 'control',
      source: 'main',
      summary: 'Ordinary retained audit evidence'
    })
    const runEventPath = join(
      userDataPath,
      'run-events',
      'scheduled-child-after-purge.jsonl'
    )
    const oldDate = new Date('2026-01-01T00:00:00.000Z')
    fs.utimesSync(runEventPath, oldDate, oldDate)

    const result = AppStore.purgeAuditRetentionEvidence({
      dryRun: false,
      now: '2026-07-14T12:00:00.000Z',
      policy: {
        enabled: true,
        maxAgeDays: {
          approvalLedger: 1,
          runEvents: 1,
          workspaceChanges: 1,
          auditRuns: 1,
          messageFeedback: 1,
          productCrashes: 1
        }
      }
    })

    expect(result.ok).toBe(true)
    expect(fs.existsSync(runEventPath)).toBe(false)
    expect(AppStore.hasScheduledRunIdTombstone('scheduled-child-after-purge')).toBe(true)
  })

  it('is idempotent for the same binding and rejects a conflicting owner', () => {
    recordRoot('scheduled-root-once', 'scheduled-task-once')
    const binding = {
      runId: 'scheduled-child-once',
      rootRunId: 'scheduled-root-once',
      taskId: 'scheduled-task-once',
      kind: 'ensemble-child' as const
    }

    AppStore.recordScheduledRunIdTombstone(binding)
    AppStore.recordScheduledRunIdTombstone(binding)

    const records = fs
      .readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { runId: string })
    expect(records.filter((record) => record.runId === binding.runId)).toHaveLength(1)
    expect(() =>
      AppStore.recordScheduledRunIdTombstone({
        ...binding,
        rootRunId: 'different-root'
      })
    ).toThrow('already bound to another occurrence')
  })

  it('rejects malformed root and child ownership before append', () => {
    expect(() =>
      AppStore.recordScheduledRunIdTombstone({
        runId: 'missing-root-child',
        rootRunId: 'missing-root',
        taskId: 'task-missing-root',
        kind: 'loop-child'
      })
    ).toThrow('requires its durable root tombstone first')
    expect(() =>
      AppStore.recordScheduledRunIdTombstone({
        runId: 'root-a',
        rootRunId: 'root-b',
        taskId: 'task-invalid-root',
        kind: 'root'
      })
    ).toThrow('identity is invalid')
    expect(() =>
      AppStore.recordScheduledRunIdTombstone({
        runId: ' root-with-space',
        rootRunId: ' root-with-space',
        taskId: 'task-whitespace',
        kind: 'root'
      })
    ).toThrow('identity is invalid')
  })

  it('invalidates a warm cache after same-size tampering even when mtime is restored', () => {
    recordRoot('cache-root-a', 'cache-task-a')
    expect(AppStore.hasScheduledRunIdTombstone('cache-root-a')).toBe(true)
    const originalStat = fs.statSync(ledgerPath)
    const original = fs.readFileSync(ledgerPath, 'utf8')
    const tampered = original.replace('cache-root-a', 'cache-root-b')
    expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original))

    fs.writeFileSync(ledgerPath, tampered, 'utf8')
    fs.utimesSync(ledgerPath, originalStat.atime, originalStat.mtime)

    expect(() => AppStore.hasScheduledRunIdTombstone('cache-root-a')).toThrow()
  })

  it('rejects noncanonical, unknown-key, oversized, and nonregular ledgers', () => {
    recordRoot('strict-root', 'strict-task')
    const [line] = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
    const record = JSON.parse(line) as Record<string, unknown>
    fs.writeFileSync(ledgerPath, `${JSON.stringify({ ...record, extra: true })}\n`, 'utf8')
    expect(() => AppStore.validateScheduledRunIdTombstoneLedger()).toThrow('invalid record')

    fs.writeFileSync(ledgerPath, `${'x'.repeat(4 * 1024 + 1)}\n`, 'utf8')
    expect(() => AppStore.validateScheduledRunIdTombstoneLedger()).toThrow(
      'oversized record'
    )

    fs.unlinkSync(ledgerPath)
    const targetPath = join(userDataPath, 'ledger-target.jsonl')
    fs.writeFileSync(targetPath, '', 'utf8')
    fs.symlinkSync(targetPath, ledgerPath)
    expect(() => AppStore.validateScheduledRunIdTombstoneLedger()).toThrow('regular file')
  })

  it('fails closed when the append-only ledger is malformed or incomplete', () => {
    fs.writeFileSync(ledgerPath, '{"schemaVersion":1', 'utf8')

    expect(() => AppStore.hasScheduledRunIdTombstone('unknown-run')).toThrow(
      'incomplete durable tail'
    )

    fs.writeFileSync(ledgerPath, 'not-json\n', 'utf8')
    expect(() => AppStore.hasScheduledRunIdTombstone('unknown-run')).toThrow('invalid JSON')
  })

  it('rejects blank records instead of ignoring byte-level ledger corruption', () => {
    recordRoot('blank-line-root', 'blank-line-task')
    const canonical = fs.readFileSync(ledgerPath, 'utf8')

    for (const corrupted of [`\n${canonical}`, `${canonical}\n`, canonical.replace('\n', '\n\n')]) {
      fs.writeFileSync(ledgerPath, corrupted, 'utf8')
      expect(() => AppStore.validateScheduledRunIdTombstoneLedger()).toThrow('empty record')
      fs.writeFileSync(ledgerPath, canonical, 'utf8')
      AppStore.validateScheduledRunIdTombstoneLedger()
    }
  })
})
