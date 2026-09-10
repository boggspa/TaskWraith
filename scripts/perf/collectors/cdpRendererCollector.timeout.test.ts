import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { collectRendererHeapSnapshot } = require('./cdpRendererCollector.cjs')

describe('collectRendererHeapSnapshot timeouts', () => {
  it('rejects when takeHeapSnapshot never settles', async () => {
    const session = {
      send: async (method: string) => {
        if (method === 'HeapProfiler.enable') return {}
        if (method === 'HeapProfiler.disable') return {}
        return new Promise(() => undefined)
      },
      onEvent: () => () => undefined
    }
    await expect(
      collectRendererHeapSnapshot(session, { timeoutMs: 20, disableTimeoutMs: 20 })
    ).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
  })

  it('returns after chunks if HeapProfiler.disable hangs (attempt-3 shape)', async () => {
    /** @type {Set<(msg: object) => void>} */
    const handlers = new Set()
    const session = {
      send: async (method: string) => {
        if (method === 'HeapProfiler.takeHeapSnapshot') {
          for (const handler of handlers) {
            handler({
              method: 'HeapProfiler.addHeapSnapshotChunk',
              params: { chunk: 'HEAPDATA'.repeat(40) }
            })
          }
          return {}
        }
        if (method === 'HeapProfiler.disable') return new Promise(() => undefined)
        return {}
      },
      onEvent: (handler: (msg: object) => void) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      }
    }
    const heap = await collectRendererHeapSnapshot(session, {
      timeoutMs: 200,
      disableTimeoutMs: 20
    })
    expect(heap.streamed).toBe(true)
    expect(heap.bytes).toBeGreaterThan(0)
  })
})
