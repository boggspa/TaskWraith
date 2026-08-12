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

interface InteropHarness {
  supervisor: StudioCompanionSupervisor
  events: StudioSupervisorEvent[]
  child: () => ChildProcess | null
}

async function createInteropHarness(args: readonly string[]): Promise<InteropHarness> {
  const directory = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'studio-swift-interop-'))
  const store = await StudioRevisionStore.open(directory)
  const events: StudioSupervisorEvent[] = []
  let child: ChildProcess | null = null
  const supervisor = new StudioCompanionSupervisor({
    store,
    spawn: () => {
      const spawned = spawnStudioCompanionProcess(companionBinaryPath, args)
      child = spawned as unknown as ChildProcess
      return spawned
    },
    maxRestarts: 0,
    onEvent: (event) => events.push(event)
  })
  cleanups.push(async () => {
    await supervisor.stop()
    await store.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  })
  return { supervisor, events, child: () => child }
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
      await until(() => harness.supervisor.state === 'running')
      // v1 exposes no host-observable hydration signal, so give the local
      // handshake a moment before EOF; a premature EOF would exit 5 and fail
      // the code-0 assertion below.
      await new Promise((resolve) => setTimeout(resolve, 500))
      await harness.supervisor.stop()
      expect(harness.supervisor.state).toBe('stopped')
      expect(harness.supervisor.status().lastExit).toEqual({ code: 0, signal: null })
      // Stdin EOF sufficed: no SIGTERM/SIGKILL escalation should have fired.
      expect(harness.child()?.killed ?? true).toBe(false)
      expect(harness.events.filter((event) => event.type === 'decode_error')).toEqual([])
    },
    20000
  )
})
