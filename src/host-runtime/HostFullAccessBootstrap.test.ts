import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  HOST_FULL_ACCESS_BOOTSTRAP_FD,
  hostFullAccessBootstrapFrame,
  readHostFullAccessBootstrapSecret,
  type HostFullAccessBootstrapIo
} from './HostFullAccessBootstrap'

function pipe(frame?: Buffer): { io: HostFullAccessBootstrapIo; stream: PassThrough } {
  const stream = new PassThrough()
  const io = {
    fstatSync: vi.fn(() => ({ isFIFO: () => true, isFile: () => false })),
    createReadStream: vi.fn(() => stream),
    closeSync: vi.fn()
  }
  if (frame) {
    const first = Math.floor(frame.byteLength / 3)
    const second = Math.floor((frame.byteLength * 2) / 3)
    stream.write(frame.subarray(0, first))
    stream.write(frame.subarray(first, second))
    stream.end(frame.subarray(second))
  }
  return { io, stream }
}

describe('HostFullAccessBootstrap', () => {
  it('consumes one fragmented inherited pipe frame and closes the fd', async () => {
    const secret = Buffer.alloc(32, 7)
    const { io } = pipe(hostFullAccessBootstrapFrame(secret))
    const read = await readHostFullAccessBootstrapSecret(undefined, { io, timeoutMs: 100 })
    expect(read).toEqual(secret)
    expect(io.createReadStream).toHaveBeenCalledWith(HOST_FULL_ACCESS_BOOTSTRAP_FD)
    expect(io.closeSync).toHaveBeenCalledWith(HOST_FULL_ACCESS_BOOTSTRAP_FD)
  })

  it.each(['closed', 'regular-file', 'short', 'wrong-prefix', 'trailing'])(
    'fails closed for %s bootstrap input',
    async (kind) => {
      const valid = hostFullAccessBootstrapFrame(Buffer.alloc(32, 0xab))
      const frame =
        kind === 'closed'
          ? Buffer.alloc(0)
          : kind === 'short'
            ? valid.subarray(0, valid.byteLength - 1)
            : kind === 'wrong-prefix'
              ? (() => {
                  const changed = Buffer.from(valid)
                  changed[0] ^= 0x01
                  return changed
                })()
              : kind === 'trailing'
                ? Buffer.concat([valid, Buffer.from([0])])
                : valid
      const { io } = pipe(frame)
      if (kind === 'closed')
        vi.mocked(io.fstatSync).mockImplementation(() => {
          throw new Error('bad fd')
        })
      if (kind === 'regular-file') {
        vi.mocked(io.fstatSync).mockReturnValue({
          isFIFO: () => false,
          isFile: () => true
        })
      }
      await expect(readHostFullAccessBootstrapSecret(3, { io, timeoutMs: 100 })).resolves.toBeNull()
      expect(io.closeSync).toHaveBeenCalledWith(3)
    }
  )

  it('times out a silent inherited FIFO so ordinary Host startup cannot hang', async () => {
    const { io, stream } = pipe()
    await expect(readHostFullAccessBootstrapSecret(3, { io, timeoutMs: 5 })).resolves.toBeNull()
    expect(stream.destroyed).toBe(true)
    expect(io.closeSync).toHaveBeenCalledWith(3)
  })

  it('closes fd3 when the configured timeout is invalid', async () => {
    const { io } = pipe()
    await expect(readHostFullAccessBootstrapSecret(3, { io, timeoutMs: 0 })).resolves.toBeNull()
    expect(io.createReadStream).not.toHaveBeenCalled()
    expect(io.closeSync).toHaveBeenCalledWith(3)
  })
})
