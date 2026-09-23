import { describe, expect, it, vi } from 'vitest'
import type { McpToolExecutionResult } from './McpBridgeRuntime'
import { executeComputerUseTool } from './ComputerUseToolExecutor'

function canonical(
  value: Record<string, unknown>,
  image?: { mimeType: string; data: string }
): McpToolExecutionResult {
  const text = JSON.stringify(value)
  return {
    text,
    ...(value.ok === false ? { isError: true } : {}),
    structuredContent: value,
    content: [{ type: 'text', text }, ...(image ? [{ type: 'image' as const, ...image }] : [])]
  }
}

const observation = {
  ok: true,
  tool: 'canvas_snapshot',
  url: 'https://example.test/',
  title: 'Example',
  viewport: { width: 800, height: 600 },
  observationId: 'observation-2',
  inputEpoch: 7,
  root: { ref: 'root', role: 'document' }
}

const frame = {
  ok: true,
  tool: 'canvas_screenshot',
  mimeType: 'image/png',
  width: 800,
  height: 600,
  byteLength: 4,
  hash: 'frame-hash',
  capturedAt: '2026-09-23T20:00:00Z'
}

describe('executeComputerUseTool', () => {
  it('lists canonical sessions and reports actions only where driver support is known', async () => {
    const executeCanonical = vi.fn().mockResolvedValue(
      canonical({
        ok: true,
        tool: 'canvas_list',
        sessions: [
          { canvasId: 'web-1', driver: 'web', status: 'active' },
          { canvasId: 'window-1', driver: 'window', status: 'active' },
          { canvasId: 'image-1', driver: 'image', status: 'active' },
          { canvasId: 'closed-1', driver: 'web', status: 'closed' }
        ]
      })
    )

    const result = await executeComputerUseTool({ action: 'list' }, executeCanonical)

    expect(executeCanonical).toHaveBeenCalledExactlyOnceWith('canvas_list', {})
    const sessions = result.structuredContent?.sessions as Array<Record<string, unknown>>
    expect(sessions[0].availableActions).toContain('navigate')
    expect(sessions[1].availableActions).toEqual(['observe', 'click', 'fill', 'close'])
    expect(sessions[2].availableActions).toEqual(['close'])
    expect(sessions[3].availableActions).toEqual([])
  })

  it('opens a web canvas, observes it, and returns the canonical PNG block and dimensions', async () => {
    const executeCanonical = vi
      .fn()
      .mockResolvedValueOnce(canonical({ ok: true, tool: 'canvas_open', canvasId: 'web-1' }))
      .mockResolvedValueOnce(canonical(observation))
      .mockResolvedValueOnce(
        canonical({ ...frame, width: 1600, height: 1200 }, { mimeType: 'image/png', data: 'UE5H' })
      )

    const result = await executeComputerUseTool(
      { action: 'open', url: 'https://example.test/' },
      executeCanonical
    )

    expect(executeCanonical.mock.calls).toEqual([
      ['canvas_open', { driver: 'web', url: 'https://example.test/', presentation: 'dock' }],
      ['canvas_snapshot', { canvasId: 'web-1' }],
      ['canvas_screenshot', { canvasId: 'web-1' }]
    ])
    expect(result.structuredContent).toMatchObject({
      ok: true,
      action: 'open',
      canvasId: 'web-1',
      observation: { observationId: 'observation-2', inputEpoch: 7 },
      coordinateSpace: {
        actionUnit: 'viewport-css-pixels',
        actionViewport: { width: 800, height: 600 },
        screenshot: { unit: 'png-pixels', width: 1600, height: 1200 }
      },
      screenshotAvailable: true,
      screenshot: { width: 1600, height: 1200, hash: 'frame-hash' }
    })
    expect(result.content?.[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'UE5H' })
  })

  it('opens a launch only through canvas_open_launch and gives native ref guidance', async () => {
    const executeCanonical = vi
      .fn()
      .mockResolvedValueOnce(
        canonical({ ok: true, tool: 'canvas_open_launch', canvasId: 'native-1' })
      )
      .mockResolvedValueOnce(canonical({ ...observation, url: 'window://managed/abc123' }))
      .mockResolvedValueOnce(canonical(frame, { mimeType: 'image/png', data: 'UE5H' }))

    const result = await executeComputerUseTool(
      { action: 'open', launchId: 'attempt-1' },
      executeCanonical
    )

    expect(executeCanonical.mock.calls).toEqual([
      ['canvas_open_launch', { attemptId: 'attempt-1' }],
      ['canvas_snapshot', { canvasId: 'native-1' }],
      ['canvas_screenshot', { canvasId: 'native-1' }]
    ])
    expect(result.structuredContent?.availableActions).toEqual([
      'observe',
      'click',
      'fill',
      'close'
    ])
    expect(result.structuredContent?.surfaceGuidance).toContain('AX refs')
    expect(result.structuredContent?.coordinateSpace).toMatchObject({
      actionUnit: 'ax-ref-only',
      actionViewport: { width: 800, height: 600 },
      screenshot: { unit: 'png-pixels', width: 800, height: 600 }
    })
  })

  it('passes exact native click authority to the canonical route and observes before capture', async () => {
    const actionResult = {
      ok: true,
      tool: 'canvas_click',
      action: 'click',
      executed: true,
      verified: 'unknown',
      driveActionId: 'drive-1'
    }
    const executeCanonical = vi
      .fn()
      .mockResolvedValueOnce(canonical(actionResult))
      .mockResolvedValueOnce(canonical({ ...observation, url: 'window://managed/abc123' }))
      .mockResolvedValueOnce(canonical(frame, { mimeType: 'image/png', data: 'UE5H' }))

    const result = await executeComputerUseTool(
      {
        action: 'click',
        canvasId: 'native-1',
        ref: 'ax-4',
        expectedObservationId: 'observation-1',
        expectedInputEpoch: 6
      },
      executeCanonical
    )

    expect(executeCanonical.mock.calls).toEqual([
      [
        'canvas_click',
        {
          canvasId: 'native-1',
          ref: 'ax-4',
          expectedObservationId: 'observation-1',
          expectedInputEpoch: 6
        }
      ],
      ['canvas_snapshot', { canvasId: 'native-1', driveActionId: 'drive-1' }],
      ['canvas_screenshot', { canvasId: 'native-1' }]
    ])
    expect(result.structuredContent).toMatchObject({
      ok: true,
      actionResult,
      observation: { observationId: 'observation-2' },
      screenshotAvailable: true
    })
  })

  it('maps fill text only into the canonical value argument and does not echo it', async () => {
    const executeCanonical = vi
      .fn()
      .mockResolvedValueOnce(
        canonical({ ok: true, tool: 'canvas_fill', action: 'fill', executed: true })
      )
      .mockResolvedValueOnce(canonical(observation))
      .mockResolvedValueOnce(canonical(frame, { mimeType: 'image/png', data: 'UE5H' }))

    const result = await executeComputerUseTool(
      { action: 'fill', canvasId: 'web-1', ref: 'field-1', text: 'private entry' },
      executeCanonical
    )

    expect(executeCanonical.mock.calls[0]).toEqual([
      'canvas_fill',
      { canvasId: 'web-1', ref: 'field-1', value: 'private entry' }
    ])
    expect(result.text).not.toContain('private entry')
  })

  it('passes the canonical Space key through without trimming it', async () => {
    const executeCanonical = vi
      .fn()
      .mockResolvedValueOnce(canonical({ ok: true, tool: 'canvas_key', executed: true }))
      .mockResolvedValueOnce(canonical(observation))
      .mockResolvedValueOnce(canonical(frame, { mimeType: 'image/png', data: 'UE5H' }))

    const result = await executeComputerUseTool(
      { action: 'key', canvasId: 'web-1', ref: 'button-1', key: ' ' },
      executeCanonical
    )

    expect(executeCanonical.mock.calls[0]).toEqual([
      'canvas_key',
      { canvasId: 'web-1', ref: 'button-1', key: ' ' }
    ])
    expect(result.structuredContent).toMatchObject({ ok: true, screenshotAvailable: true })
  })

  it('stops after a refused action without taking another observation or screenshot', async () => {
    const executeCanonical = vi.fn().mockResolvedValue(
      canonical({
        ok: false,
        tool: 'canvas_click',
        executed: false,
        refusalReason: 'stale_input_epoch'
      })
    )

    const result = await executeComputerUseTool(
      { action: 'click', canvasId: 'web-1', ref: 'button-1' },
      executeCanonical
    )

    expect(executeCanonical).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      stage: 'action',
      actionResult: { refusalReason: 'stale_input_epoch' }
    })
  })

  it('preserves an applied action when its required verification observation fails', async () => {
    const executeCanonical = vi
      .fn()
      .mockResolvedValueOnce(canonical({ ok: true, tool: 'canvas_click', executed: true }))
      .mockResolvedValueOnce(canonical({ ok: false, tool: 'canvas_snapshot', error: 'stale' }))

    const result = await executeComputerUseTool(
      { action: 'click', canvasId: 'web-1', ref: 'button-1' },
      executeCanonical
    )

    expect(executeCanonical).toHaveBeenCalledTimes(2)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      stage: 'observation',
      actionResult: { executed: true },
      observationError: { error: 'stale' }
    })
    expect(result.text).toContain('do not blindly replay')
  })

  it('reports capture refusal as a partial result without losing the successful action and observation', async () => {
    const executeCanonical = vi
      .fn()
      .mockResolvedValueOnce(canonical({ ok: true, tool: 'canvas_click', executed: true }))
      .mockResolvedValueOnce(canonical(observation))
      .mockResolvedValueOnce(
        canonical({ ok: false, tool: 'canvas_screenshot', error: 'capture refused' })
      )

    const result = await executeComputerUseTool(
      { action: 'click', canvasId: 'web-1', ref: 'button-1' },
      executeCanonical
    )

    expect(executeCanonical).toHaveBeenCalledTimes(3)
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({
      ok: true,
      actionResult: { executed: true },
      observation: { observationId: 'observation-2' },
      screenshotAvailable: false,
      screenshotError: { error: 'capture refused' }
    })
    expect(result.content).toHaveLength(1)
    expect(result.text).toContain('Do not replay the action')
  })

  it('closes without follow-up observation or capture', async () => {
    const executeCanonical = vi
      .fn()
      .mockResolvedValue(canonical({ ok: true, tool: 'canvas_close' }))

    const result = await executeComputerUseTool(
      { action: 'close', canvasId: 'web-1' },
      executeCanonical
    )

    expect(executeCanonical).toHaveBeenCalledExactlyOnceWith('canvas_close', {
      canvasId: 'web-1'
    })
    expect(result.structuredContent).toMatchObject({ ok: true, action: 'close' })
  })

  it('routes browser history through canonical navigation before observing and capturing', async () => {
    const executeCanonical = vi
      .fn()
      .mockResolvedValueOnce(
        canonical({
          ok: true,
          tool: 'canvas_navigate',
          canvasId: 'web-1',
          url: 'https://example.test/'
        })
      )
      .mockResolvedValueOnce(canonical(observation))
      .mockResolvedValueOnce(canonical(frame, { mimeType: 'image/png', data: 'UE5H' }))

    const result = await executeComputerUseTool(
      { action: 'navigate', canvasId: 'web-1', navigation: 'back' },
      executeCanonical
    )

    expect(executeCanonical.mock.calls).toEqual([
      ['canvas_navigate', { canvasId: 'web-1', action: 'back' }],
      ['canvas_snapshot', { canvasId: 'web-1' }],
      ['canvas_screenshot', { canvasId: 'web-1' }]
    ])
    expect(result.structuredContent?.screenshotAvailable).toBe(true)
  })

  it('treats a thrown canonical action as indeterminate and does not replay it', async () => {
    const executeCanonical = vi.fn().mockRejectedValue(new Error('cancelled during dispatch'))

    const result = await executeComputerUseTool(
      { action: 'click', canvasId: 'web-1', ref: 'button-1' },
      executeCanonical
    )

    expect(executeCanonical).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ action: 'click', stage: 'action' })
    expect(result.text).toContain('do not blindly replay')
  })

  it('rejects malformed or out-of-scope requests before the canonical route', async () => {
    const executeCanonical = vi.fn()
    for (const input of [
      { action: 'click', canvasId: 'web-1', x: 10 },
      { action: 'scroll', canvasId: 'web-1', deltaY: Number.NaN },
      { action: 'fill', canvasId: 'web-1', selector: '#q', text: 3 },
      { action: 'open', url: 'file:///tmp/private' },
      { action: 'open', url: 'https://example.test/', launchId: 'attempt-1' },
      { action: 'navigate', canvasId: 'web-1', url: 'https://example.test/', navigation: 'back' },
      { action: 'navigate', canvasId: 'web-1', navigation: 'home' },
      { action: 'click', canvasId: 'web-1', ref: 'a', expectedInputEpoch: 1.5 },
      { action: 'observe', canvasId: 'web-1', script: 'alert(1)' }
    ]) {
      const result = await executeComputerUseTool(input, executeCanonical)
      expect(result.isError).toBe(true)
    }
    expect(executeCanonical).not.toHaveBeenCalled()
  })
})
