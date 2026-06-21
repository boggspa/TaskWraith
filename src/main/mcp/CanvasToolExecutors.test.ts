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
    close: async () => {},
    ...over
  }
}

const ctx = { appChatId: 'chat1', appRunId: 'run1', workspacePath: '/ws' }

describe('isCanvasMcpToolName', () => {
  it('matches the canvas tools and nothing else', () => {
    for (const name of CANVAS_MCP_TOOL_NAMES) expect(isCanvasMcpToolName(name)).toBe(true)
    expect(isCanvasMcpToolName('browser_open')).toBe(false)
    // eval is deferred to P2 — must NOT be a canvas tool name yet
    expect(isCanvasMcpToolName('canvas_eval')).toBe(false)
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
