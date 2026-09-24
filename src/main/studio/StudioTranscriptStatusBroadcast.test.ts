import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  broadcastStudioTranscriptStatus,
  StudioTranscriptStatusCoordinator,
  studioTranscriptOutcomeStatus,
  studioTranscriptPendingStatus
} from './StudioTranscriptStatusBroadcast'
import {
  STUDIO_TRANSCRIPT_STATUS_CHANNEL,
  isStudioTranscriptStatus
} from '../../shared/studioTranscriptStatus'

describe('Studio transcript status broadcast', () => {
  it('broadcasts pending and typed failure without focusing a window', () => {
    const send = vi.fn()
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    }
    const pending = studioTranscriptPendingStatus('asset-a', 10)
    const unavailable = studioTranscriptOutcomeStatus(
      'asset-a',
      { ok: false, code: 'transcribe_failed', message: 'Speech permission denied' },
      20
    )

    expect(broadcastStudioTranscriptStatus([window], pending)).toBe(1)
    expect(broadcastStudioTranscriptStatus([window], unavailable)).toBe(1)
    expect(send).toHaveBeenNthCalledWith(1, STUDIO_TRANSCRIPT_STATUS_CHANNEL, pending)
    expect(send).toHaveBeenNthCalledWith(2, STUDIO_TRANSCRIPT_STATUS_CHANNEL, unavailable)
    expect(unavailable).toMatchObject({
      state: 'unavailable',
      code: 'transcribe_failed',
      message: 'Speech permission denied'
    })
    expect(isStudioTranscriptStatus(unavailable)).toBe(true)
    expect(isStudioTranscriptStatus({ ...unavailable, message: 'x'.repeat(513) })).toBe(false)
  })

  it('skips destroyed windows and reports a successful segment count', () => {
    const send = vi.fn()
    const destroyed = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send }
    }
    const available = studioTranscriptOutcomeStatus(
      'asset-a',
      { ok: true, segmentCount: 49, adjustedCount: 0, droppedCount: 0 },
      30
    )

    expect(broadcastStudioTranscriptStatus([destroyed], available)).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(available).toMatchObject({
      state: 'available',
      message: 'Studio transcript ready (49 segments).'
    })
  })

  it('isolates a renderer destroy race from the media-open observer', () => {
    const broken = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: () => {
          throw new Error('renderer was destroyed')
        }
      }
    }
    expect(
      broadcastStudioTranscriptStatus([broken], studioTranscriptPendingStatus('asset-a', 10))
    ).toBe(0)
  })

  it('ignores a late outcome from an asset superseded by a newer open', () => {
    const send = vi.fn()
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    }
    const coordinator = new StudioTranscriptStatusCoordinator(() => [window])
    coordinator.started('asset-a', 1, 10)
    coordinator.started('asset-b', 2, 20)
    expect(
      coordinator.completed(
        'asset-a',
        1,
        { ok: false, code: 'transcribe_failed', message: 'late A failure' },
        30
      )
    ).toBeNull()
    expect(
      coordinator.completed(
        'asset-b',
        2,
        { ok: false, code: 'no_usable_segments', message: 'active B failure' },
        40
      )
    ).toMatchObject({ assetId: 'asset-b', state: 'unavailable' })
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
      assetId: 'asset-b',
      message: 'active B failure'
    })
  })

  it('ignores the first completion after the same asset is reopened', () => {
    const send = vi.fn()
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    }
    const coordinator = new StudioTranscriptStatusCoordinator(() => [window])
    coordinator.started('asset-a', 1, 10)
    coordinator.started('asset-a', 2, 20)
    expect(
      coordinator.completed(
        'asset-a',
        1,
        { ok: false, code: 'transcribe_failed', message: 'stale first attempt' },
        30
      )
    ).toBeNull()
    expect(
      coordinator.completed(
        'asset-a',
        2,
        { ok: true, segmentCount: 12, adjustedCount: 0, droppedCount: 0 },
        40
      )
    ).toMatchObject({ state: 'available' })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('is the production observer wired by the composition root', () => {
    const source = readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8')
    expect(source).toContain('new StudioTranscriptStatusCoordinator(')
    expect(source).toContain('studioTranscriptStatusCoordinator.started(assetId, operationId)')
    expect(source).toContain(
      'studioTranscriptStatusCoordinator.completed(assetId, operationId, outcome)'
    )
  })
})
