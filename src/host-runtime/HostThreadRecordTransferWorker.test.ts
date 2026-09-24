import { fork, type ChildProcess, type Serializable } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  HostThreadRecordTransferError,
  HostThreadRecordTransferIntegrityError,
  HostThreadRecordTransferMissingError,
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer,
  removeHostThreadRecordTransfer
} from './HostThreadRecordTransfer'
import {
  HOST_THREAD_RECORD_TRANSFER_SERVICE_NAME,
  HostThreadRecordTransferWorker,
  bindHostThreadRecordTransferPort,
  configureHostThreadRecordTransferChannel,
  createHostThreadRecordTransferChannel,
  createWorkerThreadTransferChannel,
  hostThreadRecordTransferChannelFactory,
  sharedHostThreadRecordTransferWorker,
  unwrapUtilityProcessMessage,
  utilityProcessParentPort,
  type HostThreadRecordTransferChannelFactory,
  type HostThreadRecordTransferWorkerReply,
  type HostThreadRecordTransferWorkerRequest,
  type UtilityProcessChildLike,
  type UtilityProcessLike
} from './HostThreadRecordTransferWorker'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { HostProfileRecordCommandExecutor } from './HostProfileRecordCommandExecutor'
import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  type HostCommand
} from '../shared/hostProtocol'

let directory: string
let entryPath: string
let utilityShimPath: string
const workers: HostThreadRecordTransferWorker[] = []

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'checkpoint-worker-'))
  entryPath = join(directory, 'HostThreadRecordTransferWorkerEntry.cjs')
  await build({
    entryPoints: ['src/host-runtime/HostThreadRecordTransferWorkerEntry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Never executed off Electron; keep the bundle honest about that.
    external: ['electron'],
    outfile: entryPath,
    logLevel: 'silent'
  })
  // A plain Node child standing in for an Electron utility process: the same
  // `{ data }` message shape on `process.parentPort`, replies through
  // `postMessage`, and a variant that dies on its first job the way a fatal
  // V8 error would end the real child.
  utilityShimPath = join(directory, 'utility-process-shim.cjs')
  writeFileSync(
    utilityShimPath,
    [
      'process.parentPort = {',
      "  on(event, listener) { if (event === 'message') process.on('message', (data) => listener({ data })) },",
      '  postMessage(value) { process.send(value) }',
      '}',
      "if (process.env.TRANSFER_SHIM_DIE) process.on('message', () => process.exit(134))",
      'require(process.argv[2])',
      ''
    ].join('\n')
  )
})

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
})
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

function fixture(workerEntry = entryPath) {
  const profilePath = mkdtempSync(join(directory, 'profile-'))
  const worker = new HostThreadRecordTransferWorker(workerEntry)
  workers.push(worker)
  return { profilePath, worker }
}

function persistCommand(
  descriptor: { transferId: string; sha256: string; byteLength: number },
  expectedRevision: number
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: `persist:${descriptor.transferId}`,
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    name: 'thread.record.persist',
    target: { threadId: 'thread-1' },
    arguments: { ...descriptor, expectedRevision },
    issuedAt: '2026-09-20T00:00:00.000Z'
  }
}

describe('compiled thread-record transfer worker', () => {
  it('captures at dispatch, produces canonical bytes and returns the full decoded record', async () => {
    const { profilePath, worker } = fixture()
    const record = {
      appChatId: 'thread-1',
      optional: undefined,
      messages: [{ content: 'Unicode 🎉\ntext', value: NaN, nested: [null, undefined, -0] }]
    }
    const expected = Buffer.from(`${JSON.stringify(record)}\n`)
    const unrelatedSmallBuffer = Buffer.from('keep the shared Buffer pool intact')
    const pending = worker.publish({ profilePath, transferId: 'canonical', record })
    record.messages[0].content = 'caller changed after dispatch'
    const descriptor = await pending
    const syncDescriptor = publishHostThreadRecordTransfer({
      profilePath,
      transferId: 'sync',
      record: JSON.parse(expected.toString())
    })
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId))).toEqual(
      expected
    )
    expect(descriptor.sha256).toBe(syncDescriptor.sha256)
    expect(descriptor.byteLength).toBe(expected.byteLength)
    expect(unrelatedSmallBuffer.toString()).toBe('keep the shared Buffer pool intact')
    const decoded = await worker.read({ profilePath, descriptor })
    expect(decoded.record).toEqual(JSON.parse(expected.toString()))
    expect(decoded).not.toHaveProperty('body')
    expect(decoded.identity.dev).toEqual(expect.any(String))
  })

  it('preserves canonical JSON for Buffers, custom toJSON and accessors', async () => {
    const { profilePath, worker } = fixture()
    let getterCalls = 0
    const record = {
      bytes: Buffer.from([0, 127, 255]),
      custom: { toJSON: () => ({ serialized: true }) },
      get content() {
        getterCalls++
        return 'read once'
      }
    }
    const descriptor = await worker.publish({ profilePath, transferId: 'exotic', record })
    expect(getterCalls).toBe(1)
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, 'exotic'), 'utf8')).toBe(
      '{"bytes":{"type":"Buffer","data":[0,127,255]},"custom":{"serialized":true},"content":"read once"}\n'
    )
    expect((await worker.read({ profilePath, descriptor })).record).toEqual({
      bytes: { type: 'Buffer', data: [0, 127, 255] },
      custom: { serialized: true },
      content: 'read once'
    })
  })

  it('reuses one worker and close waits for all durable publications', async () => {
    const startsPath = join(directory, 'starts.txt')
    const wrapper = join(directory, 'counted-worker.cjs')
    writeFileSync(
      wrapper,
      `require('node:fs').appendFileSync(${JSON.stringify(startsPath)}, 'start\\n'); require(${JSON.stringify(entryPath)})`
    )
    const { profilePath, worker } = fixture(wrapper)
    const pending = Array.from({ length: 4 }, (_, index) =>
      worker.publish({
        profilePath,
        transferId: `queued-${index}`,
        record: { index, text: 'x'.repeat(50_000) }
      })
    )
    await worker.close()
    const descriptors = await Promise.all(pending)
    expect(readFileSync(startsPath, 'utf8')).toBe('start\n')
    for (const [index, descriptor] of descriptors.entries()) {
      expect(
        JSON.parse(
          readFileSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId), 'utf8')
        ).index
      ).toBe(index)
    }
    await expect(worker.publish({ profilePath, transferId: 'closed', record: {} })).rejects.toThrow(
      'closed'
    )
  })

  it('bounds cloned submissions while saturated calls still capture and persist immediately', async () => {
    const requestsPath = join(directory, 'bounded-requests.txt')
    const wrapper = join(directory, 'bounded-worker.cjs')
    writeFileSync(
      wrapper,
      `require('node:worker_threads').parentPort.on('message', () => require('node:fs').appendFileSync(${JSON.stringify(requestsPath)}, 'job\\n')); require(${JSON.stringify(entryPath)})`
    )
    const { profilePath, worker } = fixture(wrapper)
    const records = Array.from({ length: 6 }, (_, index) => ({ index, content: 'captured' }))
    const pending = records.map((record, index) =>
      worker.publish({ profilePath, transferId: `bounded-${index}`, record })
    )
    for (const record of records) record.content = 'later mutation'
    expect(existsSync(hostThreadRecordTransferPath(profilePath, 'bounded-5'))).toBe(true)
    const descriptors = await Promise.all(pending)
    await worker.close()
    expect(readFileSync(requestsPath, 'utf8').trim().split('\n')).toHaveLength(4)
    for (const descriptor of descriptors) {
      expect(
        JSON.parse(
          readFileSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId), 'utf8')
        ).content
      ).toBe('captured')
    }
  })

  it('preserves typed missing, digest and JSON integrity failures', async () => {
    const { profilePath, worker } = fixture()
    const descriptor = await worker.publish({ profilePath, transferId: 'bad-digest', record: {} })
    await expect(
      worker.read({ profilePath, descriptor: { ...descriptor, sha256: 'f'.repeat(64) } })
    ).rejects.toBeInstanceOf(HostThreadRecordTransferIntegrityError)
    expect(existsSync(hostThreadRecordTransferPath(profilePath, descriptor.transferId))).toBe(false)
    await expect(worker.read({ profilePath, descriptor })).rejects.toBeInstanceOf(
      HostThreadRecordTransferMissingError
    )
    const body = Buffer.from('{bad json}\n')
    const transferId = 'bad-json'
    writeFileSync(hostThreadRecordTransferPath(profilePath, transferId), body, { mode: 0o600 })
    await expect(
      worker.read({
        profilePath,
        descriptor: {
          transferId,
          byteLength: body.length,
          sha256: createHash('sha256').update(body).digest('hex')
        }
      })
    ).rejects.toBeInstanceOf(HostThreadRecordTransferIntegrityError)
    expect(existsSync(hostThreadRecordTransferPath(profilePath, transferId))).toBe(false)
  })

  it('fails outstanding jobs on worker exit and a later call starts a fresh worker', async () => {
    const wrapper = join(directory, 'crashing-worker.cjs')
    writeFileSync(wrapper, 'process.exit(7)')
    const { profilePath, worker } = fixture(wrapper)
    const failed = await Promise.allSettled([
      worker.publish({ profilePath, transferId: 'first', record: {} }),
      worker.publish({ profilePath, transferId: 'second', record: {} })
    ])
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    writeFileSync(wrapper, `require(${JSON.stringify(entryPath)})`)
    const descriptor = await worker.publish({
      profilePath,
      transferId: 'recovered',
      record: { recovered: true }
    })
    expect((await worker.read({ profilePath, descriptor })).record).toEqual({ recovered: true })
  })

  it('allows main-loop work during a large warm-worker checkpoint', async () => {
    const { profilePath, worker } = fixture()
    await worker.publish({ profilePath, transferId: 'warm', record: {} })
    const record = {
      messages: Array.from({ length: 1_500 }, (_, index) => ({
        index,
        content: 'x'.repeat(16_000)
      }))
    }
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const descriptor = await worker.publish({ profilePath, transferId: 'large', record })
      expect(descriptor.byteLength).toBeGreaterThan(24_000_000)
      expect(ticks).toBeGreaterThan(0)
      ticks = 0
      const decoded = await worker.read({ profilePath, descriptor })
      expect((decoded.record.messages as unknown[]).length).toBe(1_500)
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
    }
  })

  it('keeps full Host validation, CAS and inode-bound adoption after worker verification', async () => {
    const { profilePath, worker } = fixture()
    const store = new HostProfileDomainStore({
      profilePath,
      authority: { assertProfileAuthority: () => undefined },
      now: () => 10
    })
    const initial = {
      appChatId: 'thread-1',
      scope: 'global',
      title: 'Initial',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      runs: [],
      messages: []
    }
    store.persistThreadRecord({ threadId: 'thread-1', record: initial, expectedRevision: 0 })
    const executor = new HostProfileRecordCommandExecutor({
      profilePath,
      store,
      readTransfer: (input) => worker.read(input)
    })
    const record = { ...initial, title: 'Updated', persistenceRevision: 1 }
    const descriptor = await worker.publish({ profilePath, transferId: 'adopted', record })
    expect(await executor.execute(persistCommand(descriptor, 0))).toEqual({
      status: 'succeeded',
      resultSummary: 'thread_record_persisted'
    })
    expect(readFileSync(join(profilePath, 'chats', 'thread-1.json'), 'utf8')).toBe(
      `${JSON.stringify(record)}\n`
    )
    const stale = await worker.publish({ profilePath, transferId: 'stale', record })
    expect(await executor.execute(persistCommand(stale, 0))).toMatchObject({
      errorCode: 'thread_record_revision_conflict'
    })
    const invalid = await worker.publish({
      profilePath,
      transferId: 'invalid',
      record: { ...record, messages: 'invalid' }
    })
    expect(await executor.execute(persistCommand(invalid, 1))).toMatchObject({
      errorCode: 'thread_record_invalid'
    })

    const replace = await worker.publish({
      profilePath,
      transferId: 'replace',
      record: { ...record, persistenceRevision: 2 }
    })
    const verified = await worker.read({ profilePath, descriptor: replace })
    const replacement = `${verified.path}.replacement`
    writeFileSync(replacement, 'foreign bytes', { mode: 0o600 })
    renameSync(replacement, verified.path)
    const racingExecutor = new HostProfileRecordCommandExecutor({
      profilePath,
      store,
      readTransfer: async () => verified
    })
    expect(await racingExecutor.execute(persistCommand(replace, 1))).toMatchObject({
      errorCode: 'thread_record_persist_failed'
    })
    expect(
      removeHostThreadRecordTransfer({
        profilePath,
        transferId: replace.transferId,
        expectedIdentity: verified.identity
      })
    ).toBe(false)
    expect(readFileSync(verified.path, 'utf8')).toBe('foreign bytes')
    expect(store.getThread('thread-1')?.persistenceRevision).toBe(1)
  })
})

/** A scripted stand-in for Electron's utilityProcess: records forks, replays events. */
function scriptedUtility(spawned = true) {
  const listeners: {
    spawn: Array<() => void>
    message: Array<(message: unknown) => void>
    exit: Array<(code: number) => void>
  } = { spawn: [], message: [], exit: [] }
  const posted: unknown[] = []
  const state = { kills: 0, spawned }
  const emitSpawn = (): void => {
    state.spawned = true
    for (const listener of [...listeners.spawn]) listener()
  }
  const emitExit = (code: number): void => {
    for (const listener of [...listeners.exit]) listener(code)
  }
  const emitMessage = (message: unknown): void => {
    for (const listener of [...listeners.message]) listener(message)
  }
  const child: UtilityProcessChildLike = {
    postMessage(message) {
      posted.push(message)
    },
    on(event: 'spawn' | 'message' | 'exit', listener: (value: never) => void) {
      listeners[event].push(listener as never)
      return child
    },
    once(event: 'message' | 'exit', listener: (value: never) => void) {
      const wrapped = (value: never): void => {
        listeners[event] = listeners[event].filter((entry) => entry !== wrapped) as never
        listener(value)
      }
      listeners[event].push(wrapped as never)
      return child
    },
    kill() {
      state.kills += 1
      if (!state.spawned) return false
      queueMicrotask(() => emitExit(0))
      return true
    }
  }
  const forks: Array<{ modulePath: string; args?: string[]; options?: { serviceName?: string } }> =
    []
  const utility: UtilityProcessLike = {
    fork(modulePath, args, options) {
      forks.push({ modulePath, args, options })
      return child
    }
  }
  return { utility, forks, posted, state, emitSpawn, emitExit, emitMessage }
}

/** A real child process running the compiled entry behind the utility-port shim. */
function nodeUtility(env?: NodeJS.ProcessEnv): UtilityProcessLike & { children: ChildProcess[] } {
  const children: ChildProcess[] = []
  return {
    children,
    fork(modulePath, args = []) {
      const child = fork(utilityShimPath, [modulePath, ...args], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, ...env }
      })
      // Electron's postMessage after exit is silent; Node's send would raise.
      child.on('error', () => undefined)
      children.push(child)
      return {
        postMessage: (message) => {
          child.send(message as Serializable)
        },
        on: (event, listener) => child.on(event, listener as never),
        once: (event, listener) => child.once(event, listener as never),
        kill: () => child.kill()
      }
    }
  }
}

describe('thread-record transfer transport', () => {
  it('retains termination until a late-spawning utility child is killed and exits', async () => {
    const scripted = scriptedUtility(false)
    const channel = createHostThreadRecordTransferChannel('/entry.js', scripted.utility)
    let terminated = false
    const pending = channel.terminate().then(() => {
      terminated = true
    })
    expect(scripted.state.kills).toBe(1)
    await Promise.resolve()
    expect(terminated).toBe(false)

    scripted.emitSpawn()
    expect(scripted.state.kills).toBe(2)
    expect(terminated).toBe(false)
    await pending
    expect(terminated).toBe(true)
    await channel.terminate()
    expect(scripted.state.kills).toBe(2)
  })

  it('defaults to a worker thread and lets the embedder install a utility-process factory', async () => {
    const channel = createHostThreadRecordTransferChannel(entryPath)
    expect(channel.kind).toBe('worker-thread')
    await channel.terminate()
    expect(hostThreadRecordTransferChannelFactory()).toBe(createWorkerThreadTransferChannel)

    const scripted = scriptedUtility()
    const factory: HostThreadRecordTransferChannelFactory = (entry) =>
      createHostThreadRecordTransferChannel(entry, scripted.utility)
    try {
      configureHostThreadRecordTransferChannel(factory)
      expect(hostThreadRecordTransferChannelFactory()).toBe(factory)
      const installed = hostThreadRecordTransferChannelFactory()('/entry.js')
      expect(installed.kind).toBe('utility-process')
      expect(scripted.forks).toHaveLength(1)
      await installed.terminate()
      // Re-installing the same factory changes nothing.
      configureHostThreadRecordTransferChannel(factory)
      expect(hostThreadRecordTransferChannelFactory()).toBe(factory)
    } finally {
      configureHostThreadRecordTransferChannel(createWorkerThreadTransferChannel)
    }
    expect(hostThreadRecordTransferChannelFactory()).toBe(createWorkerThreadTransferChannel)
  })

  it('builds the process-wide off-loop worker on the configured transport', async () => {
    expect(
      sharedHostThreadRecordTransferWorker(join(directory, 'absent-entry.cjs'))
    ).toBeUndefined()
    const scripted = scriptedUtility()
    const factory: HostThreadRecordTransferChannelFactory = (entry) =>
      createHostThreadRecordTransferChannel(entry, scripted.utility)
    configureHostThreadRecordTransferChannel(factory)
    try {
      const shared = sharedHostThreadRecordTransferWorker(entryPath)
      expect(shared).toBeDefined()
      expect(sharedHostThreadRecordTransferWorker(entryPath)).toBe(shared)
      const profilePath = mkdtempSync(join(directory, 'profile-'))
      const pending = shared!.publish({
        profilePath,
        transferId: 'shared',
        record: { shared: true }
      })
      expect(scripted.forks).toEqual([
        {
          modulePath: entryPath,
          args: [],
          options: { serviceName: HOST_THREAD_RECORD_TRANSFER_SERVICE_NAME }
        }
      ])
      const [request] = scripted.posted as HostThreadRecordTransferWorkerRequest[]
      expect(request).toMatchObject({ kind: 'publish', input: { transferId: 'shared' } })
      scripted.emitMessage({
        id: request.id,
        ok: true,
        value: { transferId: 'shared', sha256: 'scripted', byteLength: 1 }
      })
      expect(await pending).toEqual({ transferId: 'shared', sha256: 'scripted', byteLength: 1 })
      // Installing the factory already in use keeps the healthy worker.
      configureHostThreadRecordTransferChannel(factory)
      expect(sharedHostThreadRecordTransferWorker(entryPath)).toBe(shared)
      expect(scripted.state.kills).toBe(0)
    } finally {
      // Re-installing the default retires the shared worker on the old transport.
      configureHostThreadRecordTransferChannel(createWorkerThreadTransferChannel)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(scripted.state.kills).toBe(1)
    const fresh = sharedHostThreadRecordTransferWorker(entryPath)
    expect(fresh).toBeDefined()
    workers.push(fresh!)
    expect(scripted.forks).toHaveLength(1)
  })

  it('forks a named utility process and maps its messages, exit and kill', async () => {
    const scripted = scriptedUtility()
    const channel = createHostThreadRecordTransferChannel('/entry.js', scripted.utility)
    expect(channel.kind).toBe('utility-process')
    expect(scripted.forks).toEqual([
      {
        modulePath: '/entry.js',
        args: [],
        options: { serviceName: HOST_THREAD_RECORD_TRANSFER_SERVICE_NAME }
      }
    ])
    const request: HostThreadRecordTransferWorkerRequest = {
      id: 1,
      kind: 'read',
      input: {
        profilePath: '/profile',
        descriptor: { transferId: 't', sha256: 'a', byteLength: 1 }
      }
    }
    const replies: HostThreadRecordTransferWorkerReply[] = []
    const exits: number[] = []
    channel.onMessage((reply) => replies.push(reply))
    channel.onExit((code) => exits.push(code))
    channel.post(request)
    expect(scripted.posted).toEqual([request])
    scripted.emitMessage({
      id: 1,
      ok: true,
      value: { transferId: 't', sha256: 'a', byteLength: 1 }
    })
    expect(replies).toEqual([
      { id: 1, ok: true, value: { transferId: 't', sha256: 'a', byteLength: 1 } }
    ])
    await channel.terminate()
    expect(scripted.state.kills).toBe(1)
    expect(exits).toEqual([0])
    await channel.terminate()
    expect(scripted.state.kills).toBe(1)

    const crashed = scriptedUtility()
    const crashedChannel = createHostThreadRecordTransferChannel('/entry.js', crashed.utility)
    crashed.emitExit(134)
    await crashedChannel.terminate()
    expect(crashed.state.kills).toBe(0)
  })

  it('serves the compiled entry through a utility-process port', async () => {
    const profilePath = mkdtempSync(join(directory, 'profile-'))
    const utility = nodeUtility()
    const worker = new HostThreadRecordTransferWorker(entryPath, (entry) =>
      createHostThreadRecordTransferChannel(entry, utility)
    )
    workers.push(worker)
    const record = {
      appChatId: 'thread-1',
      optional: undefined,
      messages: [{ content: 'Unicode 🎉\ntext', value: NaN, nested: [null, undefined, -0] }]
    }
    const expected = Buffer.from(`${JSON.stringify(record)}\n`)
    const pending = worker.publish({ profilePath, transferId: 'utility', record })
    record.messages[0].content = 'caller changed after dispatch'
    const descriptor = await pending
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, 'utility'))).toEqual(expected)
    expect(descriptor.byteLength).toBe(expected.byteLength)
    const decoded = await worker.read({ profilePath, descriptor })
    expect(decoded.record).toEqual(JSON.parse(expected.toString()))
    expect(utility.children).toHaveLength(1)
    await worker.close()
    // close() waited for the exit; a SIGTERM-killed child reports a signal, not a code.
    const [child] = utility.children
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('rejects pending jobs when the utility process dies and starts a fresh one next time', async () => {
    const profilePath = mkdtempSync(join(directory, 'profile-'))
    const dying = nodeUtility({ TRANSFER_SHIM_DIE: '1' })
    const healthy = nodeUtility()
    let attempts = 0
    const worker = new HostThreadRecordTransferWorker(entryPath, (entry) => {
      attempts += 1
      return createHostThreadRecordTransferChannel(entry, attempts === 1 ? dying : healthy)
    })
    workers.push(worker)
    const failed = await Promise.allSettled([
      worker.publish({ profilePath, transferId: 'first', record: { first: true } }),
      worker.publish({ profilePath, transferId: 'second', record: { second: true } })
    ])
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    const reason = (failed[0] as PromiseRejectedResult).reason as HostThreadRecordTransferError
    expect(reason).toBeInstanceOf(HostThreadRecordTransferError)
    expect(String(reason.cause)).toContain('134')
    // The parent is still here to try again, on a fresh process.
    const descriptor = await worker.publish({
      profilePath,
      transferId: 'recovered',
      record: { recovered: true }
    })
    expect((await worker.read({ profilePath, descriptor })).record).toEqual({ recovered: true })
    expect(attempts).toBe(2)
    expect(healthy.children).toHaveLength(1)
  })

  it('captures synchronously when the transport refuses or cannot start', async () => {
    const profilePath = mkdtempSync(join(directory, 'profile-'))
    const refusing: HostThreadRecordTransferChannelFactory = () => ({
      kind: 'utility-process',
      post: () => {
        throw new Error('message too large for the channel')
      },
      onMessage: () => undefined,
      onError: () => undefined,
      onExit: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
      terminate: async () => undefined
    })
    const refused = new HostThreadRecordTransferWorker(entryPath, refusing)
    workers.push(refused)
    const record = { captured: true }
    const descriptor = await refused.publish({ profilePath, transferId: 'refused', record })
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, 'refused'), 'utf8')).toBe(
      `${JSON.stringify(record)}\n`
    )
    expect((await refused.read({ profilePath, descriptor })).record).toEqual(record)

    const unstartable = new HostThreadRecordTransferWorker(entryPath, () => {
      throw new Error('spawn failed')
    })
    workers.push(unstartable)
    const spawned = await unstartable.publish({ profilePath, transferId: 'unstartable', record })
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, 'unstartable'), 'utf8')).toBe(
      `${JSON.stringify(record)}\n`
    )
    expect((await unstartable.read({ profilePath, descriptor: spawned })).record).toEqual(record)

    await refused.close()
    await expect(refused.publish({ profilePath, transferId: 'closed', record })).rejects.toThrow(
      'closed'
    )
  })

  it('replies with the request id on both port shapes', () => {
    const profilePath = mkdtempSync(join(directory, 'profile-'))
    const posted: HostThreadRecordTransferWorkerReply[] = []
    let deliver: ((message: unknown) => void) | undefined
    const port = {
      on: (_event: 'message', listener: (message: unknown) => void) => {
        deliver = listener
      },
      postMessage: (reply: HostThreadRecordTransferWorkerReply) => {
        posted.push(reply)
      }
    }
    const request: HostThreadRecordTransferWorkerRequest = {
      id: 7,
      kind: 'publish',
      input: { profilePath, transferId: 'shape', record: { shape: true } }
    }
    bindHostThreadRecordTransferPort(port, unwrapUtilityProcessMessage)
    deliver!({ data: request })
    expect(posted).toEqual([
      { id: 7, ok: true, value: expect.objectContaining({ transferId: 'shape' }) }
    ])
    expect(readFileSync(hostThreadRecordTransferPath(profilePath, 'shape'), 'utf8')).toBe(
      '{"shape":true}\n'
    )

    const bare: HostThreadRecordTransferWorkerReply[] = []
    let deliverBare: ((message: unknown) => void) | undefined
    bindHostThreadRecordTransferPort(
      {
        on: (_event, listener) => {
          deliverBare = listener
        },
        postMessage: (reply) => {
          bare.push(reply)
        }
      },
      (message) => message as HostThreadRecordTransferWorkerRequest
    )
    deliverBare!({ ...request, id: 8, input: { ...request.input, transferId: 'bare' } })
    expect(bare).toEqual([
      { id: 8, ok: true, value: expect.objectContaining({ transferId: 'bare' }) }
    ])

    expect(utilityProcessParentPort({ parentPort: port })).toBe(port)
    expect(utilityProcessParentPort({})).toBeUndefined()
    expect(utilityProcessParentPort({ parentPort: { on: () => undefined } })).toBeUndefined()
  })
})
