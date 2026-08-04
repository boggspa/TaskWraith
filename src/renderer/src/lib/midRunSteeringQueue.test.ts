import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  appendMidRunQueuedMessage,
  buildMidRunQueuedMessage,
  findMidRunQueuedMessage,
  isPreparedSoloSteerQueueJob,
  midRunQueuedMessageId,
  pendingMidRunQueuedMessageIds,
  shouldAppendDueScheduledRun
} from './midRunSteeringQueue'

const NOW = '2026-07-29T03:00:00.000Z'

describe('mid-run queued transcript messages', () => {
  it('persists a solo steer before projecting its visible transcript row', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const start = appSource.indexOf('const handleSteer = async')
    const end = appSource.indexOf('const handleScheduleRun = async', start)
    const handleSteer = appSource.slice(start, end)
    const prepareInput = handleSteer.indexOf('const prepareJob = buildRunQueueJobInputForRequest(')
    const pausedBarrier = handleSteer.indexOf("'paused'", prepareInput)
    const mainPreparation = handleSteer.indexOf(
      'const barrier = await invokePromoteQueuedRunForSteer(',
      pausedBarrier
    )
    const visibleAppend = handleSteer.indexOf('await appendMidRunQueuedRequestToTranscript(')
    const immediateSave = handleSteer.indexOf('{ persistImmediately: true }', visibleAppend)
    const release = handleSteer.indexOf('await invokeFallbackPromotedSteerJob({', immediateSave)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(prepareInput).toBeGreaterThanOrEqual(0)
    expect(pausedBarrier).toBeGreaterThan(prepareInput)
    expect(mainPreparation).toBeGreaterThan(pausedBarrier)
    expect(visibleAppend).toBeGreaterThan(mainPreparation)
    expect(immediateSave).toBeGreaterThan(visibleAppend)
    expect(release).toBeGreaterThan(immediateSave)
    expect(handleSteer).toContain('if (!prepareJob) {')
    expect(handleSteer).toContain('prepareJob,')
    expect(handleSteer).toContain('queueMessageId: steeringMessageId')
    expect(handleSteer).toContain("barrier.jobStatus === 'steer_promoting'")
    expect(handleSteer).toContain("fallbackStatus: 'queued'")
    expect(handleSteer).not.toContain('request.existingPrompt || steeringMessage')
    expect(handleSteer).toContain('prev.filter((candidate) => candidate.appRunId !== steerRunId)')
  })

  it('repairs only an explicitly prepared solo-steer barrier after restart', () => {
    const prepared = {
      runId: 'run-1',
      status: 'steer_promoting' as const,
      queueMessageId: midRunQueuedMessageId('run-1'),
      steerPreparationKind: 'solo_steer_transcript_barrier' as const,
      promotionOwnerToken: 'owner-1',
      promotionToken: 'owner-1',
      request: {
        prompt: 'Please continue.',
        selectedModelType: 'default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: []
      }
    }

    expect(isPreparedSoloSteerQueueJob(prepared)).toBe(true)
    expect(isPreparedSoloSteerQueueJob({ ...prepared, queueMessageId: 'another-row' })).toBe(false)
    expect(isPreparedSoloSteerQueueJob({ ...prepared, status: 'queued' })).toBe(false)
    expect(isPreparedSoloSteerQueueJob({ ...prepared, steerPreparationKind: undefined })).toBe(
      false
    )
    expect(isPreparedSoloSteerQueueJob({ ...prepared, promotionToken: 'other-owner' })).toBe(false)

    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const start = appSource.indexOf('const rehydrateQueuedRuns = async')
    const end = appSource.indexOf('const buildRunRequest = (', start)
    const recovery = appSource.slice(start, end)
    const loadPrepared = recovery.indexOf("statuses: ['queued', 'steer_promoting']")
    const durableRow = recovery.indexOf('await appendMidRunQueuedRequestToTranscript(')
    const release = recovery.indexOf('invokeFallbackPromotedSteerJob({', durableRow)

    expect(loadPrepared).toBeGreaterThanOrEqual(0)
    expect(recovery).toContain("job.status === 'queued' || isPreparedSoloSteerQueueJob(job)")
    expect(durableRow).toBeGreaterThan(loadPrepared)
    expect(release).toBeGreaterThan(durableRow)
  })

  it('uses a deterministic id derived from the durable run id', () => {
    expect(midRunQueuedMessageId('run-1')).toBe('midrun-queued-user-run-1')
  })

  it('builds a timestamped user row with durable queue provenance', () => {
    expect(
      buildMidRunQueuedMessage({
        runId: 'run-1',
        content: 'Please also check the retry path.',
        timestampIso: NOW,
        source: 'soloSteer'
      })
    ).toEqual({
      id: 'midrun-queued-user-run-1',
      role: 'user',
      content: 'Please also check the retry path.',
      timestamp: NOW,
      metadata: {
        kind: 'midRunSteering',
        midRunQueueRunId: 'run-1',
        midRunQueueSource: 'soloSteer'
      }
    })
  })

  it('appends once and recovers the same row after a restart', () => {
    const first = appendMidRunQueuedMessage([], {
      runId: 'run-1',
      content: 'Steer text',
      timestampIso: NOW,
      source: 'soloSteer'
    })
    const second = appendMidRunQueuedMessage(first.messages, {
      runId: 'run-1',
      content: 'Steer text',
      timestampIso: NOW,
      source: 'soloSteer'
    })

    expect(first.appended).toBe(true)
    expect(second.appended).toBe(false)
    expect(second.messages).toBe(first.messages)
    expect(findMidRunQueuedMessage(second.messages, 'run-1')).toBe(first.message)
  })

  it('does not mistake a non-user row with the deterministic id for the prompt', () => {
    const messages: ChatMessage[] = [
      {
        id: midRunQueuedMessageId('run-1'),
        role: 'system',
        content: 'not the prompt',
        timestamp: NOW
      }
    ]
    expect(findMidRunQueuedMessage(messages, 'run-1')).toBeNull()
  })

  it('dedupes pending exclusion ids while preserving order', () => {
    expect(pendingMidRunQueuedMessageIds(['run-1', 'run-2', 'run-1'])).toEqual([
      'midrun-queued-user-run-1',
      'midrun-queued-user-run-2'
    ])
  })
})

describe('shouldAppendDueScheduledRun', () => {
  it('appends only once the countdown has fired into a busy chat', () => {
    const dueAt = '2026-07-29T03:00:00.000Z'
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: dueAt,
        nowMs: Date.parse(dueAt),
        chatBusy: true,
        chatKind: 'single'
      })
    ).toBe(true)
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: dueAt,
        nowMs: Date.parse(dueAt) - 1,
        chatBusy: true,
        chatKind: 'single'
      })
    ).toBe(false)
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: dueAt,
        nowMs: Date.parse(dueAt),
        chatBusy: false,
        chatKind: 'single'
      })
    ).toBe(false)
  })

  it('rejects missing or malformed countdowns', () => {
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: undefined,
        nowMs: Date.parse(NOW),
        chatBusy: true,
        chatKind: 'single'
      })
    ).toBe(false)
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: 'not-a-date',
        nowMs: Date.parse(NOW),
        chatBusy: true,
        chatKind: 'single'
      })
    ).toBe(false)
  })

  it('leaves scheduled Ensemble occurrences on their main-owned round path', () => {
    expect(
      shouldAppendDueScheduledRun({
        scheduledRunAt: NOW,
        nowMs: Date.parse(NOW),
        chatBusy: true,
        chatKind: 'ensemble'
      })
    ).toBe(false)
  })
})
