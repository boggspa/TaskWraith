import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { protocol } from 'electron'
import {
  TranscriptMediaAssetStore,
  transcriptMediaAssetPath
} from '../services/TranscriptMediaAssetStore'
import { registerTwMediaProtocol } from './TwMediaProtocol'

vi.mock('electron', () => ({
  protocol: {
    handle: vi.fn()
  }
}))

const VALID_SHA = 'protocolHash_abcdefghijklmnopqrstuvwxyz0123456789'
const roots: string[] = []

type ProtocolHandler = (request: Request) => Promise<Response>

function registeredHandler(): ProtocolHandler {
  const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as ProtocolHandler | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error('twmedia protocol handler was not registered')
  return handler
}

function makeStore(): { root: string; store: TranscriptMediaAssetStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-protocol-'))
  roots.push(root)
  return { root, store: new TranscriptMediaAssetStore(root) }
}

beforeEach(() => {
  vi.mocked(protocol.handle).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('registerTwMediaProtocol', () => {
  it('preserves bounded HTTP range semantics for buffered responses', async () => {
    const { root, store } = makeStore()
    const body = Buffer.from('0123456789')
    expect(store.write({ sha256: VALID_SHA, mimeType: 'video/mp4', buffer: body })).toEqual({
      ok: true
    })
    registerTwMediaProtocol(root)

    const response = await registeredHandler()(
      new Request(`twmedia://asset/${VALID_SHA}.mp4`, {
        headers: { Range: 'bytes=2-6' }
      })
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 2-6/10')
    expect(response.headers.get('Content-Length')).toBe('5')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('23456')
  })

  it('closes the verified descriptor for HEAD and unsatisfiable requests', async () => {
    const { root, store } = makeStore()
    expect(
      store.write({ sha256: VALID_SHA, mimeType: 'audio/wav', buffer: Buffer.from('wave') })
    ).toEqual({ ok: true })
    const closeSpy = vi.spyOn(fs, 'closeSync')
    registerTwMediaProtocol(root)
    const handler = registeredHandler()

    const head = await handler(new Request(`twmedia://asset/${VALID_SHA}.wav`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe('4')
    const closesAfterHead = closeSpy.mock.calls.length
    expect(closesAfterHead).toBeGreaterThan(0)

    const unsatisfiable = await handler(
      new Request(`twmedia://asset/${VALID_SHA}.wav`, {
        headers: { Range: 'bytes=999-' }
      })
    )
    expect(unsatisfiable.status).toBe(416)
    expect(closeSpy.mock.calls.length).toBeGreaterThan(closesAfterHead)
  })

  it('streams large AV from the verified fd even if its pathname is replaced', async () => {
    const { root, store } = makeStore()
    const size = 8 * 1024 * 1024 + 1
    const originalBody = Buffer.alloc(size, 0x41)
    expect(store.write({ sha256: VALID_SHA, mimeType: 'video/mp4', buffer: originalBody })).toEqual({
      ok: true
    })
    const assetPath = transcriptMediaAssetPath(fs.realpathSync.native(root), VALID_SHA, 'video/mp4')
    const originalCreateReadStream = fs.createReadStream
    let sawDescriptor = false
    const streamSpy = vi.spyOn(fs, 'createReadStream').mockImplementation(((filePath, options) => {
      if (!sawDescriptor && String(filePath) === assetPath) {
        sawDescriptor =
          Boolean(options && typeof options === 'object') &&
          typeof (options as { fd?: unknown }).fd === 'number'
        fs.renameSync(assetPath, `${assetPath}.opened`)
        fs.writeFileSync(assetPath, Buffer.alloc(size, 0x42), { mode: 0o600 })
      }
      return originalCreateReadStream(filePath, options)
    }) as typeof fs.createReadStream)
    registerTwMediaProtocol(root)

    const response = await registeredHandler()(new Request(`twmedia://asset/${VALID_SHA}.mp4`))
    const received = Buffer.from(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(sawDescriptor).toBe(true)
    expect(streamSpy).toHaveBeenCalledWith(
      assetPath,
      expect.objectContaining({ fd: expect.any(Number), autoClose: true })
    )
    expect(received.length).toBe(size)
    expect(received.equals(originalBody)).toBe(true)
    expect(fs.readFileSync(assetPath).subarray(0, 1).toString()).toBe('B')
  })
})
