import { describe, expect, it, vi } from 'vitest'
import {
  createThreadMessageToolExecutors,
  isThreadMessageMcpToolName,
  type ThreadMessageTargetChat,
  type ThreadMessageToolDeps
} from './ThreadMessageToolExecutors'
import type { ThreadMessageGateDecision } from '../ThreadMessagePermission'
import type { ThreadMessageEvent } from '../../shared/threadMessage'

const CALLER: ThreadMessageTargetChat = {
  chatId: 'chat-a',
  title: 'Provider ToS audit',
  workspaceId: 'ws-1',
  archived: false
}

const TARGET: ThreadMessageTargetChat = {
  chatId: 'chat-b',
  title: 'Byte pin fix',
  workspaceId: 'ws-1',
  archived: false
}

const ALLOW: ThreadMessageGateDecision = {
  verdict: 'allow',
  reason: 'service-granted',
  ledgerRequired: true
}

function harness(overrides: Partial<ThreadMessageToolDeps> = {}) {
  const enqueued: ThreadMessageEvent[] = []
  const notified: ThreadMessageEvent[] = []
  const gate = vi.fn(async () => ALLOW)
  const deps: ThreadMessageToolDeps = {
    listTargetChats: () => [CALLER, TARGET],
    resolveCallerChat: () => CALLER,
    resolveThreadMessageAccess: gate,
    enqueueThreadMessage: (event) => {
      enqueued.push(event)
      return { outcome: 'accepted' as const }
    },
    mintThreadMessageId: (from, to, nonce) => `thread-msg-${from}-${to}-${nonce}`,
    now: () => 1_700_000_000_000,
    notifyThreadMessageQueued: (event) => notified.push(event),
    ...overrides
  }
  return {
    executors: createThreadMessageToolExecutors(deps),
    enqueued,
    notified,
    gate
  }
}

async function send(args: Record<string, unknown>, overrides: Partial<ThreadMessageToolDeps> = {}) {
  const bench = harness(overrides)
  const result = await bench.executors.executeThreadMessageTool(
    'thread_message',
    args,
    { appChatId: 'chat-a', appRunId: 'run-1', workspacePath: '/repo' },
    'claude'
  )
  return { ...bench, result, payload: result.structuredContent as Record<string, unknown> }
}

describe('isThreadMessageMcpToolName', () => {
  it('recognises only the thread-message tool', () => {
    expect(isThreadMessageMcpToolName('thread_message')).toBe(true)
    expect(isThreadMessageMcpToolName('ensemble_send')).toBe(false)
  })
})

describe('thread_message — sending', () => {
  it('queues a message to a resolved target and reports the outcome', async () => {
    const { payload, enqueued, notified } = await send({
      to: 'chat-b',
      message: 'The byte pin is red on master.'
    })
    expect(payload.queued).toBe(true)
    expect(payload.outcome).toBe('accepted')
    expect(payload.toChatId).toBe('chat-b')
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].body).toBe('The byte pin is red on master.')
    expect(notified).toHaveLength(1)
  })

  it('resolves a target by exact title', async () => {
    const { payload } = await send({ to: 'Byte pin fix', message: 'hello' })
    expect(payload.toChatId).toBe('chat-b')
  })

  // Guessing between candidates would send a message to a thread the caller did
  // not mean, which is unrecoverable once it is in another seat's context.
  it('refuses an ambiguous title and returns the candidate ids', async () => {
    const twin = { ...TARGET, chatId: 'chat-c' }
    const { result, payload, enqueued } = await send(
      { to: 'Byte pin fix', message: 'hello' },
      { listTargetChats: () => [CALLER, TARGET, twin] }
    )
    expect(result.isError).toBe(true)
    expect(String(payload.error)).toContain('matches 2 threads')
    expect(payload.candidates).toHaveLength(2)
    expect(enqueued).toHaveLength(0)
  })

  it('refuses an unknown target without queueing anything', async () => {
    const { result, enqueued } = await send({ to: 'nope', message: 'hello' })
    expect(result.isError).toBe(true)
    expect(enqueued).toHaveLength(0)
  })

  it.each([
    ['no target', { message: 'hello' }],
    ['no message', { to: 'chat-b' }],
    ['a blank message', { to: 'chat-b', message: '   ' }]
  ])('refuses a call with %s', async (_label, args) => {
    const { result, enqueued } = await send(args)
    expect(result.isError).toBe(true)
    expect(enqueued).toHaveLength(0)
  })

  // The caller's own thread is excluded from resolution, so a self-send cannot
  // even be addressed — the shared model refuses it too, as a second line.
  it('cannot address its own thread', async () => {
    const { result, enqueued } = await send({ to: 'chat-a', message: 'hello' })
    expect(result.isError).toBe(true)
    expect(enqueued).toHaveLength(0)
  })

  it('refuses to send from an unaddressable chat', async () => {
    const { result, enqueued } = await send(
      { to: 'chat-b', message: 'hello' },
      { resolveCallerChat: () => null }
    )
    expect(result.isError).toBe(true)
    expect(enqueued).toHaveLength(0)
  })
})

describe('thread_message — authority the caller cannot claim', () => {
  // A tool call is never a user-composed message. If a caller could set this it
  // would take the ungated user path in the gate.
  it('always marks the message as agent-authored, even when asked not to', async () => {
    const { enqueued } = await send({
      to: 'chat-b',
      message: 'hello',
      origin: 'user',
      trust: 'operator'
    })
    expect(enqueued[0].origin).toBe('agent')
    expect(enqueued[0].trust).toBe('untrusted-thread-message')
  })

  // The sender label is what the recipient sees. Taking it from arguments would
  // let a caller present itself as a thread the user trusts more.
  it('takes the sender title from the store, not from arguments', async () => {
    const { enqueued } = await send({
      to: 'chat-b',
      message: 'hello',
      fromChatTitle: 'Security Team (verified)'
    })
    expect(enqueued[0].fromChatTitle).toBe('Provider ToS audit')
  })

  it('takes the sender chat id from the caller context, not from arguments', async () => {
    const { enqueued } = await send({
      to: 'chat-b',
      message: 'hello',
      fromChatId: 'chat-elsewhere'
    })
    expect(enqueued[0].fromChatId).toBe('chat-a')
  })
})

describe('thread_message — the gate', () => {
  it('passes queue delivery and same-workspace scope to the gate', async () => {
    const { gate } = await send({ to: 'chat-b', message: 'hello' })
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({
        crossWorkspace: false,
        requestedDelivery: 'queue',
        fromChatId: 'chat-a',
        toChatId: 'chat-b'
      })
    )
  })

  it('reports a wake request to the gate rather than acting on it', async () => {
    const { gate } = await send({ to: 'chat-b', message: 'hello', wake: true })
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ requestedDelivery: 'wake' }))
  })

  it.each([
    ['a different workspace', { ...TARGET, workspaceId: 'ws-2' }],
    ['an unscoped target', { ...TARGET, workspaceId: null }]
  ])('treats %s as cross-workspace', async (_label, target) => {
    const { gate } = await send(
      { to: 'chat-b', message: 'hello' },
      { listTargetChats: () => [CALLER, target as ThreadMessageTargetChat] }
    )
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ crossWorkspace: true }))
  })

  it('treats an unscoped CALLER as cross-workspace too', async () => {
    const { gate } = await send(
      { to: 'chat-b', message: 'hello' },
      { resolveCallerChat: () => ({ ...CALLER, workspaceId: null }) }
    )
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ crossWorkspace: true }))
  })

  it.each([
    ['prompt', 'cross-workspace'],
    ['deny', 'service-denied']
  ] as const)('queues nothing when the gate returns %s', async (verdict, reason) => {
    const { payload, enqueued, notified } = await send(
      { to: 'chat-b', message: 'hello' },
      {
        resolveThreadMessageAccess: async () => ({
          verdict,
          reason,
          ledgerRequired: false
        })
      }
    )
    expect(payload.queued).toBe(false)
    expect(payload.blocked).toBe(true)
    expect(payload.reason).toBe(reason)
    expect(enqueued).toHaveLength(0)
    expect(notified).toHaveLength(0)
  })

  it('gates BEFORE building or storing anything', async () => {
    const order: string[] = []
    await send(
      { to: 'chat-b', message: 'hello' },
      {
        resolveThreadMessageAccess: async () => {
          order.push('gate')
          return ALLOW
        },
        enqueueThreadMessage: () => {
          order.push('enqueue')
          return { outcome: 'accepted' as const }
        }
      }
    )
    expect(order).toEqual(['gate', 'enqueue'])
  })
})

describe('thread_message — idempotency and outcomes', () => {
  it('uses an explicit idempotency key so a retry cannot double-send', async () => {
    const first = await send({ to: 'chat-b', message: 'hello', idempotencyKey: 'k1' })
    const second = await send({ to: 'chat-b', message: 'hello', idempotencyKey: 'k1' })
    expect(first.enqueued[0].id).toBe(second.enqueued[0].id)
  })

  it('gives two un-keyed sends distinct ids', async () => {
    const first = await send({ to: 'chat-b', message: 'a' })
    const second = await send({ to: 'chat-b', message: 'b', idempotencyKey: 'explicit' })
    expect(first.enqueued[0].id).not.toBe(second.enqueued[0].id)
  })

  // A caller that cannot tell "wrong id" from "queue is full" retries the wrong
  // thing, so each store outcome gets its own actionable line.
  it.each([
    ['duplicate', 'already queued'],
    ['already-delivered', 'already delivered'],
    ['inbox-full', 'inbox is full'],
    ['unknown-target', 'No such thread']
  ] as const)('explains the %s outcome', async (outcome, expected) => {
    const { payload } = await send(
      { to: 'chat-b', message: 'hello' },
      { enqueueThreadMessage: () => ({ outcome }) }
    )
    expect(payload.queued).toBe(false)
    expect(payload.outcome).toBe(outcome)
    expect(String(payload.message)).toContain(expected)
    expect(payload.ok).toBe(true)
  })

  it('does not notify the target when the enqueue was refused', async () => {
    const { notified } = await send(
      { to: 'chat-b', message: 'hello' },
      { enqueueThreadMessage: () => ({ outcome: 'inbox-full' as const }) }
    )
    expect(notified).toHaveLength(0)
  })

  it('flags a clamped body so the sender knows it was cut', async () => {
    const { payload } = await send({ to: 'chat-b', message: 'z'.repeat(13_000) })
    expect(payload.truncated).toBe(true)
  })
})

describe('thread_message — failure handling', () => {
  it('returns a tool error rather than throwing when a dep fails', async () => {
    const { result } = await send(
      { to: 'chat-b', message: 'hello' },
      {
        enqueueThreadMessage: () => {
          throw new Error('ledger is frozen for deletion')
        }
      }
    )
    expect(result.isError).toBe(true)
    expect(String((result.structuredContent as Record<string, unknown>).error)).toContain(
      'ledger is frozen'
    )
  })

  // A missing dispatch branch must not read as a delivered message.
  it('errors on an unknown tool name instead of returning empty success', async () => {
    const { executors } = harness()
    const result = await executors.executeThreadMessageTool(
      'thread_message_unknown' as 'thread_message',
      {},
      {},
      'claude'
    )
    expect(result.isError).toBe(true)
  })
})
