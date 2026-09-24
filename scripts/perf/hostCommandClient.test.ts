import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostAuthority } from '../../src/host-runtime/HostAuthority'
import { HostLocalServer } from '../../src/host-runtime/HostLocalServer'
import { HostSession } from '../../src/host-runtime/HostSession'
import type { HostCommand } from '../../src/shared/hostProtocol'

const require = createRequire(import.meta.url)
const { HOST_COMMAND_CLIENT_COMMANDS, hostControlActionAdapter, openHostCommandClient } =
  require('./hostCommandClient.cjs') as {
    HOST_COMMAND_CLIENT_COMMANDS: readonly string[]
    openHostCommandClient: (options: Record<string, unknown>) => Promise<Opened>
    hostControlActionAdapter: (client: Pick<Client, 'submit'>) => {
      issueControlAction: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
  }
const { runControlActionReplay } = require('./controlActionReplay.cjs') as {
  runControlActionReplay: (options: Record<string, unknown>) => Promise<{
    status: string
    actions: Array<{ seq: number; outcome: string; reason: string | null }>
  }>
}

type Client = {
  clientId: string
  submit: (spec: unknown, options?: { timeoutMs?: number }) => Promise<Record<string, unknown>>
  lookup: (commandId: unknown, options?: { timeoutMs?: number }) => Promise<Record<string, unknown>>
  close: () => void
}
type Opened = { ok: true; client: Client } | { ok: false; reason: string }

const TOKEN = 'tok-' + 'f'.repeat(40)
const DISCOVERY = { socketPath: '/virtual/host.sock', tokenPath: '/virtual/host.token' }
const tokenFs = (token = TOKEN) => ({ readFileSync: () => `${token}\n` })

/** A scripted Host socket: records written frames; the test answers them. */
function fakeHost(options: { grant?: string[]; autoWelcome?: boolean } = {}) {
  const socket = new EventEmitter() as EventEmitter & {
    write: (data: string) => boolean
    destroy: () => void
    destroyed: boolean
  }
  const written: Array<Record<string, unknown>> = []
  socket.destroyed = false
  socket.write = (data: string) => {
    for (const line of data.split('\n').filter(Boolean)) {
      const frame = JSON.parse(line) as Record<string, unknown>
      written.push(frame)
      if (frame.type === 'hello' && options.autoWelcome !== false) {
        queueMicrotask(() =>
          send({
            type: 'welcome',
            transportVersion: 1,
            welcome: { capabilities: options.grant ?? ['bootstrap', 'commands', 'receipts'] }
          })
        )
      }
    }
    return true
  }
  socket.destroy = () => {
    if (socket.destroyed) return
    socket.destroyed = true
    queueMicrotask(() => socket.emit('close'))
  }
  const send = (frame: unknown) => socket.emit('data', `${JSON.stringify(frame)}\n`)
  const connect = vi.fn(() => {
    queueMicrotask(() => socket.emit('connect'))
    return socket
  })
  const requests = () => written.filter((frame) => frame.type === 'request')
  const receiptFor = (request: Record<string, unknown>, status = 'succeeded') => {
    const command = request.params as Record<string, unknown>
    return {
      type: 'host.receipt',
      protocolVersion: 2,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      name: command.name,
      actor: command.actor,
      authority: { decision: 'allow' },
      status
    }
  }
  return { socket, written, send, connect, requests, receiptFor }
}

function clock(...values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

async function open(host: ReturnType<typeof fakeHost>, extra: Record<string, unknown> = {}) {
  const opened = await openHostCommandClient({
    discovery: DISCOVERY,
    fs: tokenFs(),
    connect: host.connect,
    clientId: 'taskwraith-perf-command-client-t1',
    ...extra
  })
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`)
  return opened.client
}

describe('openHostCommandClient', () => {
  it('refuses any class but test before touching the token or the socket', async () => {
    const readFileSync = vi.fn(() => TOKEN)
    const connect = vi.fn()
    for (const clientClass of ['desktop', 'tui', 'ios', 'host-cli']) {
      await expect(
        openHostCommandClient({ discovery: DISCOVERY, clientClass, fs: { readFileSync }, connect })
      ).resolves.toEqual({ ok: false, reason: 'host_client_class_refused' })
    }
    expect(readFileSync).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('says hello as a test client with the command capabilities, and nothing else', async () => {
    const host = fakeHost()
    const client = await open(host)
    expect(host.written).toEqual([
      {
        type: 'hello',
        transportVersion: 1,
        token: TOKEN,
        hello: {
          type: 'host.hello',
          protocolVersion: 2,
          projectionVersion: 2,
          client: {
            clientId: 'taskwraith-perf-command-client-t1',
            clientClass: 'test',
            clientVersion: '1.0.0'
          },
          capabilities: ['bootstrap', 'commands', 'receipts']
        }
      }
    ])
    expect(client.clientId).toBe('taskwraith-perf-command-client-t1')
    expect(JSON.stringify(Object.keys(client))).not.toContain(TOKEN)
    client.close()
  })

  it.each([
    ['a Host that grants no commands', { grant: ['bootstrap'] }, 'host_commands_not_granted'],
    [
      'a Host that grants no receipts',
      { grant: ['bootstrap', 'commands'] },
      'host_commands_not_granted'
    ]
  ])('refuses %s', async (_label, hostOptions, reason) => {
    const host = fakeHost(hostOptions)
    await expect(
      openHostCommandClient({ discovery: DISCOVERY, fs: tokenFs(), connect: host.connect })
    ).resolves.toEqual({ ok: false, reason })
    expect(host.socket.destroyed).toBe(true)
  })

  it('reports each opening failure as a bounded code that never carries the token', async () => {
    const refusing = fakeHost({ autoWelcome: false })
    const refused = openHostCommandClient({
      discovery: DISCOVERY,
      fs: tokenFs(),
      connect: refusing.connect
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    refusing.send({
      type: 'response',
      transportVersion: 1,
      id: '',
      ok: false,
      error: { code: 'unauthorized' }
    })
    const silent = fakeHost({ autoWelcome: false })
    const results = await Promise.all([
      refused,
      openHostCommandClient({
        discovery: DISCOVERY,
        fs: tokenFs(),
        connect: silent.connect,
        timeoutMs: 20
      }),
      openHostCommandClient({
        discovery: DISCOVERY,
        fs: {
          readFileSync: () => {
            throw Object.assign(new Error(`ENOENT ${TOKEN}`), { code: 'ENOENT' })
          }
        }
      }),
      openHostCommandClient({ discovery: DISCOVERY, fs: tokenFs('  ') }),
      openHostCommandClient({ discovery: { socketPath: '' }, fs: tokenFs() }),
      openHostCommandClient({ discovery: DISCOVERY, fs: tokenFs(), clientId: 'Upper Case' }),
      openHostCommandClient({
        discovery: DISCOVERY,
        fs: tokenFs(),
        connect: () => {
          throw new Error(`connect failed with ${TOKEN}`)
        }
      })
    ])
    expect(results).toEqual([
      { ok: false, reason: 'host_hello_refused' },
      { ok: false, reason: 'host_welcome_timeout' },
      { ok: false, reason: 'host_token_unreadable: ENOENT' },
      { ok: false, reason: 'host_token_empty' },
      { ok: false, reason: 'host_client_invalid_input' },
      { ok: false, reason: 'host_client_invalid_input' },
      { ok: false, reason: 'host_socket_connect_failed' }
    ])
    expect(JSON.stringify(results)).not.toContain(TOKEN)
  })
})

describe('HostCommandClient.submit', () => {
  it('sends the command as its own test actor and times it to the decoded receipt', async () => {
    const host = fakeHost()
    const client = await open(host, { nowMs: clock(100, 142) })
    const submitted = client.submit({
      name: 'run.cancel',
      target: { threadId: 'thread-1' },
      arguments: { expectedWorkId: 'run-1' }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [request] = host.requests()
    const command = request.params as HostCommand
    expect(request).toMatchObject({ type: 'request', transportVersion: 1, kind: 'command.submit' })
    expect(command).toMatchObject({
      type: 'host.command',
      protocolVersion: 2,
      name: 'run.cancel',
      target: { threadId: 'thread-1' },
      arguments: { expectedWorkId: 'run-1' },
      actor: {
        actorId: 'taskwraith-perf-command-client-t1',
        clientId: 'taskwraith-perf-command-client-t1',
        clientClass: 'test'
      }
    })
    expect(command.idempotencyKey).toBe(command.commandId)
    expect(command.commandId.startsWith('taskwraith-perf-command-client-t1-')).toBe(true)
    host.send({
      type: 'response',
      transportVersion: 1,
      id: request.id,
      ok: true,
      result: { kind: 'command.submit', receipt: host.receiptFor(request) }
    })
    const result = await submitted
    expect(result).toEqual({
      ok: true,
      commandId: command.commandId,
      status: 'succeeded',
      authority: 'allow',
      elapsedMs: 42
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    client.close()
  })

  it('refuses a command the harness does not schedule, without writing it', async () => {
    const host = fakeHost()
    const client = await open(host)
    expect(HOST_COMMAND_CLIENT_COMMANDS).toEqual(['composer.send', 'run.cancel'])
    for (const spec of [
      { name: 'thread.record.persist', target: { threadId: 't' }, arguments: {} },
      { name: 'run.cancel', target: 'thread-1' },
      { name: 'composer.send', target: { threadId: 't' }, arguments: ['text'] },
      null
    ]) {
      await expect(client.submit(spec)).resolves.toEqual({
        ok: false,
        reason: 'host_command_refused',
        elapsedMs: 0
      })
    }
    expect(host.requests()).toEqual([])
    client.close()
  })

  it('reads a refusal as a bounded code and a mismatched receipt as invalid', async () => {
    const host = fakeHost()
    const client = await open(host)
    const refused = client.submit({ name: 'run.cancel', target: { threadId: 't' }, arguments: {} })
    const mismatched = client.submit({
      name: 'composer.send',
      target: { threadId: 't' },
      arguments: { text: 'go' }
    })
    const unknownStatus = client.submit({
      name: 'run.cancel',
      target: { threadId: 't' },
      arguments: {}
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [first, second, third] = host.requests()
    host.send({
      type: 'response',
      transportVersion: 1,
      id: first.id,
      ok: false,
      error: { code: 'unauthorized', message: `leaked ${TOKEN}` }
    })
    host.send({
      type: 'response',
      transportVersion: 1,
      id: second.id,
      ok: true,
      result: {
        kind: 'command.submit',
        receipt: { ...host.receiptFor(second), commandId: 'other' }
      }
    })
    await expect(refused).resolves.toMatchObject({
      ok: false,
      reason: 'host_request_refused: unauthorized'
    })
    host.send({
      type: 'response',
      transportVersion: 1,
      id: third.id,
      ok: true,
      result: { kind: 'command.submit', receipt: host.receiptFor(third, 'accepted') }
    })
    await expect(mismatched).resolves.toMatchObject({ ok: false, reason: 'host_response_invalid' })
    await expect(unknownStatus).resolves.toMatchObject({
      ok: false,
      reason: 'host_response_invalid'
    })
    expect(JSON.stringify(await refused)).not.toContain(TOKEN)
    client.close()
  })

  it('says a timed-out or orphaned command may still land', async () => {
    const host = fakeHost()
    const client = await open(host)
    const timedOut = await client.submit(
      { name: 'run.cancel', target: { threadId: 't' }, arguments: {} },
      { timeoutMs: 5 }
    )
    expect(timedOut).toMatchObject({
      ok: false,
      reason: 'host_request_timeout',
      effectMayLand: true
    })
    const orphaned = client.submit({ name: 'run.cancel', target: { threadId: 't' }, arguments: {} })
    const lookup = client.lookup(String(timedOut.commandId))
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.socket.emit('close')
    await expect(orphaned).resolves.toMatchObject({
      ok: false,
      reason: 'host_socket_closed',
      effectMayLand: true
    })
    const lookupResult = await lookup
    expect(lookupResult).toMatchObject({ ok: false, reason: 'host_socket_closed' })
    expect(lookupResult).not.toHaveProperty('effectMayLand')
    await expect(
      client.submit({ name: 'run.cancel', target: { threadId: 't' }, arguments: {} })
    ).resolves.toMatchObject({ ok: false, reason: 'host_socket_closed' })
  })

  it('closes on a malformed frame and settles what was pending', async () => {
    const host = fakeHost()
    const client = await open(host)
    const pending = client.submit({ name: 'run.cancel', target: { threadId: 't' }, arguments: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    host.socket.emit('data', `{not json ${TOKEN}\n`)
    const result = await pending
    expect(result).toMatchObject({ ok: false, reason: 'host_frame_malformed' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(host.socket.destroyed).toBe(true)
  })

  it('reassembles frames split across chunks and several frames in one chunk', async () => {
    const host = fakeHost()
    const client = await open(host)
    const first = client.submit({ name: 'run.cancel', target: { threadId: 'a' }, arguments: {} })
    const second = client.submit({ name: 'run.cancel', target: { threadId: 'b' }, arguments: {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [one, two] = host.requests()
    const response = (request: Record<string, unknown>) =>
      JSON.stringify({
        type: 'response',
        transportVersion: 1,
        id: request.id,
        ok: true,
        result: { kind: 'command.submit', receipt: host.receiptFor(request, 'pending') }
      })
    const both = `${response(two)}\n${response(one)}\n`
    host.socket.emit('data', both.slice(0, 17))
    host.socket.emit('data', both.slice(17))
    await expect(first).resolves.toMatchObject({ ok: true, status: 'pending' })
    await expect(second).resolves.toMatchObject({ ok: true, status: 'pending' })
    client.close()
  })

  it('looks up only receipts it submitted', async () => {
    const host = fakeHost()
    const client = await open(host)
    await expect(client.lookup('someone-elses-command')).resolves.toEqual({
      ok: false,
      reason: 'host_lookup_refused',
      elapsedMs: 0
    })
    expect(host.requests()).toEqual([])
    client.close()
  })
})

describe('HostCommandClient against the real local server', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!()
  })

  it('binds as its own test actor and round-trips a submit and a lookup', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'perf-host-command-client-'))
    const submitted: HostCommand[] = []
    const receiptOf = (command: HostCommand, status: string) => ({
      type: 'host.receipt',
      protocolVersion: 2,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      name: command.name,
      actor: command.actor,
      authority: { decision: 'allow' },
      status,
      commandFingerprint: 'a'.repeat(64),
      generation: 1,
      cursor: 0,
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:00.000Z'
    })
    const server = new HostLocalServer({
      userDataPath: profile,
      hostId: 'perf-command-client-host',
      hostVersion: 'node-host-v1',
      session: new HostSession({
        host: { hostId: 'perf-command-client-host', hostVersion: 'node-host-v1' },
        runtime: { getPosition: () => ({ generation: 1, cursor: 0 }) },
        hostCapabilityOffer: ['bootstrap', 'commands', 'receipts', 'health']
      }),
      authority: {
        command: vi.fn(async (context: { actor: unknown }, command: HostCommand) => {
          submitted.push(command)
          expect(context.actor).toEqual(command.actor)
          return { ok: true, value: receiptOf(command, 'pending') }
        }),
        receipt: vi.fn(async (_context: unknown, lookup: { commandId?: string }) => {
          const command = submitted.find((entry) => entry.commandId === lookup.commandId)
          return command
            ? { ok: true, outcome: 'found', receipt: receiptOf(command, 'succeeded') }
            : { ok: true, outcome: 'not_found' }
        })
      } as unknown as HostAuthority
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      rmSync(profile, { recursive: true, force: true })
    })

    const opened = await openHostCommandClient({
      discovery: { socketPath: server.socketPath, tokenPath: server.tokenPath }
    })
    if (!opened.ok) throw new Error(`open failed: ${opened.reason}`)
    cleanups.push(() => opened.client.close())
    const send = await opened.client.submit({
      name: 'composer.send',
      target: { threadId: 'thread-7' },
      arguments: { text: 'next turn' }
    })
    expect(send).toMatchObject({ ok: true, status: 'pending', authority: 'allow' })
    expect(submitted).toHaveLength(1)
    expect(submitted[0].actor).toEqual({
      actorId: opened.client.clientId,
      clientId: opened.client.clientId,
      clientClass: 'test'
    })
    await expect(opened.client.lookup(String(send.commandId))).resolves.toMatchObject({
      ok: true,
      commandId: send.commandId,
      status: 'succeeded'
    })
  })
})

describe('hostControlActionAdapter', () => {
  it('turns a scheduled cancel into run.cancel on the chat’s thread, through the replay driver', async () => {
    const submit = vi.fn(async (spec: { arguments: Record<string, unknown> }) =>
      spec.arguments.expectedWorkId === 'run-late'
        ? { ok: true, commandId: 'c2', status: 'pending', authority: 'allow', elapsedMs: 3 }
        : { ok: true, commandId: 'c1', status: 'succeeded', authority: 'allow', elapsedMs: 3 }
    )
    const result = await runControlActionReplay({
      api: hostControlActionAdapter({ submit } as unknown as Client),
      schedule: [
        {
          seq: 1,
          action: 'cancel',
          target: { chatId: 'chat-light' },
          args: { expectedWorkId: 'run-1' }
        },
        { seq: 2, action: 'cancel', target: { chatId: 'chat-light' } },
        {
          seq: 3,
          action: 'cancel',
          target: { chatId: 'chat-light' },
          args: { expectedWorkId: 'run-late' }
        },
        { seq: 4, action: 'approval_decision', target: { chatId: 'chat-light' } }
      ]
    })
    expect(submit.mock.calls.map(([spec]) => spec)).toEqual([
      {
        name: 'run.cancel',
        target: { threadId: 'chat-light' },
        arguments: { expectedWorkId: 'run-1' }
      },
      { name: 'run.cancel', target: { threadId: 'chat-light' }, arguments: {} },
      {
        name: 'run.cancel',
        target: { threadId: 'chat-light' },
        arguments: { expectedWorkId: 'run-late' }
      }
    ])
    expect(result.actions.map(({ seq, outcome, reason }) => [seq, outcome, reason])).toEqual([
      [1, 'completed', null],
      [2, 'completed', null],
      [3, 'failed', 'host_receipt_pending'],
      [4, 'unsupported', 'host_command_client_action_unsupported']
    ])
  })

  it('reports a request that never reached a receipt as failed with its reason', async () => {
    const adapter = hostControlActionAdapter({
      submit: async () => ({ ok: false, reason: 'host_request_timeout', effectMayLand: true })
    } as unknown as Client)
    await expect(
      adapter.issueControlAction({ seq: 1, action: 'cancel', target: { chatId: 'c' } })
    ).resolves.toEqual({ ok: false, reason: 'host_request_timeout' })
  })
})
