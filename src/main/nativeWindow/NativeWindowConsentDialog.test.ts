import { describe, expect, it, vi } from 'vitest'

import type {
  NativeWindowCoordinatorCaptureConsentRequest,
  NativeWindowCoordinatorConsentRequest
} from './NativeWindowCoordinator'
import type { CanvasWindowClickAuthorizationRequest } from '../canvas/CanvasWindowDriver'
import {
  requestNativeWindowClickAuthorization,
  requestNativeWindowControlConsent
} from './NativeWindowConsentDialog'

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: vi.fn()
  }
}))

const request: NativeWindowCoordinatorConsentRequest = {
  chatId: 'chat-1',
  runId: 'run-1',
  launchAttemptId: 'attempt-1',
  provider: 'claude',
  applicationName: 'Test App',
  windowTitle: 'Document',
  frameEgress: {
    provider: 'claude',
    mayLeaveDevice: true,
    disclosure: 'Frames may leave this device.'
  },
  allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
  stepBudget: 20,
  expiresInMs: 15 * 60_000
}

const captureRequest: NativeWindowCoordinatorCaptureConsentRequest = {
  kind: 'capture',
  chatId: 'chat-1',
  provider: 'claude',
  applicationName: 'Test App',
  windowTitle: 'Document',
  frameEgress: {
    provider: 'claude',
    mayLeaveDevice: true,
    disclosure: 'Frames may leave this device.'
  }
}

const clickRequest: CanvasWindowClickAuthorizationRequest = {
  scope: {
    chatId: 'chat-1',
    runId: 'run-private',
    attemptId: 'attempt-private',
    consentEpoch: 'private-consent-epoch',
    generation: 7
  },
  observationId: 'private-observation-id',
  inputEpoch: 3,
  ref: 'private-ref',
  semanticSummary: 'AXButton — Send report',
  consequentialHint: true
}

describe('requestNativeWindowControlConsent', () => {
  it.each([
    [0, 'control'],
    [1, 'view'],
    [2, 'cancel'],
    [99, 'cancel']
  ] as const)('maps response %s to %s', async (response, expected) => {
    const showMessageBox = vi.fn().mockResolvedValue({ response, checkboxChecked: false })

    await expect(
      requestNativeWindowControlConsent(null, request, {
        showMessageBox
      })
    ).resolves.toBe(expected)
  })

  it('defaults to view-only and discloses the provider, limits, egress, and secure-field refusal', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false })

    await requestNativeWindowControlConsent(null, request, {
      showMessageBox
    })

    expect(showMessageBox).toHaveBeenCalledOnce()
    const options = showMessageBox.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      buttons: ['View & Control', 'View only', 'Cancel'],
      defaultId: 1,
      cancelId: 2
    })
    expect(options.detail).toContain('Frames may leave this device.')
    expect(options.detail).toContain('20 action steps')
    expect(options.detail).toContain('observe, inspect, click, fill')
    expect(options.detail).toContain('Password and secure fields are refused.')
  })

  it.each([
    [0, 'view'],
    [1, 'cancel'],
    [99, 'cancel']
  ] as const)('maps capture response %s to %s', async (response, expected) => {
    const showMessageBox = vi.fn().mockResolvedValue({ response, checkboxChecked: false })

    await expect(
      requestNativeWindowControlConsent(null, captureRequest, { showMessageBox })
    ).resolves.toBe(expected)
  })

  it('requires an explicit capture decision and discloses chat, provider, and frame egress', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false })

    await requestNativeWindowControlConsent(null, captureRequest, { showMessageBox })

    const options = showMessageBox.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      title: 'Allow Screen Watch?',
      buttons: ['Allow view-only', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    expect(options.detail).toContain('Chat: “chat-1”')
    expect(options.detail).toContain('Frames may leave this device.')
    expect(options.detail).toContain('sensitive UI, pixels, and OCR text')
    expect(options.detail).toContain('does not allow clicks or typing')
    expect(options.detail).toContain('separate prompt')
  })

  it('strips bidi and zero-width controls from consent labels', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false })

    await requestNativeWindowControlConsent(
      null,
      {
        ...captureRequest,
        applicationName: 'Trusted\u202Eapp',
        windowTitle: 'Fin\u200Bal report',
        provider: 'claude\u2066'
      },
      { showMessageBox }
    )

    const options = showMessageBox.mock.calls[0]?.[0]
    expect(options.message).not.toContain('\u202E')
    expect(options.message).not.toContain('\u2066')
    expect(options.detail).not.toContain('\u200B')
  })

  it.each([
    [0, true],
    [1, false],
    [99, false]
  ] as const)(
    'allows one native click only for explicit response %s',
    async (response, expected) => {
      const showMessageBox = vi.fn().mockResolvedValue({ response, checkboxChecked: false })

      await expect(
        requestNativeWindowClickAuthorization(null, clickRequest, { showMessageBox })
      ).resolves.toBe(expected)
    }
  )

  it('defaults and cancels native click confirmation to deny without exposing lease secrets', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false })

    await requestNativeWindowClickAuthorization(
      null,
      {
        ...clickRequest,
        semanticSummary: 'Send\u202E report\u200B now'
      },
      { showMessageBox }
    )

    const options = showMessageBox.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      title: 'Allow one native click?',
      buttons: ['Allow one click', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    expect(options.message).not.toContain('\u202E')
    expect(options.message).not.toContain('\u200B')
    expect(options.detail).toContain('Chat: “chat-1”')
    expect(options.detail).toContain(
      'may complete even if the window is detached immediately afterward'
    )
    for (const secret of [
      'run-private',
      'attempt-private',
      'private-process-receipt',
      'private-instance-epoch',
      'private-consent-epoch',
      'private-observation-id',
      'private-ref'
    ]) {
      expect(JSON.stringify(options)).not.toContain(secret)
    }
  })
})
