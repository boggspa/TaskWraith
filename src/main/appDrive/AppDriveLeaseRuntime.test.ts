import { describe, expect, it, vi } from 'vitest'
import { AppDriveLeaseRegistry } from './AppDriveLease'
import { AppDriveLeaseRuntime } from './AppDriveLeaseRuntime'

function harness() {
  const leases = new AppDriveLeaseRegistry({ now: () => 1_000 })
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
    hasSessionGrant: vi.fn(() => false),
    removeSessionGrant: vi.fn(() => true),
    webOrigin: () => 'https://example.test'
  })
  return { leases, runtime }
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
  })

  it('enriches a web lease with its current origin after user approval', () => {
    const { leases, runtime } = harness()
    const descriptor = runtime.prepareApproval(
      'canvas_click',
      { canvasId: 'canvas-a' },
      'chat-a',
      {}
    )!
    expect(
      runtime.authorize({
        descriptor,
        provider: 'codex',
        service: 'canvasInteraction',
        workspacePath: '/repo',
        chatId: 'chat-a',
        runId: 'run-a',
        approval: { action: 'accept', decisionSource: 'user' },
        oneOffPermissionRetry: false
      })
    ).toEqual({ ok: true })
    expect(leases.peek('canvas-a')?.target.origin).toBe('https://example.test')
  })
})
