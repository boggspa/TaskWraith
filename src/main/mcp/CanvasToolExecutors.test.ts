import { describe, it, expect } from 'vitest'
import {
  CANVAS_MCP_TOOL_NAMES,
  createCanvasToolExecutors,
  isCanvasMcpToolName
} from './CanvasToolExecutors'
import type { CanvasController } from '../canvas/canvasTypes'

function fakeController(over: Partial<CanvasController> = {}): CanvasController {
  return {
    open: async (input) => ({
      canvasId: 'c1',
      url: input.url || '',
      title: 'T',
      viewport: { width: 1280, height: 800 }
    }),
    list: () => [],
    status: () => null,
    snapshot: async () => ({
      url: 'u',
      title: 'T',
      viewport: { width: 1, height: 1 },
      capturedAt: 'x',
      root: { ref: 'e1', role: 'document', tag: 'body' },
      nodeCount: 1,
      truncated: false
    }),
    screenshot: async () => ({
      mimeType: 'image/png',
      data: 'BASE64PNG',
      width: 1,
      height: 1,
      byteLength: 1,
      hash: 'h',
      capturedAt: 'x'
    }),
    inspect: async (_id, args) => ({
      found: true,
      tag: 'div',
      role: 'generic',
      ref: args.ref,
      selector: args.selector
    }),
    network: async () => [],
    console: async () => [],
    resize: async (_id, viewport) => viewport,
    click: async (_id, args) => ({
      ok: true,
      action: 'click',
      found: true,
      ref: args.ref,
      selector: args.selector
    }),
    fill: async (_id, args) => ({
      ok: true,
      action: 'fill',
      found: true,
      ref: args.ref,
      selector: args.selector
    }),
    annotate: async (_id, marks) => ({
      schemaVersion: 1,
      id: 'ann1',
      canvasId: 'c1',
      marks,
      author: 'agent',
      createdAt: 'x'
    }),
    evaluate: async (_id, args) => ({
      ok: true,
      valueType: 'string',
      value: `evaluated:${args.script}`,
      truncated: false
    }),
    reload: async () => {},
    close: async () => {},
    ...over
  }
}

const ctx = { appChatId: 'chat1', appRunId: 'run1', workspacePath: '/ws' }

describe('isCanvasMcpToolName', () => {
  it('matches the canvas tools and nothing else', () => {
    for (const name of CANVAS_MCP_TOOL_NAMES) expect(isCanvasMcpToolName(name)).toBe(true)
    expect(isCanvasMcpToolName('browser_open')).toBe(false)
    // P2: canvas_eval is now a first-class (signed-elevated) canvas tool.
    expect(isCanvasMcpToolName('canvas_eval')).toBe(true)
  })
})

describe('executeCanvasTool', () => {
  it('canvas_open returns a canvasId', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const result = await executeCanvasTool('canvas_open', { url: 'http://localhost:3000' }, ctx, 'claude')
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.canvasId).toBe('c1')
  })

  it('canvas_open requires a url', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const result = await executeCanvasTool('canvas_open', {}, ctx, 'claude')
    expect(result.isError).toBe(true)
  })

  it('canvas_open device driver requires a bundleId and routes device inputs', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return {
          canvasId: 'cd',
          url: `device://booted/${input.bundleId}`,
          title: input.bundleId || '',
          viewport: { width: 0, height: 0 }
        }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    // No bundleId → error, no url required for device.
    expect((await executeCanvasTool('canvas_open', { driver: 'device' }, ctx, 'claude')).isError).toBe(
      true
    )
    const r = await executeCanvasTool(
      'canvas_open',
      {
        driver: 'device',
        bundleId: 'com.example.App',
        appPath: '/Users/me/Build/Example.app',
        udid: 'AAAAAAAA-1111-2222-3333-444444444444'
      },
      ctx,
      'claude'
    )
    expect(r.isError).toBeFalsy()
    expect(seen).toEqual({
      driver: 'device',
      bundleId: 'com.example.App',
      appPath: '/Users/me/Build/Example.app',
      device: { udid: 'AAAAAAAA-1111-2222-3333-444444444444' },
      viewport: { width: 1280, height: 800 }
    })
  })

  it('canvas_screenshot returns an image block and keeps base64 out of structuredContent', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const result = await executeCanvasTool('canvas_screenshot', { canvasId: 'c1' }, ctx, 'claude')
    const image = result.content?.find(
      (block): block is { type: 'image'; mimeType: string; data: string } => block.type === 'image'
    )
    expect(image?.data).toBe('BASE64PNG')
    expect(JSON.stringify(result.structuredContent)).not.toContain('BASE64PNG')
  })

  it('read tools require a canvasId', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const result = await executeCanvasTool('canvas_snapshot', {}, ctx, 'claude')
    expect(result.isError).toBe(true)
  })

  it('canvas_inspect requires a ref or selector', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const result = await executeCanvasTool('canvas_inspect', { canvasId: 'c1' }, ctx, 'claude')
    expect(result.isError).toBe(true)
  })

  it('canvas_click requires a target (ref / selector / x+y)', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const r = await executeCanvasTool('canvas_click', { canvasId: 'c1' }, ctx, 'claude')
    expect(r.isError).toBe(true)
  })

  it('canvas_click by ref succeeds', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const r = await executeCanvasTool('canvas_click', { canvasId: 'c1', ref: 'e5' }, ctx, 'claude')
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent?.action).toBe('click')
  })

  it('canvas_fill requires a value', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const r = await executeCanvasTool('canvas_fill', { canvasId: 'c1', ref: 'e5' }, ctx, 'claude')
    expect(r.isError).toBe(true)
  })

  it('canvas_annotate drops untargeted marks and requires at least one', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    expect((await executeCanvasTool('canvas_annotate', { canvasId: 'c1', marks: [] }, ctx, 'claude')).isError).toBe(true)
    // a mark with a label but no ref/bbox is dropped → request becomes empty
    expect(
      (await executeCanvasTool('canvas_annotate', { canvasId: 'c1', marks: [{ label: 'x' }] }, ctx, 'claude')).isError
    ).toBe(true)
    const ok = await executeCanvasTool(
      'canvas_annotate',
      { canvasId: 'c1', marks: [{ ref: 'e1', label: 'misaligned', severity: 'warn' }] },
      ctx,
      'claude'
    )
    expect(ok.isError).toBeFalsy()
    expect(ok.structuredContent?.annotationId).toBe('ann1')
  })

  it('canvas_eval requires a non-empty script', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    expect((await executeCanvasTool('canvas_eval', { canvasId: 'c1' }, ctx, 'claude')).isError).toBe(
      true
    )
    expect(
      (await executeCanvasTool('canvas_eval', { canvasId: 'c1', script: '   ' }, ctx, 'claude'))
        .isError
    ).toBe(true)
  })

  it('canvas_eval rejects an oversized script before it reaches the page', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const huge = 'a'.repeat(100001)
    const r = await executeCanvasTool('canvas_eval', { canvasId: 'c1', script: huge }, ctx, 'claude')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('too large')
  })

  it('canvas_eval runs the script and returns its result', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const r = await executeCanvasTool(
      'canvas_eval',
      { canvasId: 'c1', script: '1 + 1' },
      ctx,
      'claude'
    )
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent?.ok).toBe(true)
    expect(r.structuredContent?.value).toBe('evaluated:1 + 1')
  })

  it('surfaces controller errors as isError', async () => {
    const controller = fakeController({
      snapshot: async () => {
        throw new Error('kaboom')
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const result = await executeCanvasTool('canvas_snapshot', { canvasId: 'c1' }, ctx, 'claude')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('kaboom')
  })

  it('threads provider/chat/run context to the controller', async () => {
    let seen: unknown = null
    const controller = fakeController({
      snapshot: async (_id, callCtx) => {
        seen = callCtx
        return {
          url: 'u',
          title: 'T',
          viewport: { width: 1, height: 1 },
          capturedAt: 'x',
          root: { ref: 'e1', role: 'document', tag: 'body' },
          nodeCount: 1,
          truncated: false
        }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    await executeCanvasTool('canvas_snapshot', { canvasId: 'c1' }, ctx, 'grok')
    expect(seen).toEqual({ provider: 'grok', chatId: 'chat1', runId: 'run1', workspacePath: '/ws' })
  })
})
