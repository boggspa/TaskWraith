import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  bootstrapMainProcess,
  type MainProcessBootstrapDependencies,
  type SecondInstanceEventArguments
} from './MainProcessBootstrap'

function dependencies(
  overrides: Partial<MainProcessBootstrapDependencies> = {}
): MainProcessBootstrapDependencies {
  return {
    isHelperProcess: false,
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    loadMainProcess: vi.fn(async () => undefined),
    subscribeSecondInstance: vi.fn(() => vi.fn()),
    replaySecondInstance: vi.fn(),
    log: vi.fn(),
    ...overrides
  }
}

describe('main process bootstrap', () => {
  it('exits a losing normal instance before loading the main graph', async () => {
    const deps = dependencies({ requestSingleInstanceLock: vi.fn(() => false) })

    await expect(bootstrapMainProcess(deps)).resolves.toBe('secondary')

    expect(deps.loadMainProcess).not.toHaveBeenCalled()
    expect(deps.subscribeSecondInstance).not.toHaveBeenCalled()
    expect(deps.quit).toHaveBeenCalledOnce()
    expect(deps.log).toHaveBeenCalledWith(
      '[remote-bridge] another TaskWraith instance holds the lock — exiting'
    )
  })

  it('keeps helper processes outside the normal app singleton', async () => {
    const deps = dependencies({ isHelperProcess: true })

    await expect(bootstrapMainProcess(deps)).resolves.toBe('helper')

    expect(deps.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(deps.loadMainProcess).toHaveBeenCalledOnce()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('buffers a second launch until the primary main handler is installed', async () => {
    const order: string[] = []
    const earlyEvent: SecondInstanceEventArguments = [
      { kind: 'event' },
      ['TaskWraith', '--open-chat=chat-1'],
      '/workspace',
      { source: 'finder' }
    ]
    let notifySecondInstance: ((...args: SecondInstanceEventArguments) => void) | undefined
    const deps = dependencies({
      requestSingleInstanceLock: vi.fn(() => {
        order.push('lock')
        return true
      }),
      subscribeSecondInstance: vi.fn((listener) => {
        order.push('subscribe')
        notifySecondInstance = listener
        return () => order.push('unsubscribe')
      }),
      loadMainProcess: vi.fn(async () => {
        order.push('load')
        notifySecondInstance?.(...earlyEvent)
      }),
      replaySecondInstance: vi.fn((args) => {
        order.push('replay')
        expect(args).toEqual(earlyEvent)
      })
    })

    await expect(bootstrapMainProcess(deps)).resolves.toBe('primary')

    expect(order).toEqual(['lock', 'subscribe', 'load', 'unsubscribe', 'replay'])
    expect(deps.replaySecondInstance).toHaveBeenCalledOnce()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('removes the temporary listener when the main graph fails to load', async () => {
    const unsubscribe = vi.fn()
    const error = new Error('main import failed')
    const deps = dependencies({
      subscribeSecondInstance: vi.fn(() => unsubscribe),
      loadMainProcess: vi.fn(async () => {
        throw error
      })
    })

    await expect(bootstrapMainProcess(deps)).rejects.toBe(error)

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(deps.replaySecondInstance).not.toHaveBeenCalled()
  })

  it('keeps devAppName first and the full main graph behind a dynamic import', () => {
    const entrySource = readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8')
    const viteConfigSource = readFileSync(
      new URL('../../electron.vite.config.ts', import.meta.url),
      'utf8'
    )

    expect(entrySource.indexOf("import './devAppName'")).toBeLessThan(
      entrySource.indexOf("from 'electron'")
    )
    expect(entrySource).toContain("loadMainProcess: () => import('./index')")
    expect(viteConfigSource).toContain("index: resolve('src/main/bootstrap.ts')")
  })
})
