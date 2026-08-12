import * as nodeFs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  StudioCompanionSupervisor,
  spawnStudioCompanionProcess,
  type StudioSupervisorEvent
} from './StudioCompanionSupervisor'
import { STUDIO_METHODS, StudioNdjsonDecoder } from './StudioProtocol'
import { StudioRevisionStore } from './StudioRevisionStore'

/**
 * Live interop: the REAL Swift TaskWraithStudioCompanion binary running under
 * StudioCompanionSupervisor — the S1 evidence path for companion lifecycle.
 *
 * Gated on the built binary existing (produce it with
 * `cd swift/TaskWraithBridge && swift build --disable-sandbox`); the tests
 * self-skip otherwise so environments without a Swift toolchain stay green.
 *
 * The --hydrate-once companion mode makes the exercise self-falsifying: the
 * binary exits 0 only after the full hello -> getDocument hydration succeeds
 * against this host's dispatcher; every handshake failure exits nonzero.
 */
const companionBinaryPath = nodePath.join(
  process.cwd(),
  'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion'
)
const hasCompanionBinary = nodeFs.existsSync(companionBinaryPath)

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface InteropHarnessOptions {
  maxRestarts?: number
  restartDelayMs?: number
}

interface InteropHarness {
  supervisor: StudioCompanionSupervisor
  events: StudioSupervisorEvent[]
  children: () => ChildProcess[]
  methodsBySpawn: () => string[][]
}

async function createInteropHarness(
  args: readonly string[],
  options: InteropHarnessOptions = {}
): Promise<InteropHarness> {
  const directory = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'studio-swift-interop-'))
  const store = await StudioRevisionStore.open(directory)
  const events: StudioSupervisorEvent[] = []
  const children: ChildProcess[] = []
  const methodsBySpawn: string[][] = []
  const supervisor = new StudioCompanionSupervisor({
    store,
    spawn: () => {
      const spawned = spawnStudioCompanionProcess(
        companionBinaryPath,
        args
      ) as unknown as ChildProcess
      const decoder = new StudioNdjsonDecoder()
      const methods: string[] = []
      children.push(spawned)
      methodsBySpawn.push(methods)
      spawned.stdout?.on('data', (chunk: Buffer | string) => {
        for (const event of decoder.push(chunk)) {
          if (
            event.kind === 'message' &&
            typeof event.value === 'object' &&
            event.value !== null &&
            typeof (event.value as { method?: unknown }).method === 'string'
          ) {
            methods.push((event.value as { method: string }).method)
          }
        }
      })
      return spawned
    },
    maxRestarts: options.maxRestarts ?? 0,
    restartDelayMs: options.restartDelayMs ?? 10,
    onEvent: (event) => events.push(event)
  })
  cleanups.push(async () => {
    await supervisor.stop()
    await store.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  })
  return {
    supervisor,
    events,
    children: () => children,
    methodsBySpawn: () => methodsBySpawn
  }
}

describe('Swift companion under StudioCompanionSupervisor (interop)', () => {
  it.runIf(hasCompanionBinary)(
    'hydrates hello -> getDocument against the real binary and exits 0 (--hydrate-once)',
    async () => {
      const harness = await createInteropHarness(['--hydrate-once'])
      harness.supervisor.start()
      await until(
        () => harness.supervisor.state === 'stopped' || harness.supervisor.state === 'failed',
        15000
      )
      expect(harness.supervisor.state).toBe('stopped')
      expect(harness.supervisor.status().lastExit).toEqual({ code: 0, signal: null })
      expect(harness.events.some((event) => event.type === 'clean_exit')).toBe(true)
      expect(harness.events).toContainEqual({ type: 'hydration_served', revision: 0 })
      // Any TS<->Swift framing drift would surface here as host-side decode
      // errors on the companion's emitted NDJSON.
      expect(harness.events.filter((event) => event.type === 'decode_error')).toEqual([])
    },
    20000
  )

  it.runIf(hasCompanionBinary)(
    'stays resident without the flag and exits 0 on supervisor stop() stdin EOF',
    async () => {
      const harness = await createInteropHarness([])
      harness.supervisor.start()
      await until(() => harness.events.some((event) => event.type === 'hydration_served'), 15000)
      await harness.supervisor.stop()
      expect(harness.supervisor.state).toBe('stopped')
      expect(harness.supervisor.status().lastExit).toEqual({ code: 0, signal: null })
      // Stdin EOF sufficed: no SIGTERM/SIGKILL escalation should have fired.
      expect(harness.children().at(-1)?.killed ?? true).toBe(false)
      expect(harness.events.filter((event) => event.type === 'decode_error')).toEqual([])
    },
    20000
  )

  it.runIf(hasCompanionBinary)(
    'restarts the real binary after SIGKILL, re-hydrates, and enforces the cap',
    async () => {
      const harness = await createInteropHarness([], { maxRestarts: 1, restartDelayMs: 10 })
      harness.supervisor.start()

      await until(
        () => harness.events.filter((event) => event.type === 'hydration_served').length === 1,
        15000
      )
      expect(harness.methodsBySpawn()[0]).toEqual([
        STUDIO_METHODS.hello,
        STUDIO_METHODS.getDocument
      ])
      expect(harness.children()[0].kill('SIGKILL')).toBe(true)

      await until(
        () =>
          harness.children().length === 2 &&
          harness.events.filter((event) => event.type === 'hydration_served').length === 2,
        15000
      )
      expect(harness.supervisor.state).toBe('running')
      expect(harness.methodsBySpawn()[1]).toEqual([
        STUDIO_METHODS.hello,
        STUDIO_METHODS.getDocument
      ])
      expect(harness.events).toContainEqual({
        type: 'restart_scheduled',
        delayMs: 10,
        restartsInWindow: 1
      })
      expect(harness.events.filter((event) => event.type === 'decode_error')).toEqual([])

      expect(harness.children()[1].kill('SIGKILL')).toBe(true)
      await until(() => harness.supervisor.state === 'failed', 15000)
      expect(harness.children()).toHaveLength(2)
      expect(harness.events).toContainEqual({
        type: 'restart_cap_exceeded',
        restartsInWindow: 1
      })
    },
    30000
  )
})
