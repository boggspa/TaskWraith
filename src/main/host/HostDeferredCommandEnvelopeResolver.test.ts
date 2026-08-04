import { describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand
} from '../../shared/hostProtocol'
import { fingerprintHostCommand } from './HostCommandFingerprint'
import type {
  HostDeferredCommandEnvelopeLookupResult,
  HostDeferredCommandEnvelopeRecord,
  HostDeferredCommandEnvelopeTransitionResult
} from './HostDeferredCommandEnvelopeStore'
import type {
  HostCommandReceiptLookupResult,
  HostCommandReceiptRecord,
  HostCommandReceiptStatus
} from './HostCommandReceiptStore'
import type {
  HostBridgeCommandExecutor,
  HostBridgeCommandExecutorResult
} from './HostBridgeCommandExecutor'
import {
  HostDeferredCommandEnvelopeResolver,
  type HostDeferredCommandEnvelopeResolverEnvelopePort,
  type HostDeferredCommandEnvelopeResolverReceiptPort,
  type HostDeferredCommandEnvelopeResolverInput,
  type HostDeferredCommandEnvelopeResolverIndeterminateCode,
  type HostDeferredCommandEnvelopeResolverResult
} from './HostDeferredCommandEnvelopeResolver'

const ACTOR: HostActorIdentity = {
  actorId: 'actor-1',
  clientId: 'client-1',
  clientClass: 'desktop'
}

const OTHER_ACTOR: HostActorIdentity = {
  actorId: 'actor-2',
  clientId: 'client-2',
  clientClass: 'desktop'
}

function makeCommand(overrides: Partial<HostCommand> = {}): HostCommand {
  const cmd: HostCommand = {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idempotencyKey: 'desktop:client-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    actor: ACTOR,
    name: 'thread.select',
    target: { threadId: 'thread-1' },
    arguments: {},
    issuedAt: '2026-08-04T00:00:00.000Z',
    ...overrides
  }
  return cmd
}

function validInput(
  overrides: Partial<HostDeferredCommandEnvelopeResolverInput> = {}
): HostDeferredCommandEnvelopeResolverInput {
  return {
    deferredId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idempotencyKey: 'desktop:client-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    commandFingerprint: fingerprintHostCommand(makeCommand()).fingerprint,
    commandName: 'thread.select',
    actor: ACTOR,
    challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    challengeKind: 'approval',
    ...overrides
  }
}

function makeEnvelopeRecord(
  overrides: Partial<HostDeferredCommandEnvelopeRecord> = {}
): HostDeferredCommandEnvelopeRecord {
  const cmd = makeCommand()
  return {
    schemaVersion: 1 as const,
    deferredId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    challengeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    challengeKind: 'approval',
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idempotencyKey: 'desktop:client-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    commandFingerprint: fingerprintHostCommand(cmd).fingerprint,
    commandName: 'thread.select',
    actor: ACTOR,
    state: 'stored',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    command: cmd,
    ...overrides
  }
}

function makeReceiptRecord(
  overrides: Partial<HostCommandReceiptRecord> = {}
): HostCommandReceiptRecord {
  return {
    schemaVersion: 1 as const,
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idempotencyKey: 'desktop:client-1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    commandFingerprint: fingerprintHostCommand(makeCommand()).fingerprint,
    status: 'pending',
    actor: {
      clientId: 'client-1',
      actorId: 'actor-1',
      clientClass: 'desktop'
    },
    target: { kind: 'thread', id: 'thread-1' },
    authority: { decision: 'deferred', reason: 'awaiting approval' },
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    commandName: 'thread.select',
    generation: 1,
    cursor: 42,
    ...overrides
  }
}

function succeedResult(): HostBridgeCommandExecutorResult {
  return { status: 'succeeded', resultSummary: 'done' }
}

function mockEnvelopePort(
  overrides: Partial<HostDeferredCommandEnvelopeResolverEnvelopePort> = {}
): HostDeferredCommandEnvelopeResolverEnvelopePort {
  return {
    getByCommandId: vi.fn().mockReturnValue({
      kind: 'found',
      record: makeEnvelopeRecord()
    } satisfies HostDeferredCommandEnvelopeLookupResult),
    markQuarantined: vi.fn().mockReturnValue({
      kind: 'updated',
      state: 'quarantined'
    } satisfies HostDeferredCommandEnvelopeTransitionResult),
    ...overrides
  }
}

function mockReceiptPort(
  overrides: Partial<HostDeferredCommandEnvelopeResolverReceiptPort> = {}
): HostDeferredCommandEnvelopeResolverReceiptPort {
  return {
    getByCommandId: vi.fn().mockReturnValue({
      kind: 'found',
      receipt: makeReceiptRecord()
    } satisfies HostCommandReceiptLookupResult),
    ...overrides
  }
}

function mockExecutor(
  executeImpl: () => Promise<HostBridgeCommandExecutorResult> = async () => succeedResult()
): Pick<HostBridgeCommandExecutor, 'execute'> {
  return {
    execute: vi.fn().mockImplementation(executeImpl)
  }
}

async function execute(
  input: HostDeferredCommandEnvelopeResolverInput,
  opts?: {
    envelope?: Partial<HostDeferredCommandEnvelopeResolverEnvelopePort>
    receipt?: Partial<HostDeferredCommandEnvelopeResolverReceiptPort>
    executor?: Pick<HostBridgeCommandExecutor, 'execute'>
  }
): Promise<HostDeferredCommandEnvelopeResolverResult> {
  const resolver = new HostDeferredCommandEnvelopeResolver({
    envelopeStore: mockEnvelopePort(opts?.envelope),
    receiptStore: mockReceiptPort(opts?.receipt),
    executor: opts?.executor ?? mockExecutor()
  })
  return await resolver.executeCommand(input)
}

function expectIndeterminate(
  result: HostDeferredCommandEnvelopeResolverResult,
  code: HostDeferredCommandEnvelopeResolverIndeterminateCode
): void {
  expect(result.kind).toBe('indeterminate')
  if (result.kind === 'indeterminate') {
    expect(result.code).toBe(code)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HostDeferredCommandEnvelopeResolver', () => {
  // --- Construction ---------------------------------------------------------

  it('throws when constructed without options', () => {
    expect(() => new HostDeferredCommandEnvelopeResolver(null as any)).toThrow(
      'HostDeferredCommandEnvelopeResolver requires options'
    )
  })

  it('throws when constructed without envelopeStore.getByCommandId', () => {
    expect(
      () =>
        new HostDeferredCommandEnvelopeResolver({
          envelopeStore: { getByCommandId: null as any, markQuarantined: vi.fn() },
          receiptStore: mockReceiptPort(),
          executor: mockExecutor()
        })
    ).toThrow('HostDeferredCommandEnvelopeResolver requires envelopeStore.getByCommandId')
  })

  it('throws when constructed without envelopeStore.markQuarantined', () => {
    expect(
      () =>
        new HostDeferredCommandEnvelopeResolver({
          envelopeStore: { getByCommandId: vi.fn(), markQuarantined: null as any },
          receiptStore: mockReceiptPort(),
          executor: mockExecutor()
        })
    ).toThrow('HostDeferredCommandEnvelopeResolver requires envelopeStore.markQuarantined')
  })

  it('throws when constructed without receiptStore.getByCommandId', () => {
    expect(
      () =>
        new HostDeferredCommandEnvelopeResolver({
          envelopeStore: mockEnvelopePort(),
          receiptStore: { getByCommandId: null as any },
          executor: mockExecutor()
        })
    ).toThrow('HostDeferredCommandEnvelopeResolver requires receiptStore.getByCommandId')
  })

  it('throws when constructed without executor.execute', () => {
    expect(
      () =>
        new HostDeferredCommandEnvelopeResolver({
          envelopeStore: mockEnvelopePort(),
          receiptStore: mockReceiptPort(),
          executor: { execute: null as any }
        })
    ).toThrow('HostDeferredCommandEnvelopeResolver requires executor.execute')
  })

  // --- Happy path -----------------------------------------------------------

  it('executes H once on a valid stored envelope with pending receipt', async () => {
    const executor = mockExecutor()
    const result = await execute(validInput(), { executor })

    expect(result.kind).toBe('executed')
    if (result.kind === 'executed') {
      expect(result.command.commandId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      expect(result.result.status).toBe('succeeded')
      expect(result.result.resultSummary).toBe('done')
    }
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  // --- Envelope unavailable -------------------------------------------------

  it('returns store_unavailable when envelope store is unavailable', async () => {
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'unavailable' }),
        markQuarantined: vi.fn()
      }
    })
    expectIndeterminate(result, 'store_unavailable')
  })

  // --- Envelope not found ---------------------------------------------------

  it('returns envelope_not_found when envelope is not found', async () => {
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'not_found' }),
        markQuarantined: vi.fn()
      }
    })
    expectIndeterminate(result, 'envelope_not_found')
  })

  // --- Envelope actor mismatch -----------------------------------------------

  it('returns envelope_actor_mismatch when envelope actor does not match', async () => {
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'actor_mismatch' }),
        markQuarantined: vi.fn()
      }
    })
    expectIndeterminate(result, 'envelope_actor_mismatch')
  })

  // --- Envelope not stored --------------------------------------------------

  it('returns envelope_not_stored without rewriting a consumed envelope', async () => {
    const markQuarantined = vi.fn()
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord({ state: 'consumed' })
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'envelope_not_stored')
    expect(markQuarantined).not.toHaveBeenCalled()
  })

  it('returns envelope_not_stored without rewriting a quarantined envelope', async () => {
    const markQuarantined = vi.fn()
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord({
            state: 'quarantined',
            command: undefined
          } satisfies Partial<HostDeferredCommandEnvelopeRecord>)
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'envelope_not_stored')
    expect(markQuarantined).not.toHaveBeenCalled()
  })

  // --- Envelope body missing ------------------------------------------------

  it('returns envelope_body_missing when stored envelope has no command body', async () => {
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord({ command: undefined } as any)
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'envelope_body_missing')
    expect(markQuarantined).toHaveBeenCalledWith(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ACTOR,
      'body_missing'
    )
  })

  // --- Correlation mismatch -------------------------------------------------

  it('returns envelope_correlation_mismatch when deferredId differs', async () => {
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const input = validInput({ deferredId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })
    const result = await execute(input, {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord()
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'envelope_correlation_mismatch')
    expect(markQuarantined).toHaveBeenCalledWith(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      ACTOR,
      'verification_failed'
    )
  })

  it('returns envelope_correlation_mismatch when commandName differs', async () => {
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const input = validInput({ commandName: 'composer.send' as any })
    const result = await execute(input, {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord()
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'envelope_correlation_mismatch')
  })

  it('returns envelope_correlation_mismatch when challengeId differs', async () => {
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const input = validInput({ challengeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
    const result = await execute(input, {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord()
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'envelope_correlation_mismatch')
  })

  // --- Command re-decode / validation / fingerprint failures ----------------

  it('returns command_decode_failed when decodeHostCommand fails', async () => {
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const badCommand = { ...makeCommand(), type: 'bad' } as any
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord({ command: badCommand })
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'command_decode_failed')
    expect(markQuarantined).toHaveBeenCalled()
  })

  it('returns command_validation_failed when decoded arguments are invalid', async () => {
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const badCommand = makeCommand({
      arguments: { unexpected: true } as never
    })
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord({ command: badCommand })
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'command_validation_failed')
    expect(markQuarantined).toHaveBeenCalled()
  })

  it('returns command_fingerprint_mismatch when recomputed fingerprint differs', async () => {
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const differentCommand = makeCommand({
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'thread.select',
      target: { threadId: 'thread-2' } // different target → different fingerprint
    })
    const originalFingerprint = fingerprintHostCommand(makeCommand()).fingerprint
    const result = await execute(validInput({ commandFingerprint: originalFingerprint }), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord({
            commandFingerprint: originalFingerprint,
            command: differentCommand
          })
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'command_fingerprint_mismatch')
    expect(markQuarantined).toHaveBeenCalled()
  })

  it('returns command_identity_mismatch when body commandId differs from envelope', async () => {
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const badCommand = makeCommand({ commandId: '99999999-9999-4999-8999-999999999999' })
    const fp = fingerprintHostCommand(badCommand).fingerprint
    const result = await execute(validInput({ commandFingerprint: fp }), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord({
            commandFingerprint: fp,
            command: badCommand
          })
        }),
        markQuarantined
      }
    })
    expectIndeterminate(result, 'command_identity_mismatch')
    expect(markQuarantined).toHaveBeenCalled()
  })

  // --- Receipt failures -----------------------------------------------------

  it('returns receipt_not_found when receipt does not exist', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'not_found' })
      }
    })
    expectIndeterminate(result, 'receipt_not_found')
  })

  it('returns receipt_actor_mismatch when receipt actor does not match', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'actor_mismatch' })
      }
    })
    expectIndeterminate(result, 'receipt_actor_mismatch')
  })

  it('returns receipt_incomplete when receipt is incomplete', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'incomplete' })
      }
    })
    expectIndeterminate(result, 'receipt_incomplete')
  })

  it('returns already_terminal when receipt is already succeeded', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ status: 'succeeded' })
        })
      }
    })
    expect(result.kind).toBe('already_terminal')
    if (result.kind === 'already_terminal') {
      expect(result.receiptStatus).toBe('succeeded')
    }
  })

  it('returns already_terminal when receipt is already denied', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ status: 'denied' })
        })
      }
    })
    expect(result.kind).toBe('already_terminal')
    if (result.kind === 'already_terminal') {
      expect(result.receiptStatus).toBe('denied')
    }
  })

  it('returns already_terminal when receipt is already cancelled', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ status: 'cancelled' })
        })
      }
    })
    expect(result.kind).toBe('already_terminal')
    if (result.kind === 'already_terminal') {
      expect(result.receiptStatus).toBe('cancelled')
    }
  })

  it('returns already_terminal when receipt is already conflict', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ status: 'conflict' })
        })
      }
    })
    expect(result.kind).toBe('already_terminal')
    if (result.kind === 'already_terminal') {
      expect(result.receiptStatus).toBe('conflict')
    }
  })

  it('returns already_terminal when receipt is failed', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ status: 'failed' })
        })
      }
    })
    expect(result.kind).toBe('already_terminal')
    if (result.kind === 'already_terminal') {
      expect(result.receiptStatus).toBe('failed')
    }
  })

  it('returns receipt_already_indeterminate when receipt is indeterminate', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ status: 'indeterminate' })
        })
      }
    })
    expectIndeterminate(result, 'receipt_already_indeterminate')
  })

  it('returns receipt_not_pending when receipt status is unrecognized', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ status: 'bogus' as HostCommandReceiptStatus })
        })
      }
    })
    expectIndeterminate(result, 'receipt_not_pending')
  })

  it('returns receipt_correlation_mismatch when receipt commandId differs', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ commandId: '99999999-9999-4999-8999-999999999999' })
        })
      }
    })
    expectIndeterminate(result, 'receipt_correlation_mismatch')
  })

  it('returns receipt_correlation_mismatch when receipt idempotencyKey differs', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({
            idempotencyKey: 'other:key:uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu'
          })
        })
      }
    })
    expectIndeterminate(result, 'receipt_correlation_mismatch')
  })

  it('returns receipt_correlation_mismatch when receipt clientId differs', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({
            actor: { clientId: 'other-client', actorId: 'actor-1', clientClass: 'desktop' }
          })
        })
      }
    })
    expectIndeterminate(result, 'receipt_correlation_mismatch')
  })

  it('returns receipt_correlation_mismatch when receipt actorId differs', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({
            actor: { clientId: 'client-1', actorId: 'other-actor', clientClass: 'desktop' }
          })
        })
      }
    })
    expectIndeterminate(result, 'receipt_correlation_mismatch')
  })

  it('returns receipt_correlation_mismatch when receipt clientClass differs', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({
            actor: { clientId: 'client-1', actorId: 'actor-1', clientClass: 'ios' as any }
          })
        })
      }
    })
    expectIndeterminate(result, 'receipt_correlation_mismatch')
  })

  it('returns receipt_incomplete when a found receipt lacks durable identity', async () => {
    const receipt = makeReceiptRecord()
    delete receipt.commandName
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'found', receipt })
      }
    })
    expectIndeterminate(result, 'receipt_incomplete')
  })

  it('returns receipt_correlation_mismatch when receipt commandName differs', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ commandName: 'run.cancel' })
        })
      }
    })
    expectIndeterminate(result, 'receipt_correlation_mismatch')
  })

  it('returns receipt_correlation_mismatch when receipt target differs', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ target: { kind: 'thread', id: 'thread-2' } })
        })
      }
    })
    expectIndeterminate(result, 'receipt_correlation_mismatch')
  })

  it('returns receipt_not_deferred when pending receipt authority is allowed', async () => {
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({
            authority: { decision: 'allowed', reason: 'already authorized' }
          })
        })
      }
    })
    expectIndeterminate(result, 'receipt_not_deferred')
  })

  // --- Quarantine failure ---------------------------------------------------

  it('surfaces quarantine_failed without executing H', async () => {
    const executor = mockExecutor()
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'not_found' })
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord({ command: undefined } as never)
        }),
        markQuarantined
      },
      executor
    })
    expectIndeterminate(result, 'quarantine_failed')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  // --- Zero H calls on failure paths ----------------------------------------

  it('makes zero H calls on store_unavailable', async () => {
    const executor = mockExecutor()
    await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'unavailable' }),
        markQuarantined: vi.fn()
      },
      executor
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('makes zero H calls on envelope_not_found', async () => {
    const executor = mockExecutor()
    await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'not_found' }),
        markQuarantined: vi.fn()
      },
      executor
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('makes zero H calls on receipt_not_found', async () => {
    const executor = mockExecutor()
    await execute(validInput(), {
      receipt: { getByCommandId: vi.fn().mockReturnValue({ kind: 'not_found' }) },
      executor
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('makes zero H calls on already_terminal', async () => {
    const executor = mockExecutor()
    await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          receipt: makeReceiptRecord({ status: 'succeeded' })
        })
      },
      executor
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('makes zero H calls on envelope_correlation_mismatch', async () => {
    const executor = mockExecutor()
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    await execute(validInput({ deferredId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }), {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({
          kind: 'found',
          record: makeEnvelopeRecord()
        }),
        markQuarantined
      },
      executor
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('makes zero H calls on command_fingerprint_mismatch', async () => {
    const executor = mockExecutor()
    const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
    const differentCommand = makeCommand({ target: { threadId: 'thread-2' } })
    await execute(
      validInput({ commandFingerprint: fingerprintHostCommand(makeCommand()).fingerprint }),
      {
        envelope: {
          getByCommandId: vi.fn().mockReturnValue({
            kind: 'found',
            record: makeEnvelopeRecord({
              commandFingerprint: fingerprintHostCommand(makeCommand()).fingerprint,
              command: differentCommand
            })
          }),
          markQuarantined
        },
        executor
      }
    )
    expect(executor.execute).not.toHaveBeenCalled()
  })

  // --- Invalid input --------------------------------------------------------

  it('returns envelope_corrupt when input is null', async () => {
    const result = await new HostDeferredCommandEnvelopeResolver({
      envelopeStore: mockEnvelopePort(),
      receiptStore: mockReceiptPort(),
      executor: mockExecutor()
    }).executeCommand(null as any)
    expectIndeterminate(result, 'envelope_corrupt')
  })

  it('returns envelope_corrupt when deferredId is not a UUID', async () => {
    const result = await execute(validInput({ deferredId: 'not-a-uuid' }))
    expectIndeterminate(result, 'envelope_corrupt')
  })

  it('returns envelope_corrupt when commandId is empty', async () => {
    const result = await execute(validInput({ commandId: '' }))
    expectIndeterminate(result, 'envelope_corrupt')
  })

  it('returns envelope_corrupt when commandFingerprint is invalid', async () => {
    const result = await execute(validInput({ commandFingerprint: 'bad' }))
    expectIndeterminate(result, 'envelope_corrupt')
  })

  it('returns envelope_corrupt when commandName is not governed', async () => {
    const result = await execute(validInput({ commandName: 'ping' as any }))
    expectIndeterminate(result, 'envelope_corrupt')
  })

  it('returns envelope_corrupt when challengeKind is invalid', async () => {
    const result = await execute(validInput({ challengeKind: 'bogus' as any }))
    expectIndeterminate(result, 'envelope_corrupt')
  })

  it('returns envelope_corrupt when input contains an unknown field', async () => {
    const input = { ...validInput(), unexpected: true }
    const result = await new HostDeferredCommandEnvelopeResolver({
      envelopeStore: mockEnvelopePort(),
      receiptStore: mockReceiptPort(),
      executor: mockExecutor()
    }).executeCommand(input as HostDeferredCommandEnvelopeResolverInput)
    expectIndeterminate(result, 'envelope_corrupt')
  })

  it('returns envelope_actor_mismatch when idempotency key is bound to another client', async () => {
    const result = await execute(
      validInput({
        idempotencyKey: 'desktop:other-client:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      })
    )
    expectIndeterminate(result, 'envelope_actor_mismatch')
  })

  it('returns envelope_actor_mismatch when actor is invalid', async () => {
    const result = await execute(
      validInput({ actor: { actorId: '', clientId: '', clientClass: 'bogus' } as any })
    )
    expectIndeterminate(result, 'envelope_actor_mismatch')
  })

  // --- Edge case: input with OTHER_ACTOR (envelope check fails at store) ----

  it('returns envelope_actor_mismatch when actor differs from envelope actor', async () => {
    const input = validInput({ actor: OTHER_ACTOR })
    const result = await execute(input, {
      envelope: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'actor_mismatch' }),
        markQuarantined: vi.fn()
      }
    })
    expectIndeterminate(result, 'envelope_actor_mismatch')
  })
})
