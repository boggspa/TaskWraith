import * as fsPromises from 'node:fs/promises'
import * as nodeEvents from 'node:events'
import * as nodeStream from 'node:stream'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  StudioCompanionSupervisor,
  StudioSupervisorError,
  spawnStudioCompanionProcess,
  type StudioCompanionSupervisorOptions,
  type StudioSupervisorEvent
} from './StudioCompanionSupervisor'
import {
  STUDIO_METHODS,
  STUDIO_PROPOSAL_SCHEMA_VERSION,
  STUDIO_TRANSCRIPT_SCHEMA_VERSION
} from './StudioProtocol'
import { StudioRevisionStore } from './StudioRevisionStore'

/** Loose view of one NDJSON line the supervisor wrote to the companion. */
interface StudioWireRecord {
  jsonrpc?: string
  id?: number | null
  method?: string
  result?: Record<string, unknown>
  error?: { code: number; message: string; data: Record<string, unknown> }
  params?: Record<string, unknown>
}

interface FakeCompanionConfig {
  /** Exit(0) shortly after stdin EOF, like a well-behaved companion. Default true. */
  exitOnStdinEnd?: boolean
  /** Signals (besides SIGKILL, always lethal) that terminate the fake. */
  exitOnSignal?: NodeJS.Signals[]
}

class FakeCompanion extends nodeEvents.EventEmitter {
  readonly stdin = new nodeStream.PassThrough()
  readonly stdout = new nodeStream.PassThrough()
  readonly stderr = new nodeStream.PassThrough()
  readonly pid = 4242
  readonly kills: NodeJS.Signals[] = []
  readonly messages: StudioWireRecord[] = []
  private exited = false

  constructor(private readonly config: FakeCompanionConfig = {}) {
    super()
    let buffered = ''
    this.stdin.on('data', (chunk) => {
      buffered += String(chunk)
      let index = buffered.indexOf('\n')
      while (index !== -1) {
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        if (line.trim().length > 0) this.messages.push(JSON.parse(line) as StudioWireRecord)
        index = buffered.indexOf('\n')
      }
    })
    if (config.exitOnStdinEnd !== false) {
      this.stdin.on('finish', () => setImmediate(() => this.exit(0)))
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal)
    const lethal = signal === 'SIGKILL' || (this.config.exitOnSignal ?? []).includes(signal)
    if (lethal) setImmediate(() => this.exit(null, signal))
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, signal)
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  sendRaw(text: string): void {
    this.stdout.write(text)
  }
}

interface HarnessOptions {
  maxRestarts?: number
  restartWindowMs?: number
  restartDelayMs?: number
  stopGraceMs?: number
  childConfig?: FakeCompanionConfig
  allowMediaRoot?: boolean
  spawn?: StudioCompanionSupervisorOptions['spawn']
}

interface Harness {
  supervisor: StudioCompanionSupervisor
  store: StudioRevisionStore
  directory: string
  children: FakeCompanion[]
  events: StudioSupervisorEvent[]
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const directory = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'studio-supervisor-'))
  const store = await StudioRevisionStore.open(
    directory,
    options.allowMediaRoot ? { allowedMediaRoots: [directory] } : undefined
  )
  const children: FakeCompanion[] = []
  const events: StudioSupervisorEvent[] = []
  const supervisor = new StudioCompanionSupervisor({
    store,
    spawn:
      options.spawn ??
      (() => {
        const child = new FakeCompanion(options.childConfig)
        children.push(child)
        return child
      }),
    restartDelayMs: options.restartDelayMs ?? 1,
    onEvent: (event) => events.push(event),
    ...(options.maxRestarts !== undefined ? { maxRestarts: options.maxRestarts } : {}),
    ...(options.restartWindowMs !== undefined ? { restartWindowMs: options.restartWindowMs } : {}),
    ...(options.stopGraceMs !== undefined ? { stopGraceMs: options.stopGraceMs } : {})
  })
  cleanups.push(async () => {
    await supervisor.stop()
    await store.close()
    await fsPromises.rm(directory, { recursive: true, force: true })
  })
  return { supervisor, store, directory, children, events }
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const insertOp = {
  type: 'insert_range',
  itemId: 'sup-item-1',
  assetId: 'asset-1',
  sourceIn: { n: 0, d: 30000 },
  sourceOut: { n: 30030, d: 30000 },
  at: { n: 0, d: 1 }
}

describe('StudioCompanionSupervisor', () => {
  it('serves companion-driven hydration: hello then getDocument', async () => {
    const harness = await createHarness()
    harness.supervisor.start()
    expect(harness.supervisor.state).toBe('running')
    expect(harness.supervisor.status().pid).toBe(4242)

    const child = harness.children[0]
    child.send({
      jsonrpc: '2.0',
      id: 1,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: 1 }
    })
    await until(() => child.messages.length >= 1)
    expect(child.messages[0]).toMatchObject({ id: 1, result: { protocolVersion: 1, revision: 0 } })

    child.send({ jsonrpc: '2.0', id: 2, method: STUDIO_METHODS.getDocument })
    await until(() => child.messages.length >= 2)
    expect(child.messages[1]).toMatchObject({ id: 2, result: { revision: 0 } })

    expect(() => harness.supervisor.start()).toThrowError(StudioSupervisorError)

    await harness.supervisor.stop()
    expect(harness.supervisor.state).toBe('stopped')
    expect(harness.children).toHaveLength(1)
  })

  it('pushes studio/editCommitted after a committed edit, never after a rejection', async () => {
    const harness = await createHarness()
    harness.supervisor.start()
    const child = harness.children[0]

    child.send({
      jsonrpc: '2.0',
      id: 3,
      method: STUDIO_METHODS.applyEdit,
      params: { baseRevision: 0, op: insertOp }
    })
    await until(() => child.messages.length >= 2)
    expect(child.messages[0]).toMatchObject({ id: 3, result: { revision: 1 } })
    expect(child.messages[1]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: { revision: 1 }
    })

    child.send({
      jsonrpc: '2.0',
      id: 4,
      method: STUDIO_METHODS.applyEdit,
      params: { baseRevision: 0, op: { ...insertOp, itemId: 'sup-item-2' } }
    })
    await until(() => child.messages.length >= 3)
    expect(child.messages[2].error?.data).toMatchObject({
      studioCode: 'stale_base',
      currentRevision: 1
    })
    const committed = child.messages.filter(
      (message) => message.method === STUDIO_METHODS.editCommitted
    )
    expect(committed).toHaveLength(1)
    expect(harness.store.revision).toBe(1)
    await harness.supervisor.stop()
  })

  it('replays an open proposal through getDocument after restart and pushes both transitions', async () => {
    const harness = await createHarness({ maxRestarts: 3 })
    harness.supervisor.start()
    const first = harness.children[0]

    first.send({
      jsonrpc: '2.0',
      id: 1,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: 1 }
    })
    first.send({ jsonrpc: '2.0', id: 2, method: STUDIO_METHODS.getDocument })
    await until(() => first.messages.length >= 2)

    first.send({
      jsonrpc: '2.0',
      id: 3,
      method: STUDIO_METHODS.proposeEdit,
      params: {
        schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
        baseRevision: 0,
        proposalId: 'proposal-restart',
        op: insertOp
      }
    })
    await until(() => first.messages.length >= 4)
    expect(first.messages[2]).toMatchObject({
      id: 3,
      result: { revision: 1, proposal: { proposalId: 'proposal-restart' } }
    })
    expect(first.messages[3]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: {
        revision: 1,
        op: { type: 'propose_edit', proposal: { proposalId: 'proposal-restart' } }
      }
    })

    first.exit(1)
    await until(() => harness.children.length === 2)
    const second = harness.children[1]
    second.send({
      jsonrpc: '2.0',
      id: 4,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: 1 }
    })
    second.send({ jsonrpc: '2.0', id: 5, method: STUDIO_METHODS.getDocument })
    await until(() => second.messages.length >= 2)
    expect(second.messages[1]).toMatchObject({
      id: 5,
      result: {
        revision: 1,
        document: { proposals: [{ proposalId: 'proposal-restart' }], tracks: [] }
      }
    })

    second.send({
      jsonrpc: '2.0',
      id: 6,
      method: STUDIO_METHODS.resolveProposal,
      params: {
        schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
        baseRevision: 1,
        proposalId: 'proposal-restart',
        decision: 'accept'
      }
    })
    await until(() => second.messages.length >= 4)
    expect(second.messages[2]).toMatchObject({
      id: 6,
      result: { revision: 2, proposalId: 'proposal-restart', decision: 'accept' }
    })
    expect(second.messages[3]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: {
        revision: 2,
        op: {
          type: 'resolve_proposal',
          proposalId: 'proposal-restart',
          decision: 'accept'
        }
      }
    })
    expect(harness.store.getDocument()).toMatchObject({
      proposals: [],
      tracks: [{ items: [{ itemId: 'sup-item-1' }] }]
    })
    await harness.supervisor.stop()
  })

  it('opens host-authorized media only after hydration and pushes the durable commit', async () => {
    const harness = await createHarness({ allowMediaRoot: true })
    const mediaPath = nodePath.join(harness.directory, 'host-owned.mov')
    await fsPromises.writeFile(mediaPath, 'fixture', 'utf8')
    harness.supervisor.start()
    const child = harness.children[0]

    await expect(
      harness.supervisor.openMedia({
        assetId: 'host-owned',
        path: mediaPath,
        mediaKind: 'video'
      })
    ).resolves.toMatchObject({ ok: false, code: 'companion_not_ready', currentRevision: 0 })
    await expect(
      harness.supervisor.setTranscript({
        schemaVersion: STUDIO_TRANSCRIPT_SCHEMA_VERSION,
        transcriptId: 'too-early',
        assetId: 'host-owned',
        segments: []
      })
    ).resolves.toMatchObject({ ok: false, code: 'companion_not_ready', currentRevision: 0 })
    expect(harness.store.revision).toBe(0)

    child.send({
      jsonrpc: '2.0',
      id: 1,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: 1 }
    })
    await until(() => child.messages.length >= 1)
    child.send({ jsonrpc: '2.0', id: 2, method: STUDIO_METHODS.getDocument })
    await until(() => child.messages.length >= 2)

    await expect(
      harness.supervisor.openMedia({
        assetId: 'host-owned',
        path: mediaPath,
        mediaKind: 'video'
      })
    ).resolves.toMatchObject({
      ok: true,
      revision: 1,
      asset: { assetId: 'host-owned', mediaKind: 'video' }
    })
    await until(() => child.messages.length >= 3)
    expect(child.messages[2]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: {
        revision: 1,
        op: {
          type: 'open_media',
          asset: { assetId: 'host-owned', mediaKind: 'video' }
        }
      }
    })
    expect(harness.store.revision).toBe(1)

    await expect(
      harness.supervisor.setTranscript({
        schemaVersion: STUDIO_TRANSCRIPT_SCHEMA_VERSION,
        transcriptId: 'host-owned-en',
        assetId: 'host-owned',
        segments: [
          {
            segmentId: 'host-phrase',
            text: 'TaskWraith-owned words',
            sourceIn: { n: 0, d: 1 },
            sourceOut: { n: 1001, d: 1000 }
          }
        ]
      })
    ).resolves.toMatchObject({
      ok: true,
      revision: 2,
      transcript: {
        transcriptId: 'host-owned-en',
        segments: [{ sourceOut: { n: 1001, d: 1000 } }]
      }
    })
    await until(() => child.messages.length >= 4)
    expect(child.messages[3]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: {
        revision: 2,
        op: {
          type: 'set_transcript',
          transcript: {
            transcriptId: 'host-owned-en',
            assetId: 'host-owned',
            segments: [{ segmentId: 'host-phrase' }]
          }
        }
      }
    })
    expect(harness.store.getDocument().transcripts).toHaveLength(1)
    await harness.supervisor.stop()
  })

  it('pushes studio/editCommitted after a committed media open', async () => {
    const harness = await createHarness({ allowMediaRoot: true })
    const mediaPath = nodePath.join(harness.directory, 'clip.mov')
    await fsPromises.writeFile(mediaPath, 'fixture', 'utf8')
    harness.supervisor.start()
    const child = harness.children[0]

    child.send({
      jsonrpc: '2.0',
      id: 13,
      method: STUDIO_METHODS.openMedia,
      params: {
        schemaVersion: 1,
        baseRevision: 0,
        assetId: 'asset-open',
        path: mediaPath,
        mediaKind: 'video'
      }
    })
    await until(() => child.messages.length >= 2)
    expect(child.messages[0]).toMatchObject({
      id: 13,
      result: { schemaVersion: 1, revision: 1 }
    })
    expect(child.messages[1]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: {
        revision: 1,
        op: {
          type: 'open_media',
          asset: { assetId: 'asset-open', mediaKind: 'video' }
        }
      }
    })
    await harness.supervisor.stop()
  })

  it('pushes transcript commits and serves exact segments after companion restart', async () => {
    const harness = await createHarness({ allowMediaRoot: true, maxRestarts: 3 })
    const mediaPath = nodePath.join(harness.directory, 'spoken.mov')
    await fsPromises.writeFile(mediaPath, 'fixture', 'utf8')
    harness.supervisor.start()
    const first = harness.children[0]

    first.send({
      jsonrpc: '2.0',
      id: 20,
      method: STUDIO_METHODS.openMedia,
      params: {
        schemaVersion: 1,
        baseRevision: 0,
        assetId: 'spoken',
        path: mediaPath,
        mediaKind: 'video'
      }
    })
    await until(() => first.messages.length >= 2)
    first.send({
      jsonrpc: '2.0',
      id: 21,
      method: STUDIO_METHODS.setTranscript,
      params: {
        schemaVersion: STUDIO_TRANSCRIPT_SCHEMA_VERSION,
        baseRevision: 1,
        transcriptId: 'spoken-en',
        assetId: 'spoken',
        segments: [
          {
            segmentId: 'phrase-1',
            text: 'Exact words',
            sourceIn: { n: 30_030, d: 30_000 },
            sourceOut: { n: 60_060, d: 30_000 }
          }
        ]
      }
    })
    await until(() => first.messages.length >= 4)
    expect(first.messages[2]).toMatchObject({
      id: 21,
      result: {
        schemaVersion: STUDIO_TRANSCRIPT_SCHEMA_VERSION,
        revision: 2,
        transcript: { transcriptId: 'spoken-en' }
      }
    })
    expect(first.messages[3]).toMatchObject({
      method: STUDIO_METHODS.editCommitted,
      params: {
        revision: 2,
        op: {
          type: 'set_transcript',
          transcript: {
            transcriptId: 'spoken-en',
            segments: [
              {
                segmentId: 'phrase-1',
                sourceIn: { n: 1001, d: 1000 },
                sourceOut: { n: 1001, d: 500 }
              }
            ]
          }
        }
      }
    })

    first.exit(1)
    await until(() => harness.children.length === 2)
    const second = harness.children[1]
    second.send({
      jsonrpc: '2.0',
      id: 22,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: 1 }
    })
    second.send({ jsonrpc: '2.0', id: 23, method: STUDIO_METHODS.getDocument })
    await until(() => second.messages.length >= 2)
    expect(second.messages[1]).toMatchObject({
      id: 23,
      result: {
        revision: 2,
        document: {
          transcripts: [
            {
              transcriptId: 'spoken-en',
              segments: [{ segmentId: 'phrase-1', text: 'Exact words' }]
            }
          ]
        }
      }
    })
    await harness.supervisor.stop()
  })

  it('answers unparsable lines with an id-null parse_error and keeps serving', async () => {
    const harness = await createHarness()
    harness.supervisor.start()
    const child = harness.children[0]

    child.sendRaw('this is not json\n')
    await until(() => child.messages.length >= 1)
    expect(child.messages[0].id).toBeNull()
    expect(child.messages[0].error?.data.studioCode).toBe('parse_error')
    expect(harness.events.some((event) => event.type === 'decode_error')).toBe(true)

    child.send({
      jsonrpc: '2.0',
      id: 5,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: 1 }
    })
    await until(() => child.messages.length >= 2)
    expect(child.messages[1]).toMatchObject({ id: 5, result: { protocolVersion: 1 } })
    await harness.supervisor.stop()
  })

  it('restarts a crashed companion with a fresh decoder (no stale partial bytes)', async () => {
    const harness = await createHarness({ maxRestarts: 3 })
    harness.supervisor.start()
    const first = harness.children[0]

    first.sendRaw('{"jsonrpc":"2.0","id":9,"met')
    first.exit(1)
    await until(() => harness.children.length === 2 && harness.supervisor.state === 'running')

    const second = harness.children[1]
    second.send({
      jsonrpc: '2.0',
      id: 6,
      method: STUDIO_METHODS.hello,
      params: { protocolVersion: 1 }
    })
    await until(() => second.messages.length >= 1)
    expect(second.messages[0]).toMatchObject({ id: 6, result: { protocolVersion: 1 } })
    expect(second.messages[0].error).toBeUndefined()
    expect(
      harness.events.some(
        (event) => event.type === 'restart_scheduled' && event.restartsInWindow === 1
      )
    ).toBe(true)
    await harness.supervisor.stop()
  })

  it('caps crash restarts inside the sliding window and can be started again', async () => {
    const harness = await createHarness({ maxRestarts: 2 })
    harness.supervisor.start()
    harness.children[0].exit(1)
    await until(() => harness.children.length === 2)
    harness.children[1].exit(1)
    await until(() => harness.children.length === 3)
    harness.children[2].exit(1)
    await until(() => harness.supervisor.state === 'failed')
    expect(harness.children).toHaveLength(3)
    const cap = harness.events.find((event) => event.type === 'restart_cap_exceeded')
    expect(cap).toMatchObject({ restartsInWindow: 2 })

    harness.supervisor.start()
    await until(() => harness.children.length === 4)
    expect(harness.supervisor.state).toBe('running')
    await harness.supervisor.stop()
  })

  it('treats a clean exit(0) as a deliberate quit and does not respawn', async () => {
    const harness = await createHarness({ maxRestarts: 3 })
    harness.supervisor.start()
    harness.children[0].exit(0)
    await until(() => harness.supervisor.state === 'stopped')
    expect(harness.children).toHaveLength(1)
    expect(harness.events.some((event) => event.type === 'clean_exit')).toBe(true)
    expect(harness.supervisor.status().lastExit).toEqual({ code: 0, signal: null })
  })

  it('stop() escalates EOF then SIGTERM then SIGKILL for a lingering companion', async () => {
    const harness = await createHarness({
      childConfig: { exitOnStdinEnd: false },
      stopGraceMs: 15
    })
    harness.supervisor.start()
    const child = harness.children[0]
    await harness.supervisor.stop()
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(harness.supervisor.state).toBe('stopped')
    expect(harness.supervisor.status().lastExit).toEqual({ code: null, signal: 'SIGKILL' })
  })

  it('stop() during a scheduled restart cancels the respawn', async () => {
    const harness = await createHarness({ maxRestarts: 3, restartDelayMs: 60 })
    harness.supervisor.start()
    harness.children[0].exit(1)
    await until(() => harness.supervisor.state === 'restarting')
    await harness.supervisor.stop()
    expect(harness.supervisor.state).toBe('stopped')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.children).toHaveLength(1)
  })

  it('a throwing spawn counts as a crash and hits the restart cap', async () => {
    const harness = await createHarness({
      maxRestarts: 1,
      spawn: () => {
        throw new Error('no companion binary')
      }
    })
    harness.supervisor.start()
    await until(() => harness.supervisor.state === 'failed')
    expect(harness.events.filter((event) => event.type === 'spawn_error')).toHaveLength(2)
    expect(harness.events.some((event) => event.type === 'restart_cap_exceeded')).toBe(true)
  })

  it('drives a real companion process end-to-end over real pipes', async () => {
    const directory = await fsPromises.mkdtemp(
      nodePath.join(os.tmpdir(), 'studio-supervisor-real-')
    )
    const store = await StudioRevisionStore.open(directory)
    const events: StudioSupervisorEvent[] = []
    const script = `
        const NL = String.fromCharCode(10)
        let buffered = ''
        const send = (message) => process.stdout.write(JSON.stringify(message) + NL)
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (chunk) => {
          buffered += chunk
          let index = buffered.indexOf(NL)
          while (index !== -1) {
            const line = buffered.slice(0, index)
            buffered = buffered.slice(index + 1)
            index = buffered.indexOf(NL)
            if (line.trim().length === 0) continue
            let message
            try {
              message = JSON.parse(line)
            } catch (parseError) {
              process.exit(3)
            }
            if (message.id === 1 && message.result && message.result.protocolVersion === 1) {
              send({ jsonrpc: '2.0', id: 2, method: 'studio/getDocument' })
            } else if (message.id === 2 && message.result && typeof message.result.revision === 'number') {
              process.exit(0)
            }
          }
        })
        send({ jsonrpc: '2.0', id: 1, method: 'studio/hello', params: { protocolVersion: 1, client: 'sim' } })
        setTimeout(() => process.exit(4), 4000)
      `
    const supervisor = new StudioCompanionSupervisor({
      store,
      spawn: () => spawnStudioCompanionProcess(process.execPath, ['-e', script]),
      maxRestarts: 0,
      onEvent: (event) => events.push(event)
    })
    cleanups.push(async () => {
      await supervisor.stop()
      await store.close()
      await fsPromises.rm(directory, { recursive: true, force: true })
    })
    supervisor.start()
    await until(() => supervisor.state === 'stopped' || supervisor.state === 'failed', 8000)
    expect(supervisor.state).toBe('stopped')
    expect(supervisor.status().lastExit).toEqual({ code: 0, signal: null })
    expect(events.some((event) => event.type === 'clean_exit')).toBe(true)
    expect(events.some((event) => event.type === 'decode_error')).toBe(false)
  }, 15000)
})
