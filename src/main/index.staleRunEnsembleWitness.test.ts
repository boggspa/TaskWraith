/**
 * Stale-run reconciliation must recognise the exact live Ensemble owner.
 *
 * `EnsembleOrchestrator.seedParticipantRun` persists an active ChatRun and
 * registers the run id in `runsByRunId` BEFORE its async preparation, which has
 * been observed to take up to ~9 minutes. RunManager ownership only begins later
 * inside RunCoordinator. During that window `isChatRunLive` had no probe that
 * could see an owner, so the periodic sweep settled legitimately-preparing runs
 * as orphans: a ChatRun stamped `failed` with `exitCode: 1` and a false error
 * card, while the provider went on to finish successfully.
 *
 * Raising the sweep timeout is NOT a fix — the preparation gap is unbounded in
 * practice. The fix is an ownership witness, and both halves are load-bearing:
 * the witness inside `isChatRunLive`, and passing that same witness into
 * `reconcileOrphanedRunQueueJobs` so the queue-job sweep cannot terminalize a
 * job whose ChatRun the reconciler itself falsely sealed a moment earlier.
 *
 * The composition root has no importable surface. Check its probe order and
 * execute its queue-sweep call with controlled owners. A queue row must never
 * become its own liveness witness, which would retain genuine orphans forever.
 */
import fs from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ScriptTarget, transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { reconcileOrphanedRunQueueJobs } from './ChatRunReconciler'
import { isActiveRunSessionStatus, type RunSessionStatus } from './RunManager'

const indexSource = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start, `Missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0)
  expect(end, `Missing end marker: ${endMarker}`).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

const ENSEMBLE_WITNESS = 'ensembleOrchestratorRef?.getParticipantIdForRun(id) != null'

function executeQueueSweep(
  options: {
    jobStatus?: string
    sessionStatus?: RunSessionStatus
    participantId?: string
  } = {}
): ReturnType<typeof reconcileOrphanedRunQueueJobs> {
  const sweep = sourceBetween(
    'const settlements = reconcileOrphanedRunQueueJobs(',
    'for (const settlement of settlements) {'
  )
  const compiled = transpileModule(sweep, {
    compilerOptions: { target: ScriptTarget.ES2022 }
  }).outputText
  // The general probe counts an active queue row as live. Using it to decide
  // whether that very row is orphaned would make every candidate immortal.
  const queueBackedProbe = vi.fn(() => true)
  const result = runInNewContext(
    `${compiled}\nsettlements`,
    {
      candidates: [{ runId: 'run-a', chatId: 'chat-a', status: options.jobStatus ?? 'active' }],
      fencedChatIds: new Set(),
      terminalRunStatusById: new Map([['run-a', 'failed']]),
      reconcileOrphanedRunQueueJobs,
      isChatRunLive: queueBackedProbe,
      ensembleOrchestratorRef: {
        getParticipantIdForRun: (runId: string) =>
          runId === 'run-a' ? (options.participantId ?? null) : null
      },
      runManager: {
        get: (runId: string) =>
          runId === 'run-a' && options.sessionStatus ? { status: options.sessionStatus } : undefined
      },
      isActiveRunSessionStatus
    },
    { timeout: 1_000 }
  ) as ReturnType<typeof reconcileOrphanedRunQueueJobs>
  expect(queueBackedProbe).not.toHaveBeenCalled()
  return result
}

describe('stale-run reconciliation recognises the live Ensemble owner', () => {
  it('consults the exact Ensemble owner inside isChatRunLive', () => {
    const isChatRunLive = sourceBetween(
      'function isChatRunLive(runId: string | undefined | null): boolean {',
      '/** A chat can have historical persisted runs;'
    )

    expect(isChatRunLive.includes(ENSEMBLE_WITNESS)).toBe(true)
    expect(isChatRunLive.includes(`if (${ENSEMBLE_WITNESS}) return true`)).toBe(true)
  })

  it('asks the Ensemble owner before any probe that can answer false on its own', () => {
    const isChatRunLive = sourceBetween(
      'function isChatRunLive(runId: string | undefined | null): boolean {',
      '/** A chat can have historical persisted runs;'
    )

    const witnessAt = isChatRunLive.indexOf(ENSEMBLE_WITNESS)
    expect(witnessAt).toBeGreaterThanOrEqual(0)

    // Each of these can conclude "not live" without ever consulting the
    // orchestrator, so a witness placed after them would not close the
    // preparation gap it exists to close.
    for (const laterProbe of [
      'const bridgeState = bridgeRunTranscripts.get(id)',
      'backgroundSubThreadTranscripts.get(id)',
      'const job = AppStore.getRunQueueJob(id)'
    ]) {
      const probeAt = isChatRunLive.indexOf(laterProbe)
      expect(probeAt, `Missing probe: ${laterProbe}`).toBeGreaterThanOrEqual(0)
      expect(witnessAt, `Witness must precede: ${laterProbe}`).toBeLessThan(probeAt)
    }
  })

  it('keeps the witness after the active RunManager check, which is the cheaper probe', () => {
    const isChatRunLive = sourceBetween(
      'function isChatRunLive(runId: string | undefined | null): boolean {',
      '/** A chat can have historical persisted runs;'
    )

    const runManagerAt = isChatRunLive.indexOf(
      'if (session && isActiveRunSessionStatus(session.status)) return true'
    )
    expect(runManagerAt).toBeGreaterThanOrEqual(0)
    expect(runManagerAt).toBeLessThan(isChatRunLive.indexOf(ENSEMBLE_WITNESS))
  })

  it('protects a queued Ensemble run before any provider process exists', () => {
    expect(executeQueueSweep({ participantId: 'worker-a' })).toEqual([])
  })

  it.each(['starting', 'running'] as const)('protects a %s provider session', (sessionStatus) => {
    expect(executeQueueSweep({ sessionStatus })).toEqual([])
  })

  it.each(['starting', 'active', 'cancelling'])(
    'settles a genuinely orphaned %s job without accepting the queue as its own owner',
    (jobStatus) => {
      expect(executeQueueSweep({ jobStatus })).toEqual([
        {
          runId: 'run-a',
          chatId: 'chat-a',
          previousStatus: jobStatus,
          nextStatus: 'failed',
          runStatus: 'failed'
        }
      ])
    }
  )

  it('does not let a lingering terminal session protect an abandoned job', () => {
    expect(executeQueueSweep({ sessionStatus: 'completed' })).toHaveLength(1)
  })

  it('releases the ownership witness when the Ensemble owner disappears', () => {
    expect(executeQueueSweep({ participantId: 'worker-a' })).toEqual([])
    expect(executeQueueSweep()).toHaveLength(1)
  })
})
