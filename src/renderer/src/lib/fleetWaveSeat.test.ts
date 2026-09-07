import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { fleetWaveSeatFromWorker } from './fleetWaveSeat'

function child(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'child-1',
    title: 'Child',
    provider: 'codex',
    scope: 'workspace',
    workspacePath: '/workspace',
    archived: false,
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ChatRecord
}

describe('fleetWaveSeatFromWorker', () => {
  it('projects explicit worker choices into the shared seat vocabulary', () => {
    expect(
      fleetWaveSeatFromWorker({
        worker: {
          provider: 'claude',
          model: 'claude-opus-5',
          reasoningEffort: 'max',
          permissionPresetId: 'workspace_write',
          grantsCount: 2,
          role: 'review',
          label: 'Synthesis'
        },
        index: 3
      })
    ).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      role: 'Synthesis',
      seatNumber: 4,
      stageRole: 'reviewer',
      reasoningEffort: 'max',
      permissionPresetId: 'workspace_write',
      grantsCount: 2
    })
  })

  it('resolves model, reasoning, thinking, and effective permission from the child run', () => {
    const seat = fleetWaveSeatFromWorker({
      worker: { provider: 'kimi', role: 'worker', label: 'Performance' },
      index: 1,
      child: child({
        provider: 'kimi',
        requestedModel: 'kimi-k3',
        providerMetadata: { kimiReasoningEffort: 'high', kimiThinkingEnabled: true },
        runs: [
          {
            runId: 'run-1',
            provider: 'kimi',
            startedAt: '2026-08-24T00:00:00.000Z',
            requestedModel: 'kimi-k3',
            providerMetadata: { kimiReasoningEffort: 'high', kimiThinkingEnabled: true },
            permissionPosture: {
              schemaVersion: 1,
              presetId: 'workspace_write',
              externalPathGrantCount: 1,
              postureHash: 'hash',
              signaturePresent: false
            }
          }
        ]
      })
    })

    expect(seat).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k3',
      role: 'Performance',
      seatNumber: 2,
      stageRole: 'worker',
      reasoningEffort: 'high',
      thinkingEnabled: true,
      permissionPresetId: 'workspace_write',
      grantsCount: 1
    })
  })

  it('uses the observed model when the caller selected the provider default', () => {
    const seat = fleetWaveSeatFromWorker({
      worker: { provider: 'codex', label: 'Architecture' },
      index: 0,
      child: child({
        requestedModel: 'cli-default',
        lastActualModel: 'gpt-5.6-terra',
        runs: [
          {
            runId: 'run-1',
            provider: 'codex',
            startedAt: '2026-08-24T00:00:00.000Z',
            requestedModel: 'cli-default',
            actualModel: 'gpt-5.6-terra'
          }
        ]
      })
    })

    expect(seat?.model).toBe('gpt-5.6-terra')
  })

  it('keeps the wave spawn choices when the child is recalled later', () => {
    const seat = fleetWaveSeatFromWorker({
      worker: { provider: 'codex', label: 'Architecture' },
      index: 0,
      child: child({
        runs: [
          {
            runId: 'wave-run',
            provider: 'codex',
            startedAt: '2026-08-24T00:00:00.000Z',
            requestedModel: 'gpt-5.6-terra',
            providerMetadata: { codexReasoningEffort: 'high' }
          },
          {
            runId: 'recall-run',
            provider: 'codex',
            startedAt: '2026-08-24T00:10:00.000Z',
            requestedModel: 'gpt-5.6-sol',
            providerMetadata: { codexReasoningEffort: 'xhigh' }
          }
        ]
      })
    })

    expect(seat).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high'
    })
  })

  it('shows the CLAMPED child posture, not the tier the wave asked for', () => {
    // The precedence used to run the other way, so a card kept advertising its
    // spawn-time request after the child run was clamped below it — the same
    // "badge claims authority the lane never had" defect as the fan-out lane.
    const seat = fleetWaveSeatFromWorker({
      worker: {
        provider: 'claude',
        model: 'claude-opus-5',
        permissionPresetId: 'workspace_write',
        label: 'Scout'
      },
      index: 0,
      child: child({
        provider: 'claude',
        runs: [
          {
            runId: 'wave-run',
            provider: 'claude',
            startedAt: '2026-09-07T00:00:00.000Z',
            permissionPosture: {
              schemaVersion: 1,
              presetId: 'read_only',
              readOnly: true,
              externalPathGrantCount: 0,
              postureHash: 'hash',
              signaturePresent: true
            }
          }
        ]
      })
    })

    expect(seat?.permissionPresetId).toBe('read_only')
  })

  it('shows the grant count the child run actually held, not the wave request', () => {
    // Same precedence as the preset above, off the same seal. KNOWN RESIDUAL:
    // `positiveInt` drops 0, so a run that sealed ZERO grants still falls back
    // to the request. That needs posture-presence awareness plus a decision on
    // whether a zero-grant chip renders at all; tracked separately.
    const seat = fleetWaveSeatFromWorker({
      worker: {
        provider: 'claude',
        model: 'claude-opus-5',
        permissionPresetId: 'workspace_write',
        grantsCount: 3,
        label: 'Scout'
      },
      index: 0,
      child: child({
        provider: 'claude',
        runs: [
          {
            runId: 'wave-run',
            provider: 'claude',
            startedAt: '2026-09-07T00:00:00.000Z',
            permissionPosture: {
              schemaVersion: 1,
              presetId: 'workspace_write',
              externalPathGrantCount: 1,
              postureHash: 'hash',
              signaturePresent: true
            }
          }
        ]
      })
    })

    expect(seat?.grantsCount).toBe(1)
  })

  it('badges a posture that recorded zero grants instead of the roster count', () => {
    // `positiveInt` maps 0 to undefined, so the old `??` chain fell through to
    // the roster and advertised grants the run provably did not hold.
    const seat = fleetWaveSeatFromWorker({
      worker: {
        provider: 'claude',
        model: 'claude-opus-5',
        permissionPresetId: 'workspace_write',
        grantsCount: 3,
        label: 'Scout'
      },
      index: 0,
      child: child({
        provider: 'claude',
        runs: [
          {
            runId: 'wave-run-zero',
            provider: 'claude',
            startedAt: '2026-09-07T00:00:00.000Z',
            permissionPosture: {
              schemaVersion: 1,
              presetId: 'read_only',
              externalPathGrantCount: 0,
              postureHash: 'hash',
              signaturePresent: true
            }
          }
        ]
      })
    })

    expect(seat?.grantsCount).toBeUndefined()
  })

  it('keeps the requested tier when the child recorded no posture', () => {
    // Cards spawned before postures were recorded, and cards whose child never
    // dispatched, still show what was asked for rather than nothing.
    const seat = fleetWaveSeatFromWorker({
      worker: {
        provider: 'claude',
        model: 'claude-opus-5',
        permissionPresetId: 'workspace_write',
        label: 'Scout'
      },
      index: 0,
      child: child({
        provider: 'claude',
        runs: [{ runId: 'wave-run', provider: 'claude', startedAt: '2026-09-07T00:00:00.000Z' }]
      })
    })

    expect(seat?.permissionPresetId).toBe('workspace_write')
  })

  it('renders no tier when neither the seal nor the request carries one', () => {
    expect(
      fleetWaveSeatFromWorker({
        worker: { provider: 'claude', model: 'claude-opus-5', label: 'Scout' },
        index: 0
      })
    ).not.toHaveProperty('permissionPresetId')
  })

  it('returns null rather than inventing a seat when provider or model is unknown', () => {
    expect(fleetWaveSeatFromWorker({ worker: { label: 'Unknown' }, index: 0 })).toBeNull()
    expect(
      fleetWaveSeatFromWorker({ worker: { provider: 'codex', label: 'Unknown' }, index: 0 })
    ).toBeNull()
  })
})
