import { Session } from 'node:inspector'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { collectMainCpuProfile } = require('./nodeInspectorMainCollector.cjs')

describe('shared main inspector collector lifecycle', () => {
  it('can evaluate main after stopping a profile on a caller-owned inspector', async () => {
    const native = new Session()
    native.connect()
    const disconnect = vi.fn(() => native.disconnect())
    const session = {
      post: (method: string, params: object = {}) =>
        new Promise((resolve, reject) => {
          native.post(method, params, (error, result) => {
            if (error) reject(error)
            else resolve(result)
          })
        }),
      disconnect
    }
    try {
      const cpu = await collectMainCpuProfile(session, { disconnectOnStop: false })
      await cpu.stop()
      expect(disconnect).not.toHaveBeenCalled()
      const result = await session.post('Runtime.evaluate', {
        expression: '21 * 2',
        returnByValue: true
      })
      expect(result).toMatchObject({ result: { value: 42 } })
    } finally {
      native.disconnect()
    }
  })

  it('retains the standalone collector close behavior', async () => {
    const session = { post: vi.fn(async () => ({})), disconnect: vi.fn() }
    await (await collectMainCpuProfile(session)).stop()
    expect(session.disconnect).toHaveBeenCalledOnce()
  })
})
