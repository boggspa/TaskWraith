import { describe, it, expect } from 'vitest'
import {
  CANVAS_MCP_TOOL_NAMES,
  createCanvasToolExecutors,
  isCanvasMcpToolName
} from './CanvasToolExecutors'
import type { CanvasController, CanvasSketchDocument } from '../canvas/canvasTypes'
import { CANVAS_EVAL_SCRIPT_CAP } from '../canvas/canvasTypes'
import { createCanvasEvalApprovalReceipt } from '../canvas/CanvasEvalAudit'
import type { LaunchAttempt } from '../launch/types'

function fakeController(over: Partial<CanvasController> = {}): CanvasController {
  const sketchDoc: CanvasSketchDocument = {
    schemaVersion: 1,
    title: 'Sketch Canvas',
    viewport: { width: 1280, height: 800 },
    elements: [],
    updatedAt: 'x'
  }
  return {
    open: async (input) => ({
      canvasId: 'c1',
      url: input.driver === 'sketch' ? 'sketch://c1' : input.url || '',
      title: input.driver === 'sketch' ? 'Sketch Canvas' : 'T',
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
      executed: true,
      verified: 'changed',
      ref: args.ref,
      selector: args.selector
    }),
    fill: async (_id, args) => ({
      ok: true,
      action: 'fill',
      found: true,
      executed: true,
      verified: 'changed',
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
    sketchDocument: async () => sketchDoc,
    sketchUpdate: async (_id, update) => ({
      ...sketchDoc,
      title: update.title || sketchDoc.title,
      elements:
        update.mode === 'replace'
          ? update.elements || []
          : update.mode === 'clear'
            ? []
            : [...sketchDoc.elements, ...(update.elements || [])],
      updatedAt: 'x2'
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

function fakeLaunchAttempt(over: Partial<LaunchAttempt> = {}): LaunchAttempt {
  return {
    schemaVersion: 1,
    id: 'att1',
    targetId: 'npm-dev',
    targetLabel: 'npm dev',
    targetSource: 'package-json',
    targetKind: 'dev-server',
    targetSnapshot: {} as LaunchAttempt['targetSnapshot'],
    targetSnapshotHash: 'h',
    provider: 'codex',
    workspacePath: '/ws',
    cwd: '/ws',
    commandRaw: 'npm run dev',
    argv: ['npm', 'run', 'dev'],
    status: 'running',
    startedAt: 'T0',
    updatedAt: 'T1',
    outputTail: 'ready on http://localhost:5173\n',
    outputTailBytes: 31,
    outputTruncated: false,
    detectedUrls: ['http://localhost:5173/'],
    chatId: 'chat1',
    runId: 'run1',
    ...over
  } as LaunchAttempt
}

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

  it('raw canvas_open explicitly refuses a window driver and never forwards opaque target fields', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return {
          canvasId: 'c1',
          url: input.url || '',
          title: 'Web',
          viewport: { width: 1280, height: 800 }
        }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const result = await executeCanvasTool(
      'canvas_open',
      {
        driver: 'window',
        url: 'http://localhost:3000',
        windowTarget: { leaseId: 'agent-supplied' },
        leaseId: 'agent-supplied'
      },
      ctx,
      'claude'
    )

    expect(result.isError).toBe(true)
    expect(String(result.structuredContent?.error)).toMatch(
      /native window driver.*canvas_open_launch/i
    )
    expect(seen).toBeNull()
    expect(JSON.stringify(seen)).not.toContain('agent-supplied')
  })

  it('canvas_render_html opens an html-driver canvas and returns the first frame', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return { canvasId: 'c1', url: input.html ? 'html://abc' : '', title: 'Rendered HTML', viewport: { width: 800, height: 600 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const result = await executeCanvasTool(
      'canvas_render_html',
      { html: '<h1>Hi</h1>', width: 800, height: 600 },
      ctx,
      'claude'
    )
    expect(result.isError).toBeFalsy()
    expect(seen).toMatchObject({ driver: 'html', html: '<h1>Hi</h1>' })
    expect(result.structuredContent?.canvasId).toBe('c1')
    expect(result.structuredContent?.url).toBe('html://abc')
    // The first screenshot rides back as an image content block.
    expect(result.content?.some((b) => b.type === 'image')).toBe(true)
  })

  it('canvas_render_html rejects empty html before opening', async () => {
    let opened = false
    const controller = fakeController({
      open: async () => {
        opened = true
        return { canvasId: 'c1', url: '', title: 'T', viewport: { width: 1, height: 1 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const result = await executeCanvasTool('canvas_render_html', { html: '   ' }, ctx, 'claude')
    expect(result.isError).toBe(true)
    expect(opened).toBe(false)
  })

  it('canvas_open_attachment opens an image-driver canvas and returns the image', async () => {
    const sha = 'b'.repeat(43)
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return { canvasId: 'c1', url: `image://${sha}`, title: 'image/png', viewport: { width: 4, height: 4 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const result = await executeCanvasTool(
      'canvas_open_attachment',
      { sha256: sha, mimeType: 'image/png' },
      ctx,
      'claude'
    )
    expect(result.isError).toBeFalsy()
    expect(seen).toMatchObject({ driver: 'image', mediaSha256: sha, mediaMimeType: 'image/png' })
    expect(result.structuredContent?.url).toBe(`image://${sha}`)
    expect(result.content?.some((b) => b.type === 'image')).toBe(true)
  })

  it('canvas_open_attachment rejects a non-image mime and a bad hash before opening', async () => {
    let opened = false
    const controller = fakeController({
      open: async () => {
        opened = true
        return { canvasId: 'c1', url: '', title: 'T', viewport: { width: 1, height: 1 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const av = await executeCanvasTool(
      'canvas_open_attachment',
      { sha256: 'c'.repeat(43), mimeType: 'video/mp4' },
      ctx,
      'claude'
    )
    expect(av.isError).toBe(true)
    const badHash = await executeCanvasTool(
      'canvas_open_attachment',
      { sha256: '../secret', mimeType: 'image/png' },
      ctx,
      'claude'
    )
    expect(badHash.isError).toBe(true)
    expect(opened).toBe(false)
  })

  it('canvas_open_launch opens this chat\'s running detected URL with the web driver', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return {
          canvasId: 'cw',
          url: input.url || '',
          title: 'Dev app',
          viewport: { width: 390, height: 844 }
        }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt()]
    })
    const result = await executeCanvasTool(
      'canvas_open_launch',
      { attemptId: 'att1', width: 390, height: 844 },
      ctx,
      'claude'
    )
    expect(result.isError).toBeFalsy()
    expect(seen).toMatchObject({ driver: 'web', url: 'http://localhost:5173/' })
    expect(result.structuredContent?.source).toBe('detectedUrl')
    expect(result.structuredContent?.canvasId).toBe('cw')
  })

  it('canvas_open_launch opens an exact native target through the opaque window route', async () => {
    let seen: unknown = null
    let resolved: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return {
          canvasId: 'cnative',
          url: 'window://managed/safe',
          title: 'Native App',
          viewport: { width: 900, height: 700 }
        }
      }
    })
    const attempt = fakeLaunchAttempt({
      detectedUrls: [],
      targetSnapshot: { platform: 'macos' } as LaunchAttempt['targetSnapshot']
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [attempt],
      resolveWindowOpenTarget: async (candidate, context) => {
        resolved = { candidate, context }
        return {
          ok: true,
          target: { leaseId: 'lease-native-1', windowHandleId: 'must-not-forward' } as never
        }
      }
    })

    const result = await executeCanvasTool(
      'canvas_open_launch',
      { attemptId: 'att1', width: 900, height: 700 },
      ctx,
      'claude'
    )

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent?.source).toBe('attachedWindow')
    expect(seen).toEqual({
      driver: 'window',
      windowTarget: { leaseId: 'lease-native-1' },
      viewport: { width: 900, height: 700 }
    })
    expect(JSON.stringify(seen)).not.toContain('must-not-forward')
    expect(resolved).toEqual({
      candidate: attempt,
      context: {
        appChatId: 'chat1',
        appRunId: 'run1',
        workspacePath: '/ws',
        parentProvider: 'claude'
      }
    })
  })

  it('canvas_open_launch gives Screen Watch guidance for a live native launch without a target', async () => {
    let opened = false
    const controller = fakeController({
      open: async () => {
        opened = true
        return { canvasId: 'c1', url: '', title: 'T', viewport: { width: 1, height: 1 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [
        fakeLaunchAttempt({
          detectedUrls: [],
          targetSnapshot: { platform: 'macos' } as LaunchAttempt['targetSnapshot']
        })
      ],
      resolveWindowOpenTarget: async () => ({
        ok: false,
        reason: 'attachment-required'
      })
    })

    const result = await executeCanvasTool(
      'canvas_open_launch',
      { attemptId: 'att1' },
      ctx,
      'claude'
    )

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      reason: 'attachment-required',
      attemptId: 'att1'
    })
    expect(String(result.structuredContent?.guidance)).toMatch(/Screen Watch.*View & Control/)
    expect(opened).toBe(false)
  })

  it('canvas_open_launch denies a same-chat attempt from another run before resolving', async () => {
    let opened = false
    let resolved = false
    const controller = fakeController({
      open: async () => {
        opened = true
        return { canvasId: 'c1', url: '', title: 'T', viewport: { width: 1, height: 1 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt({ runId: 'run-other' })],
      resolveWindowOpenTarget: async () => {
        resolved = true
        return { ok: true, target: { leaseId: 'must-not-resolve' } }
      }
    })

    const result = await executeCanvasTool(
      'canvas_open_launch',
      { attemptId: 'att1' },
      ctx,
      'claude'
    )

    expect(result.isError).toBe(true)
    expect(String(result.structuredContent?.error)).toMatch(/not found/)
    expect(resolved).toBe(false)
    expect(opened).toBe(false)
  })

  it('canvas_open_launch requires an attemptId', async () => {
    let opened = false
    const controller = fakeController({
      open: async () => {
        opened = true
        return { canvasId: 'c1', url: '', title: 'T', viewport: { width: 1, height: 1 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt()]
    })
    const result = await executeCanvasTool('canvas_open_launch', {}, ctx, 'claude')
    expect(result.isError).toBe(true)
    expect(opened).toBe(false)
  })

  it('canvas_open_launch renders owned build output as escaped static html', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return { canvasId: 'clog', url: 'html://log', title: 'Build output', viewport: { width: 800, height: 600 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [
        fakeLaunchAttempt({
          id: 'build1',
          targetLabel: 'swift build',
          targetKind: 'build',
          status: 'failed',
          detectedUrls: [],
          outputTail: '<script>alert(1)</script>\nerror\n'
        })
      ]
    })
    const result = await executeCanvasTool('canvas_open_launch', { attemptId: 'build1' }, ctx, 'claude')
    expect(result.isError).toBeFalsy()
    expect(seen).toMatchObject({ driver: 'html' })
    expect(String((seen as { html: string }).html)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(result.structuredContent?.source).toBe('outputTail')
    expect(result.content?.some((b) => b.type === 'image')).toBe(true)
  })

  it('canvas_open_launch falls back to output for terminal attempts even with a detected URL', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return { canvasId: 'clog', url: 'html://log', title: 'Build output', viewport: { width: 800, height: 600 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt({ status: 'stopped', detectedUrls: ['http://localhost:5173/'] })]
    })
    const result = await executeCanvasTool('canvas_open_launch', { attemptId: 'att1' }, ctx, 'claude')
    expect(result.isError).toBeFalsy()
    expect(seen).toMatchObject({ driver: 'html' })
    expect(result.structuredContent?.source).toBe('outputTail')
  })

  it('canvas_open_launch ignores non-loopback detected URLs and falls back to output', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return { canvasId: 'clog', url: 'html://log', title: 'Build output', viewport: { width: 800, height: 600 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt({ detectedUrls: ['https://example.com/'] })],
      resolveWindowOpenTarget: async () => ({
        ok: false,
        reason: 'not-native-macos-launch'
      })
    })
    const result = await executeCanvasTool('canvas_open_launch', { attemptId: 'att1' }, ctx, 'claude')
    expect(result.isError).toBeFalsy()
    expect(seen).toMatchObject({ driver: 'html' })
    expect(result.structuredContent?.source).toBe('outputTail')
  })

  it('canvas_open_launch does not expose attempts without exact run ownership', async () => {
    let opened = false
    const controller = fakeController({
      open: async () => {
        opened = true
        return { canvasId: 'c1', url: '', title: 'T', viewport: { width: 1, height: 1 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt({ runId: undefined, detectedUrls: [], outputTail: 'SECRET=1\n' })]
    })
    const result = await executeCanvasTool('canvas_open_launch', { attemptId: 'att1' }, ctx, 'claude')
    expect(result.isError).toBe(true)
    expect(String(result.structuredContent?.error)).toMatch(/not found/)
    expect(JSON.stringify(result.structuredContent)).not.toContain('SECRET')
    expect(opened).toBe(false)
  })

  it('canvas_open_launch denies an unowned live URL attempt without a runId', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return { canvasId: 'cw', url: input.url || '', title: 'Dev app', viewport: { width: 1280, height: 800 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt({ runId: undefined, detectedUrls: ['http://localhost:5173/'] })]
    })
    const result = await executeCanvasTool('canvas_open_launch', { attemptId: 'att1' }, ctx, 'claude')
    expect(result.isError).toBe(true)
    expect(seen).toBeNull()
    expect(String(result.structuredContent?.error)).toMatch(/not found/)
  })

  it('canvas_open_launch refuses another chat\'s attemptId without opening', async () => {
    let opened = false
    const controller = fakeController({
      open: async () => {
        opened = true
        return { canvasId: 'c1', url: '', title: 'T', viewport: { width: 1, height: 1 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt({ id: 'other', chatId: 'chat2' })]
    })
    const result = await executeCanvasTool('canvas_open_launch', { attemptId: 'other' }, ctx, 'claude')
    expect(result.isError).toBe(true)
    expect(String(result.structuredContent?.error)).toMatch(/not found/)
    expect(opened).toBe(false)
  })

  it('canvas_open_launch does not expose unattributed attempts to no-chat runs', async () => {
    let opened = false
    const controller = fakeController({
      open: async () => {
        opened = true
        return { canvasId: 'c1', url: '', title: 'T', viewport: { width: 1, height: 1 } }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({
      controller,
      launchAttempts: () => [fakeLaunchAttempt({ id: 'legacy', chatId: undefined })]
    })
    const result = await executeCanvasTool(
      'canvas_open_launch',
      { attemptId: 'legacy' },
      { appRunId: 'run1', workspacePath: '/ws' },
      'claude'
    )
    expect(result.isError).toBe(true)
    expect(opened).toBe(false)
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

  it('canvas_sketch_open opens a sketch-driver canvas and returns the document', async () => {
    let seen: unknown = null
    const controller = fakeController({
      open: async (input) => {
        seen = input
        return {
          canvasId: 'sk1',
          url: 'sketch://sk1',
          title: 'Sketch Canvas',
          viewport: { width: 900, height: 700 }
        }
      },
      sketchDocument: async () => ({
        schemaVersion: 1,
        title: 'Sketch Canvas',
        viewport: { width: 900, height: 700 },
        elements: [],
        updatedAt: 'x'
      })
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const result = await executeCanvasTool(
      'canvas_sketch_open',
      { width: 900, height: 700 },
      ctx,
      'claude'
    )
    expect(result.isError).toBeFalsy()
    expect(seen).toMatchObject({ driver: 'sketch', viewport: { width: 900, height: 700 } })
    expect(result.structuredContent?.canvasId).toBe('sk1')
    expect(result.structuredContent?.document).toMatchObject({ title: 'Sketch Canvas' })
  })

  it('canvas_sketch_update routes structured primitives and rejects empty edits', async () => {
    let seen: unknown = null
    const controller = fakeController({
      sketchUpdate: async (_id, update) => {
        seen = update
        return {
          schemaVersion: 1,
          title: 'Flow',
          viewport: { width: 1280, height: 800 },
          elements: update.elements || [],
          updatedAt: 'x'
        }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const empty = await executeCanvasTool('canvas_sketch_update', { canvasId: 'c1' }, ctx, 'claude')
    expect(empty.isError).toBe(true)
    const result = await executeCanvasTool(
      'canvas_sketch_update',
      {
        canvasId: 'c1',
        title: 'Flow',
        elements: [{ kind: 'arrow', id: 'a1', x1: 10, y1: 20, x2: 200, y2: 80 }]
      },
      ctx,
      'claude'
    )
    expect(result.isError).toBeFalsy()
    expect(seen).toEqual({
      mode: 'append',
      title: 'Flow',
      elements: [{ kind: 'arrow', id: 'a1', x1: 10, y1: 20, x2: 200, y2: 80 }]
    })
    expect(result.structuredContent?.elementCount).toBe(1)
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

  it('plumbs expectedObservationId through inspect, click, and fill', async () => {
    const seen: Record<string, unknown> = {}
    const controller = fakeController({
      inspect: async (_id, args) => {
        seen.inspect = args
        return { found: true, ref: args.ref }
      },
      click: async (_id, args) => {
        seen.click = args
        return {
          ok: true,
          action: 'click',
          found: true,
          executed: true,
          verified: 'changed'
        }
      },
      fill: async (_id, args) => {
        seen.fill = args
        return {
          ok: true,
          action: 'fill',
          found: true,
          executed: true,
          verified: 'changed'
        }
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })

    await executeCanvasTool(
      'canvas_inspect',
      { canvasId: 'c1', ref: 'ax1', expectedObservationId: 'observation-7' },
      ctx,
      'claude'
    )
    await executeCanvasTool(
      'canvas_click',
      {
        canvasId: 'c1',
        ref: 'ax1',
        expectedObservationId: 'observation-7',
        expectedInputEpoch: 4
      },
      ctx,
      'claude'
    )
    await executeCanvasTool(
      'canvas_fill',
      {
        canvasId: 'c1',
        ref: 'ax2',
        value: 'private',
        expectedObservationId: 'observation-7',
        expectedInputEpoch: 4
      },
      ctx,
      'claude'
    )

    expect(seen.inspect).toMatchObject({ expectedObservationId: 'observation-7' })
    expect(seen.click).toMatchObject({
      expectedObservationId: 'observation-7',
      expectedInputEpoch: 4
    })
    expect(seen.fill).toMatchObject({
      expectedObservationId: 'observation-7',
      expectedInputEpoch: 4
    })
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
    const huge = 'a'.repeat(CANVAS_EVAL_SCRIPT_CAP + 1)
    const r = await executeCanvasTool('canvas_eval', { canvasId: 'c1', script: huge }, ctx, 'claude')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('too large')
    expect(r.text).toContain(`max ${CANVAS_EVAL_SCRIPT_CAP} chars`)
  })

  it('canvas_eval runs the script and returns its result', async () => {
    const { executeCanvasTool } = createCanvasToolExecutors({ controller: fakeController() })
    const r = await executeCanvasTool(
      'canvas_eval',
      { canvasId: 'c1', script: '1 + 1' },
      {
        ...ctx,
        canvasEvalApproval: createCanvasEvalApprovalReceipt('1 + 1', 'approval-1')
      },
      'claude'
    )
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent?.ok).toBe(true)
    expect(r.structuredContent?.value).toBe('evaluated:1 + 1')
  })

  it('canvas_eval fails closed without a per-call approval receipt', async () => {
    const controller = fakeController()
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const r = await executeCanvasTool(
      'canvas_eval',
      { canvasId: 'c1', script: '1 + 1' },
      ctx,
      'claude'
    )
    expect(r.isError).toBe(true)
    expect(r.text).toContain('bound per-call approval receipt')
  })

  it('classifies a host-side canvas_eval failure without returning raw error text', async () => {
    const script = '1 + 1'
    const controller = fakeController({
      evaluate: async () => {
        throw new Error('E'.repeat(20_000))
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const r = await executeCanvasTool(
      'canvas_eval',
      { canvasId: 'c1', script },
      {
        ...ctx,
        canvasEvalApproval: createCanvasEvalApprovalReceipt(script, 'approval-error-cap')
      },
      'claude'
    )

    expect(r.isError).toBe(true)
    expect(r.structuredContent?.error).toBe('Canvas operation failed (operation_failed).')
    expect(r.text).not.toContain('x'.repeat(100))
  })

  it('surfaces controller errors as classified isError results', async () => {
    const controller = fakeController({
      snapshot: async () => {
        throw new Error('kaboom')
      }
    })
    const { executeCanvasTool } = createCanvasToolExecutors({ controller })
    const result = await executeCanvasTool('canvas_snapshot', { canvasId: 'c1' }, ctx, 'claude')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Canvas operation failed (operation_failed).')
    expect(result.text).not.toContain('kaboom')
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
