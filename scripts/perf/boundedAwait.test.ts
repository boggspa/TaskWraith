import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { awaitWithTimeout } = require('./boundedAwait.cjs')

describe('awaitWithTimeout', () => {
  it('resolves when work finishes inside the bound', async () => {
    await expect(awaitWithTimeout(Promise.resolve(7), 50, 'fast')).resolves.toBe(7)
  })

  it('rejects with CAPTURE_TIMEOUT when work never settles', async () => {
    await expect(
      awaitWithTimeout(new Promise(() => undefined), 20, 'heap_snapshot')
    ).rejects.toMatchObject({
      code: 'CAPTURE_TIMEOUT',
      message: 'heap_snapshot timed out after 20ms'
    })
  })

  it('rejects immediately when the budget is already zero', async () => {
    await expect(awaitWithTimeout(Promise.resolve(1), 0, 'heap_snapshot')).rejects.toMatchObject({
      code: 'CAPTURE_TIMEOUT'
    })
  })
})
