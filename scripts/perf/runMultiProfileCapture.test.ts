import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { runMultiProfileCapture } = require('./runMultiProfileCapture.cjs')
const { createMultiProfileLifecycle } = require('./multiProfileLifecycle.cjs')
const argv = [
  '--configuration=idle3',
  '--home=/synthetic/repo/perf-homes/shared',
  '--repo-root=/synthetic/repo',
  '--artifact-dir=/private/artifacts',
  '--cell=large/2/warm/ollama_same_model_repeated/none',
  '--build-id=frozen-a'
]
describe('G-H executable capture entrypoint', () => {
  it.each(['before-ready', 'during-measure'])(
    'awaits owned cleanup on SIGINT %s',
    async (phase) => {
      const signalSource = new EventEmitter()
      const artifactDir = mkdtempSync(join(tmpdir(), 'gh-cancel-'))
      const events: string[] = []
      let releaseCleanup!: () => void
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve
      })
      let reached!: () => void
      const reachedGate = new Promise<void>((resolve) => {
        reached = resolve
      })
      let settled = false
      const capture = runMultiProfileCapture(
        [
          ...argv.filter(
            (arg) => !arg.startsWith('--configuration=') && !arg.startsWith('--artifact-dir=')
          ),
          '--configuration=active-alone',
          `--artifact-dir=${artifactDir}`,
          '--launch',
          '--i-accept-isolated-launch'
        ],
        {
          signalSource,
          createLifecycle: (options: any) =>
            createMultiProfileLifecycle(options, {
              run: async (_argv: string[], runner: any) => {
                const aborted = new Promise<void>((resolve) =>
                  runner.signal.addEventListener('abort', () => resolve(), { once: true })
                )
                try {
                  if (phase === 'before-ready') {
                    reached()
                    await aborted
                    throw new Error('cancelled')
                  }
                  await runner.onVerifiedCaptureSession({
                    serverInstance: {
                      ok: true,
                      evidence: {
                        hostId: 'h',
                        hostPid: 1,
                        bootEpoch: 'a'.repeat(64),
                        profileHash: 'p',
                        socketNamespace: 's'
                      }
                    }
                  })
                  reached()
                  await aborted
                  throw new Error('cancelled')
                } finally {
                  events.push('cleanup-start')
                  await cleanupGate
                  events.push('cleanup-finished')
                }
              }
            })
        }
      ).then((result: any) => {
        settled = true
        return result
      })
      try {
        await reachedGate
        signalSource.emit('SIGINT')
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(settled).toBe(false)
        expect(events).toEqual(['cleanup-start'])
        releaseCleanup()
        const result = await capture
        expect(result).toMatchObject({
          ok: false,
          cancelled: true,
          exitCode: 130,
          acceptance: 'unmeasured'
        })
        expect(events).toEqual(['cleanup-start', 'cleanup-finished'])
        expect(signalSource.listenerCount('SIGINT')).toBe(0)
        expect(signalSource.listenerCount('SIGTERM')).toBe(0)
        expect(
          JSON.parse(readFileSync(join(artifactDir, 'gh-capture-report.json'), 'utf8')).cancelled
        ).toBe(true)
      } finally {
        releaseCleanup()
        rmSync(artifactDir, { recursive: true, force: true })
      }
    }
  )
  it('defaults to a plan with no process launch or artifact writes', async () => {
    const result = await runMultiProfileCapture(argv, {
      createLifecycle: () => {
        throw new Error('must not launch')
      }
    })
    expect(result.dryPlan).toBe(true)
    expect(result.plan.instances).toHaveLength(4)
    expect(result.acceptance).toBe('unmeasured')
  })
  it('rejects launch without acceptance and contradictory dry launch', async () => {
    await expect(runMultiProfileCapture([...argv, '--launch'])).rejects.toThrow('acceptance')
    await expect(
      runMultiProfileCapture([...argv, '--launch', '--dry-plan', '--i-accept-isolated-launch'])
    ).rejects.toThrow('acceptance')
  })
  it('refuses colliding ports before launch', async () => {
    await expect(runMultiProfileCapture([...argv, '--inspect-base=9400'])).rejects.toThrow()
  })
})
