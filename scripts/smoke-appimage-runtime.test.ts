import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { assertStaticRuntime, waitForMain } = require('./smoke-appimage-runtime.cjs')

describe('actual AppImage startup proof', () => {
  it('accepts a static runtime and rejects libfuse linkage or a failed probe', () => {
    expect(() =>
      assertStaticRuntime({ status: 1, stderr: 'not a dynamic executable' })
    ).not.toThrow()
    expect(() =>
      assertStaticRuntime({ status: 0, stdout: 'libfuse.so.2 => /lib/libfuse.so.2' })
    ).toThrow()
    expect(() => assertStaticRuntime({ error: new Error('ldd unavailable') })).toThrow(
      'ldd unavailable'
    )
  })

  it('requires TaskWraith main startup instead of mere process survival', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null
    })
    const ready = waitForMain(child, 2000)
    child.stdout.write('[local-control] listening at /tmp/private-smoke.sock\n')
    await expect(ready).resolves.toBeUndefined()
  })

  it('rejects an early process exit even if a readiness line was printed', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 1,
      signalCode: null
    })
    await expect(waitForMain(child, 2000)).rejects.toThrow('exited before main startup')
  })
})
