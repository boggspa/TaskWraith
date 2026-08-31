import { describe, expect, it, vi } from 'vitest'
import type {
  CanvasController,
  CanvasEmulatorController,
  CanvasEmulatorObservationResult,
  CanvasEmulatorStepResult
} from '../canvas/canvasTypes'
import {
  createEmulatorToolExecutors,
  EMULATOR_MCP_TOOL_NAMES,
  isEmulatorMcpToolName
} from './EmulatorToolExecutors'

const CAPTURED_AT = '2026-08-31T22:00:00.000Z'
const FRAME = {
  mimeType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  width: 1,
  height: 1,
  byteLength: 68,
  hash: '4b5c5c92cec3b23e6a294fc0eea43234ef5126c5a64f4c6c531ac8430ab0b844',
  capturedAt: CAPTURED_AT
}

function observationResult(): CanvasEmulatorObservationResult {
  return {
    observation: {
      schemaVersion: 1,
      token: {
        observationId: 'eobs:canvas-1:1',
        emulationGeneration: 1,
        frameId: 1,
        inputEpoch: 0
      },
      capturedAt: CAPTURED_AT,
      humanActive: false,
      frame: {
        mimeType: 'image/png',
        width: 1,
        height: 1,
        byteLength: 68,
        hash: '4b5c5c92cec3b23e6a294fc0eea43234ef5126c5a64f4c6c531ac8430ab0b844',
        capturedAt: CAPTURED_AT
      },
      state: { kind: 'unavailable', reason: 'no_verified_adapter' }
    },
    frame: FRAME
  }
}

function mappedObservationResult(): CanvasEmulatorObservationResult {
  const base = observationResult()
  return {
    ...base,
    observation: {
      ...base.observation,
      state: {
        kind: 'mapped',
        adapterId: 'twgb-state-window',
        adapterRevision: 'v1',
        schemaSha256: 'b'.repeat(64),
        fields: [
          { key: 'x', kind: 'integer', value: 82, unit: 'px' },
          { key: 'y', kind: 'integer', value: 72, unit: 'px' },
          { key: 'input', kind: 'integer', value: 16, unit: 'mask' },
          { key: 'frame-counter', kind: 'integer', value: 2, unit: 'frames' }
        ],
        truncated: false
      }
    },
    driveObservation: {
      observationId: 'drive-observation-1',
      reportId: 'report-1',
      actionId: 'action-1',
      surfaceId: 'canvas-1',
      observer: { runId: 'run-1', provider: 'codex', participantId: null },
      observedAt: 1
    }
  }
}

function stepResult(): CanvasEmulatorStepResult {
  return {
    ...observationResult(),
    outcome: 'completed',
    framesRequested: 2,
    framesCompleted: 2,
    executed: true,
    partial: false,
    driveReportId: 'report-1',
    driveActionId: 'action-1',
    independentVerificationRequired: false,
    driveObservation: {
      observationId: 'drive-observation-1',
      reportId: 'report-1',
      actionId: 'action-1',
      surfaceId: 'canvas-1',
      observer: { runId: 'run-1', provider: 'codex', participantId: null },
      observedAt: 1
    }
  }
}

function controller(overrides: Partial<CanvasController & CanvasEmulatorController> = {}) {
  return {
    open: vi.fn(async () => ({
      canvasId: 'canvas-1',
      url: 'twemu://app/homebrew-demo/index.html',
      title: 'TaskWraith Homebrew Demo',
      viewport: { width: 160, height: 144 }
    })),
    observeEmulator: vi.fn(async () => observationResult()),
    stepEmulator: vi.fn(async () => stepResult()),
    ...overrides
  } as unknown as CanvasController & CanvasEmulatorController
}

const context = {
  appChatId: 'chat-1',
  appRunId: 'run-1',
  workspacePath: '/workspace'
}

describe('EmulatorToolExecutors', () => {
  it('opens only the fixed packaged demo in the embedded dock with no caller override', async () => {
    const control = controller()
    const executors = createEmulatorToolExecutors({ controller: control })

    const result = await executors.executeEmulatorTool('emulator_open', undefined, context, 'codex')

    expect(control.open).toHaveBeenCalledWith(
      {
        driver: 'emulator',
        gameId: 'homebrew-demo',
        embed: true,
        presentation: 'dock'
      },
      expect.objectContaining({ provider: 'codex', chatId: 'chat-1', runId: 'run-1' })
    )
    expect(result.structuredContent).toEqual({
      ok: true,
      tool: 'emulator_open',
      canvasId: 'canvas-1',
      title: 'TaskWraith Homebrew Demo',
      presentation: 'dock'
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain('twemu://')
  })

  it('rejects game, ROM, URL, and presentation overrides before opening', async () => {
    const control = controller()
    const executors = createEmulatorToolExecutors({ controller: control })

    for (const args of [
      { gameId: 'other' },
      { romPath: '/tmp/other.gb' },
      { url: 'https://example.test' },
      { presentation: 'window' }
    ]) {
      const result = await executors.executeEmulatorTool('emulator_open', args, context, 'codex')
      expect(result.isError).toBe(true)
    }
    expect(control.open).not.toHaveBeenCalled()
  })

  it('rejects an invalid opened canvas id without projecting an untrusted title', async () => {
    const control = controller({
      open: vi.fn(async () => ({
        canvasId: 'canvas\nunsafe',
        url: 'twemu://app/homebrew-demo/internal',
        title: 'untrusted controller title',
        viewport: { width: 1, height: 1 }
      }))
    })
    const executors = createEmulatorToolExecutors({ controller: control })

    const result = await executors.executeEmulatorTool('emulator_open', undefined, context, 'codex')
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error:
          'Emulator operation failed. Re-observe or reopen the reviewed emulator surface before retrying.'
      }
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain('untrusted controller title')
  })

  it('projects safe observation metadata structurally and delivers PNG bytes only as one image block', async () => {
    const control = controller({ observeEmulator: vi.fn(async () => mappedObservationResult()) })
    const executors = createEmulatorToolExecutors({ controller: control })

    const result = await executors.executeEmulatorTool(
      'emulator_observe',
      { canvasId: 'canvas-1' },
      context,
      'codex'
    )

    expect(control.observeEmulator).toHaveBeenCalledWith(
      'canvas-1',
      expect.objectContaining({ provider: 'codex', chatId: 'chat-1', runId: 'run-1' })
    )
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tool: 'emulator_observe',
      canvasId: 'canvas-1',
      observation: {
        state: {
          kind: 'mapped',
          fields: [
            { key: 'x', value: 82, unit: 'px' },
            { key: 'y', value: 72, unit: 'px' },
            { key: 'input', value: 16, unit: 'mask' },
            { key: 'frame-counter', value: 2, unit: 'frames' }
          ]
        }
      },
      driveObservation: { observationId: 'drive-observation-1' }
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain(FRAME.data)
    expect(result.content?.filter((block) => block.type === 'image')).toEqual([
      { type: 'image', mimeType: 'image/png', data: FRAME.data }
    ])
  })

  it('drops hostile controller extras from observation, drive receipt, and step result projections', async () => {
    const observed = mappedObservationResult() as CanvasEmulatorObservationResult & {
      internalUrl?: string
      rawRam?: string
      observation: CanvasEmulatorObservationResult['observation'] & { abiWindow?: number[] }
      driveObservation: NonNullable<CanvasEmulatorObservationResult['driveObservation']> & {
        rawReceipt?: string
      }
    }
    observed.internalUrl = 'twemu://app/homebrew-demo/internal'
    observed.rawRam = 'C100:54574742'
    observed.observation = { ...observed.observation, abiWindow: [84, 87, 71, 66] }
    observed.driveObservation = { ...observed.driveObservation, rawReceipt: 'do-not-project' }
    const stepped = {
      ...stepResult(),
      internalUrl: 'twemu://app/homebrew-demo/internal',
      rawRam: 'C100:54574742',
      observation: { ...observed.observation, abiWindow: [84, 87, 71, 66] },
      driveObservation: observed.driveObservation
    } as CanvasEmulatorStepResult
    const control = controller({
      observeEmulator: vi.fn(async () => observed),
      stepEmulator: vi.fn(async () => stepped)
    })
    const executors = createEmulatorToolExecutors({ controller: control })

    const observe = await executors.executeEmulatorTool(
      'emulator_observe',
      { canvasId: 'canvas-1' },
      context,
      'codex'
    )
    const step = await executors.executeEmulatorTool(
      'emulator_step',
      {
        canvasId: 'canvas-1',
        expectedObservationId: 'eobs:canvas-1:1',
        segments: [{ buttons: ['right'], frames: 2 }]
      },
      context,
      'codex'
    )
    for (const result of [observe, step]) {
      const structured = JSON.stringify(result.structuredContent)
      expect(structured).not.toContain('abiWindow')
      expect(structured).not.toContain('rawRam')
      expect(structured).not.toContain('internalUrl')
      expect(structured).not.toContain('rawReceipt')
      expect(structured).not.toContain(FRAME.data)
    }
  })

  it('rejects a mismatched controller frame without exposing its raw error or image bytes', async () => {
    const control = controller({
      observeEmulator: vi.fn(async () => ({
        ...observationResult(),
        frame: { ...FRAME, data: 'AQIE' }
      }))
    })
    const executors = createEmulatorToolExecutors({ controller: control })

    const result = await executors.executeEmulatorTool(
      'emulator_observe',
      { canvasId: 'canvas-1' },
      context,
      'codex'
    )
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error:
          'Emulator operation failed. Re-observe or reopen the reviewed emulator surface before retrying.'
      }
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain('AQIE')
    expect(result.content?.filter((block) => block.type === 'image')).toHaveLength(0)
  })

  it('rejects a self-hashed non-PNG or PNG dimension mismatch before model image delivery', async () => {
    const nonPng = {
      mimeType: 'image/png' as const,
      data: 'bm90IGEgcG5n',
      width: 1,
      height: 1,
      byteLength: 9,
      hash: '2aade9c49b9414c70f452b226271ef5066e2894cdd0557f54857819fb7bcc782',
      capturedAt: CAPTURED_AT
    }
    const dimensionMismatch = { ...FRAME, width: 2 }
    const control = controller({
      observeEmulator: vi
        .fn()
        .mockResolvedValueOnce({
          ...observationResult(),
          observation: { ...observationResult().observation, frame: { ...nonPng } },
          frame: nonPng
        })
        .mockResolvedValueOnce({
          ...observationResult(),
          observation: { ...observationResult().observation, frame: { ...dimensionMismatch } },
          frame: dimensionMismatch
        })
    })
    const executors = createEmulatorToolExecutors({ controller: control })

    for (const source of ['non-png', 'dimension-mismatch']) {
      const result = await executors.executeEmulatorTool(
        'emulator_observe',
        { canvasId: 'canvas-1' },
        context,
        'codex'
      )
      expect(result, source).toMatchObject({ isError: true, structuredContent: { ok: false } })
      expect(result.content?.filter((block) => block.type === 'image')).toHaveLength(0)
    }
  })

  it('prevalidates bounded step input, forwards only validated segments, and keeps frame bytes out of structured data', async () => {
    const control = controller({
      stepEmulator: vi.fn(async () => ({ ...stepResult(), independentVerificationRequired: true }))
    })
    const executors = createEmulatorToolExecutors({ controller: control })

    const rejected = await executors.executeEmulatorTool(
      'emulator_step',
      {
        canvasId: 'canvas-1',
        expectedObservationId: 'eobs:canvas-1:1',
        segments: [{ buttons: ['left', 'right'], frames: 1 }]
      },
      context,
      'codex'
    )
    expect(rejected.isError).toBe(true)
    expect(control.stepEmulator).not.toHaveBeenCalled()

    const result = await executors.executeEmulatorTool(
      'emulator_step',
      {
        canvasId: 'canvas-1',
        expectedObservationId: 'eobs:canvas-1:1',
        segments: [{ buttons: ['right'], frames: 2 }],
        requireIndependentVerifier: true
      },
      context,
      'codex'
    )
    expect(control.stepEmulator).toHaveBeenCalledWith(
      'canvas-1',
      {
        expectedObservationId: 'eobs:canvas-1:1',
        segments: [{ buttons: ['right'], frames: 2 }],
        requireIndependentVerifier: true
      },
      expect.objectContaining({ provider: 'codex', chatId: 'chat-1', runId: 'run-1' })
    )
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tool: 'emulator_step',
      canvasId: 'canvas-1',
      outcome: 'completed',
      framesRequested: 2,
      framesCompleted: 2
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain(FRAME.data)
    expect(result.content?.filter((block) => block.type === 'image')).toHaveLength(1)
  })

  it('keeps refused and partial emulator macros explicit instead of falsely projecting success', async () => {
    const refused = {
      ...stepResult(),
      outcome: 'refused' as const,
      refusalReason: 'stale_observation' as const,
      framesCompleted: 0,
      executed: false,
      partial: false,
      driveObservation: undefined
    }
    const partial = {
      ...stepResult(),
      outcome: 'interrupted' as const,
      refusalReason: 'user_active' as const,
      framesCompleted: 1,
      executed: true,
      partial: true,
      driveObservation: undefined
    }
    const finalFrameInterruption = {
      ...stepResult(),
      outcome: 'interrupted' as const,
      refusalReason: 'user_active' as const,
      framesRequested: 1,
      framesCompleted: 1,
      executed: true,
      partial: false,
      driveObservation: undefined
    }
    const control = controller({
      stepEmulator: vi
        .fn()
        .mockResolvedValueOnce(refused)
        .mockResolvedValueOnce(partial)
        .mockResolvedValueOnce(finalFrameInterruption)
    })
    const executors = createEmulatorToolExecutors({ controller: control })
    const args = {
      canvasId: 'canvas-1',
      expectedObservationId: 'eobs:canvas-1:1',
      segments: [{ buttons: ['right'], frames: 2 }]
    }

    const refusedResult = await executors.executeEmulatorTool(
      'emulator_step',
      args,
      context,
      'codex'
    )
    expect(refusedResult.structuredContent).toMatchObject({
      ok: false,
      outcome: 'refused',
      executed: false,
      partial: false,
      framesCompleted: 0
    })
    expect(refusedResult.isError).toBe(true)
    const partialResult = await executors.executeEmulatorTool(
      'emulator_step',
      args,
      context,
      'codex'
    )
    expect(partialResult.structuredContent).toMatchObject({
      ok: false,
      outcome: 'interrupted',
      executed: true,
      partial: true,
      framesCompleted: 1
    })
    expect(partialResult.isError).toBe(true)
    const finalFrameResult = await executors.executeEmulatorTool(
      'emulator_step',
      { ...args, segments: [{ buttons: ['right'], frames: 1 }] },
      context,
      'codex'
    )
    expect(finalFrameResult.structuredContent).toMatchObject({
      ok: false,
      outcome: 'interrupted',
      refusalReason: 'user_active',
      executed: true,
      partial: false,
      framesRequested: 1,
      framesCompleted: 1
    })
    expect(finalFrameResult.isError).toBe(true)
  })

  it('fails closed for cross-surface drive receipts and impossible outcome accounting', async () => {
    const crossSurface = {
      ...stepResult(),
      driveObservation: { ...stepResult().driveObservation!, surfaceId: 'canvas-other' }
    }
    const crossRun = {
      ...stepResult(),
      driveObservation: {
        ...stepResult().driveObservation!,
        observer: { runId: 'run-other', provider: 'codex', participantId: null }
      }
    }
    const crossProvider = {
      ...stepResult(),
      driveObservation: {
        ...stepResult().driveObservation!,
        observer: { runId: 'run-1', provider: 'claude', participantId: null }
      }
    }
    const completedWithRefusal = {
      ...stepResult(),
      refusalReason: 'stale_observation' as const
    }
    const completedWithoutReceipt = {
      ...stepResult(),
      driveObservation: undefined
    }
    const refusedWithReceipt = {
      ...stepResult(),
      outcome: 'refused' as const,
      refusalReason: 'stale_observation' as const,
      framesCompleted: 0,
      executed: false,
      partial: false
    }
    const refusedWithProgress = {
      ...stepResult(),
      outcome: 'refused' as const,
      refusalReason: 'stale_observation' as const,
      framesCompleted: 1,
      executed: true,
      partial: true
    }
    const control = controller({
      stepEmulator: vi
        .fn()
        .mockResolvedValueOnce(crossSurface)
        .mockResolvedValueOnce(crossRun)
        .mockResolvedValueOnce(crossProvider)
        .mockResolvedValueOnce(completedWithoutReceipt)
        .mockResolvedValueOnce(completedWithRefusal)
        .mockResolvedValueOnce(refusedWithReceipt)
        .mockResolvedValueOnce(refusedWithProgress)
    })
    const executors = createEmulatorToolExecutors({ controller: control })
    const args = {
      canvasId: 'canvas-1',
      expectedObservationId: 'eobs:canvas-1:1',
      segments: [{ buttons: ['right'], frames: 2 }]
    }

    for (const _case of [
      'cross-surface',
      'cross-run',
      'cross-provider',
      'completed-without-receipt',
      'completed-refusal',
      'refused-with-receipt',
      'refused-progress'
    ]) {
      const result = await executors.executeEmulatorTool('emulator_step', args, context, 'codex')
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error:
            'Emulator operation failed. Re-observe or reopen the reviewed emulator surface before retrying.'
        }
      })
      expect(result.content?.filter((block) => block.type === 'image')).toHaveLength(0)
    }
  })

  it('requires exact chat/run authority and exposes only the fixed tool family', async () => {
    const control = controller()
    const executors = createEmulatorToolExecutors({ controller: control })

    const result = await executors.executeEmulatorTool('emulator_open', {}, {}, 'codex')
    expect(result).toMatchObject({ isError: true, structuredContent: { ok: false } })
    expect(EMULATOR_MCP_TOOL_NAMES).toEqual(['emulator_open', 'emulator_observe', 'emulator_step'])
    expect(isEmulatorMcpToolName('emulator_step')).toBe(true)
    expect(isEmulatorMcpToolName('canvas_open')).toBe(false)
  })

  it('rejects malformed opaque canvas ids before invoking an emulator controller', async () => {
    const control = controller()
    const executors = createEmulatorToolExecutors({ controller: control })

    const result = await executors.executeEmulatorTool(
      'emulator_observe',
      { canvasId: 'canvas\n1' },
      context,
      'codex'
    )
    expect(result).toMatchObject({ isError: true })
    expect(control.observeEmulator).not.toHaveBeenCalled()
  })
})
