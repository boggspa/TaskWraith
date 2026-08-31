import { describe, expect, it, vi } from 'vitest'
import type { CanvasCallContext } from '../canvas/canvasTypes'
import { AppDriveLeaseRegistry } from './AppDriveLease'
import { AppDriveLeaseRuntime, type AppDriveLeaseRuntimeDeps } from './AppDriveLeaseRuntime'

function harness(
  options: {
    resolveEmulatorSurface?: NonNullable<AppDriveLeaseRuntimeDeps['resolveEmulatorSurface']>
  } = {}
) {
  const leases = new AppDriveLeaseRegistry({ now: () => 1_000 })
  const hasSessionGrant = vi.fn(() => false)
  const removeSessionGrant = vi.fn(() => true)
  const runtime = new AppDriveLeaseRuntime({
    leases,
    simulatorController: { authorizeUserLease: vi.fn() } as never,
    simulatorSessions: {
      get: () => ({
        chatId: 'chat-a',
        udid: 'DEVICE-1',
        bundleId: 'com.example.App',
        updatedAt: 't'
      })
    },
    hasSessionGrant,
    removeSessionGrant,
    webOrigin: () => 'https://example.test',
    ...(options.resolveEmulatorSurface
      ? { resolveEmulatorSurface: options.resolveEmulatorSurface }
      : {})
  })
  return { leases, runtime, hasSessionGrant, removeSessionGrant }
}

function emulatorDescriptor(runtime: AppDriveLeaseRuntime) {
  const descriptor = runtime.prepareApproval(
    'emulator_step',
    { canvasId: 'canvas-emulator-a' },
    'chat-a',
    {}
  )
  if (!descriptor) throw new Error('expected emulator descriptor')
  return descriptor
}

function authorizeEmulator(
  runtime: AppDriveLeaseRuntime,
  descriptor = emulatorDescriptor(runtime),
  overrides: Record<string, unknown> = {}
) {
  return runtime.authorize({
    descriptor,
    provider: 'codex',
    service: 'canvasInteraction',
    workspacePath: '/repo',
    chatId: 'chat-a',
    runId: 'run-a',
    participantId: 'seat-a',
    approval: { action: 'accept', decisionSource: 'user' },
    oneOffPermissionRetry: false,
    ...overrides
  } as Parameters<AppDriveLeaseRuntime['authorize']>[0])
}

describe('AppDriveLeaseRuntime', () => {
  it('places the exact derived surface in the human approval preview', () => {
    const { runtime } = harness()
    const preview: Record<string, unknown> = {}
    expect(
      runtime.prepareApproval('simulator_tap', { udid: 'DEVICE-1' }, 'chat-a', preview)
    ).toMatchObject({
      surfaceId: 'simulator:DEVICE-1:com.example.App'
    })
    expect(preview.surfaceId).toBe('simulator:DEVICE-1:com.example.App')
    expect(preview.independentVerificationRequired).toBe(false)
  })

  it('enriches a web lease with its current origin after user approval', () => {
    const { leases, runtime } = harness()
    const preview: Record<string, unknown> = {}
    const descriptor = runtime.prepareApproval(
      'canvas_click',
      { canvasId: 'canvas-a', requireIndependentVerifier: true },
      'chat-a',
      preview
    )!
    expect(preview.independentVerificationRequired).toBe(true)
    expect(
      runtime.authorize({
        descriptor,
        provider: 'codex',
        service: 'canvasInteraction',
        workspacePath: '/repo',
        chatId: 'chat-a',
        runId: 'run-a',
        participantId: 'seat-a',
        approval: { action: 'accept', decisionSource: 'user' },
        oneOffPermissionRetry: false
      })
    ).toEqual({ ok: true })
    expect(leases.peek('canvas-a')).toMatchObject({
      target: { origin: 'https://example.test' },
      independentVerificationRequired: true
    })
  })

  it('keeps emulator approval scoped to a live exact chat-owned canvas only', () => {
    const resolveEmulatorSurface = vi.fn(
      (canvasId: string, context: CanvasCallContext): 'emulator' | 'other' =>
        canvasId === 'canvas-emulator-a' && context.chatId === 'chat-a' && context.runId === 'run-a'
          ? 'emulator'
          : 'other'
    )
    const { leases, runtime } = harness({ resolveEmulatorSurface })
    const descriptor = emulatorDescriptor(runtime)

    expect(authorizeEmulator(runtime, descriptor)).toEqual({ ok: true })
    expect(resolveEmulatorSurface).toHaveBeenCalledWith(
      'canvas-emulator-a',
      expect.objectContaining({ chatId: 'chat-a', runId: 'run-a', provider: 'codex' })
    )
    expect(leases.peek('canvas-emulator-a')).toMatchObject({
      surfaceKind: 'emulator',
      target: { canvasId: 'canvas-emulator-a' },
      allowedVerbs: ['emulator_step']
    })
  })

  it('fails closed without a live emulator resolver without minting authority', () => {
    const { leases, runtime, removeSessionGrant } = harness()

    expect(authorizeEmulator(runtime)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/emulator/i)
    })
    expect(leases.peek('canvas-emulator-a')).toBeNull()
    expect(removeSessionGrant).not.toHaveBeenCalled()
  })

  it('rechecks a prepared emulator descriptor before a stale current lease can fast-path', () => {
    let surfaceState: 'emulator' | 'other' | 'missing' = 'emulator'
    const { leases, runtime, removeSessionGrant } = harness({
      resolveEmulatorSurface: () => surfaceState
    })
    const descriptor = emulatorDescriptor(runtime)
    expect(authorizeEmulator(runtime, descriptor)).toEqual({ ok: true })

    surfaceState = 'missing'
    expect(authorizeEmulator(runtime, descriptor, { approval: undefined })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/emulator/i)
    })
    expect(leases.peek('canvas-emulator-a')).toMatchObject({
      status: 'revoked',
      revocationReason: 'surface-closed'
    })
    expect(removeSessionGrant).toHaveBeenCalledWith(
      'codex',
      '/repo',
      'canvasInteraction',
      'run-a',
      'canvas-emulator-a'
    )
  })

  it('fails closed for missing, wrong-kind, and throwing live-surface checks', () => {
    const cases: Array<NonNullable<AppDriveLeaseRuntimeDeps['resolveEmulatorSurface']>> = [
      () => 'other',
      () => 'missing',
      () => {
        throw new Error('surface closed during approval')
      }
    ]
    for (const resolveEmulatorSurface of cases) {
      const { leases, runtime, removeSessionGrant } = harness({ resolveEmulatorSurface })
      expect(authorizeEmulator(runtime)).toMatchObject({ ok: false })
      expect(leases.peek('canvas-emulator-a')).toBeNull()
      expect(removeSessionGrant).not.toHaveBeenCalled()
    }
  })

  it('preserves a real web lease and grant when emulator_step names its canvas id', () => {
    const { leases, runtime, removeSessionGrant } = harness({
      resolveEmulatorSurface: () => 'other'
    })
    leases.authorizeUserLease({
      surfaceId: 'canvas-emulator-a',
      surfaceKind: 'web',
      chatId: 'chat-a',
      runId: 'run-a',
      provider: 'codex',
      approvedBy: 'user',
      allowedVerbs: ['click'],
      target: { canvasId: 'canvas-emulator-a', origin: 'https://example.test' },
      expiresAt: 10_000
    })

    expect(authorizeEmulator(runtime)).toMatchObject({ ok: false })
    expect(leases.peek('canvas-emulator-a')).toMatchObject({
      surfaceKind: 'web',
      status: 'active'
    })
    expect(removeSessionGrant).not.toHaveBeenCalled()
  })

  it('preserves an emulator lease held by another run when a foreign caller names it', () => {
    const { leases, runtime, removeSessionGrant } = harness({
      resolveEmulatorSurface: (_canvasId, context) =>
        context.chatId === 'chat-a' && context.runId === 'run-a' ? 'emulator' : 'missing'
    })
    expect(authorizeEmulator(runtime)).toEqual({ ok: true })

    expect(
      authorizeEmulator(runtime, emulatorDescriptor(runtime), {
        chatId: 'chat-b',
        runId: 'run-b',
        provider: 'claude',
        participantId: 'seat-b'
      })
    ).toMatchObject({ ok: false })
    expect(leases.peek('canvas-emulator-a')).toMatchObject({
      surfaceKind: 'emulator',
      status: 'active',
      chatId: 'chat-a',
      runId: 'run-a',
      provider: 'codex'
    })
    expect(removeSessionGrant).not.toHaveBeenCalled()
  })

  it('revokes only an exact emulator record through its dedicated invalidation helper', () => {
    const { leases, runtime, removeSessionGrant } = harness({
      resolveEmulatorSurface: () => 'emulator'
    })
    expect(authorizeEmulator(runtime)).toEqual({ ok: true })

    const record = {
      schemaVersion: 1 as const,
      id: 'canvas-emulator-a',
      driver: 'emulator' as const,
      url: 'emulator://homebrew-demo',
      title: 'Homebrew',
      viewport: { width: 160, height: 144 },
      status: 'active' as const,
      chatId: 'chat-a',
      runId: 'run-a',
      workspacePath: '/repo',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z'
    }
    const ctx = {
      provider: 'codex' as const,
      chatId: 'chat-a',
      runId: 'run-a',
      workspacePath: '/repo',
      participantId: 'seat-a'
    }
    runtime.invalidateEmulatorSurface({
      canvasId: 'other-canvas',
      record,
      ctx,
      reason: 'human-takeover'
    })
    expect(leases.peek('canvas-emulator-a')).toMatchObject({ status: 'active' })

    runtime.invalidateEmulatorSurface({
      canvasId: 'canvas-emulator-a',
      record,
      ctx: { ...ctx, chatId: 'chat-other' },
      reason: 'human-takeover'
    })
    runtime.invalidateEmulatorSurface({
      canvasId: 'canvas-emulator-a',
      record,
      ctx: { ...ctx, runId: 'run-other' },
      reason: 'human-takeover'
    })
    runtime.invalidateEmulatorSurface({
      canvasId: 'canvas-emulator-a',
      record,
      ctx: { ...ctx, provider: 'claude' },
      reason: 'human-takeover'
    })
    expect(leases.peek('canvas-emulator-a')).toMatchObject({ status: 'active' })
    expect(removeSessionGrant).not.toHaveBeenCalled()

    runtime.invalidateEmulatorSurface({
      canvasId: 'canvas-emulator-a',
      record,
      ctx,
      reason: 'human-takeover'
    })

    expect(leases.peek('canvas-emulator-a')).toMatchObject({
      status: 'revoked',
      revocationReason: 'human-takeover'
    })
    expect(removeSessionGrant).toHaveBeenCalledWith(
      'codex',
      '/repo',
      'canvasInteraction',
      'run-a',
      'canvas-emulator-a'
    )
  })

  it('tears down an exact emulator surface when lifecycle context omits or changes participant', () => {
    for (const participantId of [undefined, 'seat-other']) {
      const { leases, runtime, removeSessionGrant } = harness({
        resolveEmulatorSurface: () => 'emulator'
      })
      expect(authorizeEmulator(runtime)).toEqual({ ok: true })
      runtime.invalidateEmulatorSurface({
        canvasId: 'canvas-emulator-a',
        record: {
          schemaVersion: 1,
          id: 'canvas-emulator-a',
          driver: 'emulator',
          url: 'emulator://homebrew-demo',
          title: 'Homebrew',
          viewport: { width: 160, height: 144 },
          status: 'active',
          chatId: 'chat-a',
          runId: 'run-a',
          workspacePath: '/repo',
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z'
        },
        ctx: {
          provider: 'codex',
          chatId: 'chat-a',
          runId: 'run-a',
          workspacePath: '/repo',
          ...(participantId ? { participantId } : {})
        },
        reason: 'surface-closed'
      })
      expect(leases.peek('canvas-emulator-a')).toMatchObject({
        status: 'revoked',
        revocationReason: 'surface-closed'
      })
      expect(removeSessionGrant).toHaveBeenCalledOnce()
    }
  })

  it('clears an exact stale emulator grant even after its lease is already absent', () => {
    const { runtime, removeSessionGrant } = harness()
    runtime.invalidateEmulatorSurface({
      canvasId: 'canvas-emulator-a',
      record: {
        schemaVersion: 1,
        id: 'canvas-emulator-a',
        driver: 'emulator',
        url: 'emulator://homebrew-demo',
        title: 'Homebrew',
        viewport: { width: 160, height: 144 },
        status: 'active',
        chatId: 'chat-a',
        runId: 'run-a',
        workspacePath: '/repo',
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z'
      },
      ctx: {
        provider: 'codex',
        chatId: 'chat-a',
        runId: 'run-a',
        workspacePath: '/repo'
      },
      reason: 'surface-closed'
    })

    expect(removeSessionGrant).toHaveBeenCalledWith(
      'codex',
      '/repo',
      'canvasInteraction',
      'run-a',
      'canvas-emulator-a'
    )
  })
})
