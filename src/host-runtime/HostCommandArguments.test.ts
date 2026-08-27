import { describe, expect, it } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  HOST_THREAD_RECORD_TRANSFER_MAX_BYTES,
  type HostCommand,
  type HostCommandName
} from '../shared/hostProtocol'
import {
  HOST_COMPOSER_SEND_MODEL_MAX_CHARS,
  HOST_COMPOSER_SEND_REASONING_EFFORT_MAX_CHARS,
  HOST_COMPOSER_SEND_TEXT_MAX_CHARS,
  validateHostCommandArguments
} from './HostCommandArguments'

const names: readonly HostCommandName[] = [
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'composer.send',
  'run.cancel',
  'question.answer',
  'approval.decide',
  'ensemble.seat.toggle',
  'thread.record.persist',
  'channel.member.revoke',
  'channel.close',
  'thread.select',
  'workspace.register',
  'thread.create',
  'thread.configure',
  'thread.archive',
  'provider.auth.begin',
  'provider.auth.cancel',
  'ping'
]

const actor = {
  actorId: 'actor-id',
  clientId: 'client-id',
  clientClass: 'desktop' as const
}

function command(
  name: HostCommandName,
  target: Record<string, string> = {},
  args: Record<string, unknown> = {},
  overrides: Partial<HostCommand> = {}
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'command-id',
    idempotencyKey: 'idempotency-key',
    actor,
    name,
    target,
    arguments: args,
    issuedAt: '2026-08-03T20:00:00.000Z',
    ...overrides
  }
}

function validShape(name: HostCommandName): {
  target: Record<string, string>
  args: Record<string, unknown>
} {
  switch (name) {
    case 'snapshot.get':
    case 'ping':
      return { target: {}, args: {} }
    case 'deltas.since':
      return { target: {}, args: { generation: 1, cursor: 0 } }
    case 'receipt.lookup':
      return { target: { commandId: 'command-id' }, args: {} }
    case 'composer.send':
      return { target: { threadId: 'thread-id' }, args: { text: 'hello' } }
    case 'run.cancel':
    case 'thread.select':
      return { target: { threadId: 'thread-id' }, args: {} }
    case 'ensemble.seat.toggle':
      return {
        target: { threadId: 'thread-id' },
        args: { participantId: 'participant-id', enabled: true }
      }
    case 'thread.record.persist':
      return {
        target: { threadId: 'thread-id' },
        args: {
          transferId: '11111111-1111-4111-8111-111111111111',
          sha256: 'a'.repeat(64),
          byteLength: 512 * 1024,
          expectedRevision: 7
        }
      }
    case 'channel.member.revoke':
      return { target: { channelId: 'channel-id' }, args: { memberId: 'member-id' } }
    case 'channel.close':
      return { target: { channelId: 'channel-id' }, args: {} }
    case 'question.answer':
      return {
        target: { questionId: 'question-id' },
        args: { decision: 'answer', answer: 'yes' }
      }
    case 'approval.decide':
      return {
        target: { approvalId: 'approval-id' },
        args: { decision: 'accept' }
      }
    case 'workspace.register':
      return { target: {}, args: { path: '/workspace' } }
    case 'thread.create':
      return { target: {}, args: { scope: 'global', title: 'New thread' } }
    case 'thread.configure':
      return {
        target: { threadId: 'thread-id' },
        args: {
          providerId: 'provider-id',
          modelId: 'model-id',
          postureId: 'posture-id',
          offerRevision: 'offer-revision'
        }
      }
    case 'thread.archive':
      return { target: { threadId: 'thread-id' }, args: { archived: true } }
    case 'provider.auth.begin':
      return { target: { providerId: 'provider-id' }, args: { flowId: 'flow-id' } }
    case 'provider.auth.cancel':
      return {
        target: { providerId: 'provider-id', operationId: 'operation-id' },
        args: {}
      }
  }
}

describe('validateHostCommandArguments', () => {
  it('accepts a canonical shape for every HostCommandName', () => {
    for (const name of names) {
      const shape = validShape(name)
      const result = validateHostCommandArguments(command(name, shape.target, shape.args))
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.value.name).toBe(name)
      expect(result.value.commandId).toBe('command-id')
      expect(result.value.idempotencyKey).toBe('idempotency-key')
      expect(result.value.actor).toEqual(actor)
      expect(result.value.target).toEqual(shape.target)
    }
  })

  it('preserves actor identity without reminting', () => {
    const input = command(
      'composer.send',
      { threadId: 'thread-id' },
      { text: 'hello' },
      {
        actor: { actorId: 'paired-ios-actor', clientId: 'ios-client', clientClass: 'ios' },
        commandId: 'keep-command-id',
        idempotencyKey: 'desktop:client:uuid-keep'
      }
    )
    const result = validateHostCommandArguments(input)
    expect(result).toEqual({
      ok: true,
      value: {
        type: 'host.command',
        protocolVersion: HOST_PROTOCOL_VERSION,
        commandId: 'keep-command-id',
        idempotencyKey: 'desktop:client:uuid-keep',
        actor: { actorId: 'paired-ios-actor', clientId: 'ios-client', clientClass: 'ios' },
        name: 'composer.send',
        target: { threadId: 'thread-id' },
        arguments: { text: 'hello' },
        issuedAt: '2026-08-03T20:00:00.000Z'
      }
    })
  })

  it('composer.send allows only optional model/reasoningEffort and rejects wideners', () => {
    const ok = validateHostCommandArguments(
      command(
        'composer.send',
        { threadId: 'thread-id' },
        { text: 'hello', model: 'gpt-5.6', reasoningEffort: 'high' }
      )
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.value.arguments).toEqual({
        text: 'hello',
        model: 'gpt-5.6',
        reasoningEffort: 'high'
      })
    }

    expect(
      validateHostCommandArguments(
        command('composer.send', { threadId: 'thread-id' }, { text: 'hello', yolo: true })
      )
    ).toEqual({ ok: false, error: 'composer.send has unknown argument keys' })

    expect(
      validateHostCommandArguments(
        command('composer.send', { threadId: 'thread-id', extra: 'x' }, { text: 'hello' })
      )
    ).toEqual({ ok: false, error: 'composer.send target must be exactly { threadId }' })

    expect(
      validateHostCommandArguments(
        command('composer.send', { threadId: 'thread-id' }, { text: '   ' })
      )
    ).toEqual({ ok: false, error: 'composer.send text is required and bounded' })

    expect(
      validateHostCommandArguments(
        command(
          'composer.send',
          { threadId: 'thread-id' },
          { text: 'hello', model: 'm'.repeat(HOST_COMPOSER_SEND_MODEL_MAX_CHARS + 1) }
        )
      )
    ).toEqual({ ok: false, error: 'composer.send model must be a bounded string' })

    expect(
      validateHostCommandArguments(
        command(
          'composer.send',
          { threadId: 'thread-id' },
          {
            text: 'hello',
            reasoningEffort: 'r'.repeat(HOST_COMPOSER_SEND_REASONING_EFFORT_MAX_CHARS + 1)
          }
        )
      )
    ).toEqual({ ok: false, error: 'composer.send reasoningEffort must be a bounded string' })

    expect(HOST_COMPOSER_SEND_TEXT_MAX_CHARS).toBe(12_000)
  })

  it('run.cancel and thread.select require exact threadId and empty arguments', () => {
    for (const name of ['run.cancel', 'thread.select'] as const) {
      expect(validateHostCommandArguments(command(name, { threadId: 't' }, {})).ok).toBe(true)
      expect(
        validateHostCommandArguments(command(name, { threadId: 't' }, { force: true }))
      ).toEqual({
        ok: false,
        error: `${name} arguments must be empty`
      })
      expect(validateHostCommandArguments(command(name, {}, {}))).toEqual({
        ok: false,
        error: `${name} target must be exactly { threadId }`
      })
    }
  })

  it('accepts only the closed setup command shapes', () => {
    expect(
      validateHostCommandArguments(
        command(
          'workspace.register',
          {},
          { path: '/workspace', displayName: 'Workspace', pinned: false }
        )
      ).ok
    ).toBe(true)
    expect(
      validateHostCommandArguments(
        command('workspace.register', { workspaceId: 'nope' }, { path: '/workspace' })
      )
    ).toEqual({ ok: false, error: 'workspace.register target must be empty' })
    expect(
      validateHostCommandArguments(command('thread.create', {}, { scope: 'workspace' }))
    ).toEqual({ ok: false, error: 'thread.create workspace requires workspaceId' })
    expect(
      validateHostCommandArguments(
        command('thread.create', {}, { scope: 'global', workspaceId: 'workspace-id' })
      )
    ).toEqual({ ok: false, error: 'thread.create global must not include workspaceId' })

    expect(
      validateHostCommandArguments(
        command('thread.configure', { threadId: 'thread-id' }, { title: 'Retitled' })
      )
    ).toMatchObject({ ok: true, value: { arguments: { title: 'Retitled' } } })
    expect(
      validateHostCommandArguments(
        command('thread.configure', { threadId: 'thread-id' }, { chatKind: 'ensemble' })
      )
    ).toMatchObject({ ok: true, value: { arguments: { chatKind: 'ensemble' } } })
    expect(
      validateHostCommandArguments(
        command(
          'thread.configure',
          { threadId: 'thread-id' },
          { chatKind: 'single', canonicalProviderId: 'kimi' }
        )
      )
    ).toMatchObject({
      ok: true,
      value: { arguments: { chatKind: 'single', canonicalProviderId: 'kimi' } }
    })
    expect(
      validateHostCommandArguments(
        command('thread.configure', { threadId: 'thread-id' }, { chatKind: 'single' })
      )
    ).toEqual({ ok: false, error: 'thread.configure chat-kind change is invalid' })
    expect(
      validateHostCommandArguments(
        command(
          'thread.configure',
          { threadId: 'thread-id' },
          { chatKind: 'ensemble', canonicalProviderId: 'codex' }
        )
      )
    ).toEqual({ ok: false, error: 'thread.configure chat-kind change is invalid' })
    expect(
      validateHostCommandArguments(
        command('thread.configure', { threadId: 'thread-id' }, { providerId: 'provider-id' })
      )
    ).toEqual({
      ok: false,
      error: 'thread.configure must be title-only or a complete provider selection'
    })
    expect(
      validateHostCommandArguments(
        command('thread.configure', { threadId: 'thread-id' }, { title: 'x', providerId: 'p' })
      )
    ).toEqual({
      ok: false,
      error: 'thread.configure must be title-only or a complete provider selection'
    })
    expect(
      validateHostCommandArguments(
        command(
          'provider.auth.cancel',
          { providerId: 'provider-id', operationId: 'operation-id' },
          { flowId: 'x' }
        )
      )
    ).toEqual({ ok: false, error: 'provider.auth.cancel arguments must be empty' })
  })

  it('ensemble.seat.toggle requires participantId and boolean enabled', () => {
    const ok = validateHostCommandArguments(
      command(
        'ensemble.seat.toggle',
        { threadId: 'thread-id' },
        { participantId: 'p1', enabled: false }
      )
    )
    expect(ok).toEqual({
      ok: true,
      value: expect.objectContaining({
        name: 'ensemble.seat.toggle',
        target: { threadId: 'thread-id' },
        arguments: { participantId: 'p1', enabled: false }
      })
    })

    expect(
      validateHostCommandArguments(
        command('ensemble.seat.toggle', { threadId: 'thread-id' }, { enabled: true })
      )
    ).toEqual({
      ok: false,
      error: 'ensemble.seat.toggle participantId is required and bounded'
    })

    expect(
      validateHostCommandArguments(
        command(
          'ensemble.seat.toggle',
          { threadId: 'thread-id' },
          { participantId: 'p1', enabled: 'yes' }
        )
      )
    ).toEqual({ ok: false, error: 'ensemble.seat.toggle enabled must be a boolean' })

    expect(
      validateHostCommandArguments(
        command(
          'ensemble.seat.toggle',
          { threadId: 'thread-id' },
          { participantId: 'p1', enabled: true, extra: 1 }
        )
      )
    ).toEqual({ ok: false, error: 'ensemble.seat.toggle has unknown argument keys' })
  })

  it('thread.record.persist accepts only an exact bounded transfer descriptor', () => {
    const descriptor = {
      transferId: '11111111-1111-4111-8111-111111111111',
      sha256: 'a'.repeat(64),
      byteLength: 512 * 1024,
      expectedRevision: 7
    }
    const ok = validateHostCommandArguments(
      command('thread.record.persist', { threadId: 'thread-id' }, descriptor)
    )
    expect(ok).toMatchObject({
      ok: true,
      value: {
        name: 'thread.record.persist',
        target: { threadId: 'thread-id' },
        arguments: descriptor
      }
    })
    expect(descriptor.byteLength).toBeGreaterThan(256 * 1024)

    const invalid: Array<[Record<string, unknown>, string]> = [
      [
        { ...descriptor, record: { appChatId: 'thread-id' } },
        'thread.record.persist has unknown argument keys'
      ],
      [
        { ...descriptor, path: '/tmp/record.json' },
        'thread.record.persist has unknown argument keys'
      ],
      [{ ...descriptor, transferId: '../escape' }, 'thread.record.persist transferId is invalid'],
      [
        { ...descriptor, sha256: 'A'.repeat(64) },
        'thread.record.persist sha256 must be lowercase SHA-256 hex'
      ],
      [{ ...descriptor, byteLength: 0 }, 'thread.record.persist byteLength is invalid'],
      [
        { ...descriptor, byteLength: HOST_THREAD_RECORD_TRANSFER_MAX_BYTES + 1 },
        'thread.record.persist byteLength is invalid'
      ],
      [{ ...descriptor, expectedRevision: -1 }, 'thread.record.persist expectedRevision is invalid']
    ]
    for (const [argumentsValue, error] of invalid) {
      expect(
        validateHostCommandArguments(
          command('thread.record.persist', { threadId: 'thread-id' }, argumentsValue)
        )
      ).toEqual({ ok: false, error })
    }

    expect(
      validateHostCommandArguments(
        command(
          'thread.record.persist',
          { threadId: 'thread-id', path: '/tmp/record.json' },
          descriptor
        )
      )
    ).toEqual({
      ok: false,
      error: 'thread.record.persist target must be exactly { threadId }'
    })
  })

  it('question.answer preserves the narrow shared codec', () => {
    const answer = validateHostCommandArguments(
      command(
        'question.answer',
        { questionId: 'q1' },
        { decision: 'answer', answer: 'chip', isCustom: false }
      )
    )
    expect(answer.ok).toBe(true)
    if (answer.ok) {
      expect(answer.value.arguments).toEqual({
        decision: 'answer',
        answer: 'chip',
        isCustom: false
      })
    }

    const dismiss = validateHostCommandArguments(
      command('question.answer', { questionId: 'q1' }, { decision: 'dismiss', message: 'skip' })
    )
    expect(dismiss.ok).toBe(true)

    expect(
      validateHostCommandArguments(
        command(
          'question.answer',
          { questionId: 'q1' },
          { decision: 'answer', answer: 'x', path: '/' }
        )
      )
    ).toEqual({ ok: false, error: 'question.answer has unknown argument keys' })

    expect(
      validateHostCommandArguments(
        command('question.answer', { approvalId: 'a1' }, { decision: 'dismiss' })
      )
    ).toEqual({ ok: false, error: 'question.answer target must be exactly { questionId }' })
  })

  it('approval.decide preserves the narrow decision set and rejects Bridge wideners', () => {
    for (const decision of [
      'accept',
      'acceptForSession',
      'acceptForWorkspace',
      'decline',
      'cancel'
    ] as const) {
      const result = validateHostCommandArguments(
        command('approval.decide', { approvalId: 'a1' }, { decision })
      )
      expect(result.ok).toBe(true)
    }

    expect(
      validateHostCommandArguments(
        command('approval.decide', { approvalId: 'a1' }, { decision: 'useProviderNative' })
      )
    ).toEqual({ ok: false, error: 'approval.decide decision is invalid' })

    expect(
      validateHostCommandArguments(
        command(
          'approval.decide',
          { approvalId: 'a1' },
          { decision: 'accept', grantExternalPathEdit: true }
        )
      )
    ).toEqual({ ok: false, error: 'approval.decide has unknown argument keys' })
  })

  it('reserved aliases: snapshot/ping empty; deltas.since exact position; receipt.lookup exclusive key', () => {
    expect(validateHostCommandArguments(command('snapshot.get')).ok).toBe(true)
    expect(validateHostCommandArguments(command('ping', { threadId: 't' }, {}))).toEqual({
      ok: false,
      error: 'ping target must be empty'
    })

    expect(
      validateHostCommandArguments(command('deltas.since', {}, { generation: 2, cursor: 9 })).ok
    ).toBe(true)
    expect(
      validateHostCommandArguments(
        command('deltas.since', {}, { generation: 2, cursor: 9, limit: true })
      )
    ).toEqual({ ok: false, error: 'deltas.since has unknown argument keys' })
    expect(validateHostCommandArguments(command('deltas.since', {}, { generation: 2 }))).toEqual({
      ok: false,
      error: 'deltas.since requires generation and cursor'
    })

    expect(
      validateHostCommandArguments(command('receipt.lookup', { commandId: 'c1' }, {})).ok
    ).toBe(true)
    expect(
      validateHostCommandArguments(command('receipt.lookup', { idempotencyKey: 'k1' }, {})).ok
    ).toBe(true)
    expect(
      validateHostCommandArguments(
        command('receipt.lookup', { commandId: 'c1', idempotencyKey: 'k1' }, {})
      )
    ).toEqual({
      ok: false,
      error: 'receipt.lookup target must be exactly one of commandId or idempotencyKey'
    })
    expect(
      validateHostCommandArguments(command('receipt.lookup', { commandId: 'c1' }, { peek: true }))
    ).toEqual({ ok: false, error: 'receipt.lookup arguments must be empty' })
  })

  it('fails closed on envelope identity problems without inventing actor fields', () => {
    const badActor = command('ping')
    // @ts-expect-error intentional untrusted actor class
    badActor.actor = { actorId: 'a', clientId: 'c', clientClass: 'web' }
    expect(validateHostCommandArguments(badActor)).toEqual({
      ok: false,
      error: 'actor.clientClass is invalid'
    })

    expect(validateHostCommandArguments(command('ping', {}, {}, { commandId: '' }))).toEqual({
      ok: false,
      error: 'commandId is required'
    })
  })
})
