import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { createMultiProfileLifecycle } = require('./multiProfileLifecycle.cjs')
const instance = {
  role: 'active',
  userDataPath: '/profile',
  launch: {
    instanceId: 'gh-0',
    repoRoot: '/repo',
    home: '/repo/perf-homes/home',
    remoteDebuggingPort: 9400,
    mainInspectorPort: 9800
  }
}
describe('real T2 lifecycle adapter binding', () => {
  it('awaits delayed repeated-window teardown before releasing runner cleanup', async () => {
    const controller = new AbortController()
    let release!: () => void
    const teardown = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const repeatEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const events: string[] = []
    let calls = 0
    const adapter = createMultiProfileLifecycle(
      { artifactDir: '/artifacts', cell: 'cell', buildId: 'build', signal: controller.signal },
      {
        runLiveLanes: async (options: any) => {
          if (++calls === 1) return { verdict: { ok: true } }
          try {
            entered()
            await options.sleep(10000)
          } finally {
            events.push('teardown-start')
            await teardown
            events.push('teardown-done')
          }
        },
        run: async (_argv: string[], options: any) => {
          await options.onVerifiedCaptureSession({ serverInstance: { ok: true } })
          await options.runLiveLanes({ sleep: () => new Promise(() => {}) })
          await options.onCaptureSessionComplete({
            report: { liveRounds: { verdict: { ok: true } } }
          })
          events.push('runner-cleanup')
          return { report: {} }
        }
      }
    )
    const handle = await adapter.start(instance)
    const input = {
      phase: 'first',
      plan: { instances: [instance] },
      handles: new Map([[0, handle]])
    }
    await adapter.measure(input)
    const repeat = adapter.measure({ ...input, phase: 'repeat' }).catch(() => {})
    await repeatEntered
    controller.abort()
    let done = false
    const cancel = adapter.cancel().then(() => {
      done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(false)
    expect(events).toEqual(['teardown-start'])
    release()
    await Promise.all([cancel, repeat])
    expect(events).toEqual(['teardown-start', 'teardown-done', 'runner-cleanup'])
  })
  it('holds verified sessions, reuses live windows, then waits for runner cleanup', async () => {
    const events: string[] = []
    const adapter = createMultiProfileLifecycle(
      { artifactDir: '/artifacts', cell: 'cell', buildId: 'build' },
      {
        runLiveLanes: async () => {
          events.push('lanes')
          return { verdict: { ok: true } }
        },
        run: async (argv: string[], options: any) => {
          expect(argv).toContain('--live-lanes')
          expect(argv).toContain('--home=/repo/perf-homes/home')
          await options.onVerifiedCaptureSession({
            serverInstance: { ok: true, evidence: { hostId: 'host' } }
          })
          await options.runLiveLanes({ real: 'options' })
          await options.onCaptureSessionComplete({
            report: { liveRounds: { verdict: { ok: true } } }
          })
          events.push('cleanup')
          return { report: { cleanupFailures: [] } }
        }
      }
    )
    const handle = await adapter.start(instance)
    expect(events).toEqual([])
    const input = {
      phase: 'coexistence',
      plan: { instances: [instance] },
      handles: new Map([[0, handle]])
    }
    await adapter.measure(input)
    await adapter.measure({ ...input, phase: 'peer-restarted' })
    expect(events).toEqual(['lanes', 'lanes'])
    await adapter.stop(handle)
    expect(events).toEqual(['lanes', 'lanes', 'cleanup'])
  })
})
