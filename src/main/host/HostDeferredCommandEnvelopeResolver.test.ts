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
  type HostDeferredCommandEnvelopeResolverResult,
  type HostDeferredCommandEnvelopeResolverVerifyResult
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

  it('fails closed without executing H when envelope lookup throws', async () => {
    const executor = mockExecutor()
    const result = await execute(validInput(), {
      envelope: {
        getByCommandId: vi.fn(() => {
          throw new Error('secret envelope body')
        }),
        markQuarantined: vi.fn()
      },
      executor
    })
    expectIndeterminate(result, 'store_unavailable')
    expect(JSON.stringify(result)).not.toContain('secret envelope body')
    expect(executor.execute).not.toHaveBeenCalled()
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

  it('fails closed without executing H when receipt lookup throws', async () => {
    const executor = mockExecutor()
    const result = await execute(validInput(), {
      receipt: {
        getByCommandId: vi.fn(() => {
          throw new Error('secret receipt body')
        })
      },
      executor
    })
    expectIndeterminate(result, 'store_unavailable')
    expect(JSON.stringify(result)).not.toContain('secret receipt body')
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('returns receipt_actor_mismatch without quarantining or executing H', async () => {
    const markQuarantined = vi.fn()
    const executor = mockExecutor()
    const result = await execute(validInput(), {
      envelope: { markQuarantined },
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'actor_mismatch' })
      },
      executor
    })
    expectIndeterminate(result, 'receipt_actor_mismatch')
    expect(markQuarantined).not.toHaveBeenCalled()
    expect(executor.execute).not.toHaveBeenCalled()
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

  it('quarantines actor-confirmed receipt inconsistencies without executing H', async () => {
    const cases: Array<{
      code: HostDeferredCommandEnvelopeResolverIndeterminateCode
      lookup: HostCommandReceiptLookupResult
    }> = [
      { code: 'receipt_not_found', lookup: { kind: 'not_found' } },
      { code: 'receipt_incomplete', lookup: { kind: 'incomplete' } },
      {
        code: 'receipt_correlation_mismatch',
        lookup: {
          kind: 'found',
          receipt: makeReceiptRecord({
            commandId: '99999999-9999-4999-8999-999999999999'
          })
        }
      },
      {
        code: 'receipt_not_deferred',
        lookup: {
          kind: 'found',
          receipt: makeReceiptRecord({
            authority: { decision: 'allowed', reason: 'already authorized' }
          })
        }
      }
    ]

    for (const testCase of cases) {
      const markQuarantined = vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
      const executor = mockExecutor()
      const result = await execute(validInput(), {
        envelope: { markQuarantined },
        receipt: {
          getByCommandId: vi.fn().mockReturnValue(testCase.lookup)
        },
        executor
      })

      expectIndeterminate(result, testCase.code)
      expect(markQuarantined).toHaveBeenCalledWith(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        ACTOR,
        'verification_failed'
      )
      expect(executor.execute).not.toHaveBeenCalled()
    }
  })

  // --- Quarantine failure ---------------------------------------------------

  it('returns quarantine_failed without executing H when quarantine throws', async () => {
    const executor = mockExecutor()
    const result = await execute(validInput(), {
      envelope: {
        markQuarantined: vi.fn(() => {
          throw new Error('secret quarantine body')
        })
      },
      receipt: {
        getByCommandId: vi.fn().mockReturnValue({ kind: 'not_found' })
      },
      executor
    })
    expectIndeterminate(result, 'quarantine_failed')
    expect(JSON.stringify(result)).not.toContain('secret quarantine body')
    expect(executor.execute).not.toHaveBeenCalled()
  })

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

// ---------------------------------------------------------------------------
// verifyCommand — the zero-H verification split
// ---------------------------------------------------------------------------

function makeHarness(overrides?: {
  envelope?: Partial<HostDeferredCommandEnvelopeResolverEnvelopePort>
  receipt?: Partial<HostDeferredCommandEnvelopeResolverReceiptPort>
}) {
  const markQuarantined =
    overrides?.envelope?.markQuarantined ??
    vi.fn().mockReturnValue({ kind: 'updated', state: 'quarantined' })
  const executeMock = vi.fn().mockImplementation(async () => succeedResult())
  const executor: Pick<HostBridgeCommandExecutor, 'execute'> = { execute: executeMock }
  const resolver = new HostDeferredCommandEnvelopeResolver({
    envelopeStore: mockEnvelopePort({ ...overrides?.envelope, markQuarantined }),
    receiptStore: mockReceiptPort(overrides?.receipt),
    executor
  })
  return { resolver, markQuarantined, executeMock }
}

type NonVerifiedExpectation =
  | { kind: 'indeterminate'; code: HostDeferredCommandEnvelopeResolverIndeterminateCode }
  | { kind: 'already_terminal'; receiptStatus: HostCommandReceiptStatus }

interface VerifyScenario {
  name: string
  input: HostDeferredCommandEnvelopeResolverInput
  /** Factory so every scenario run gets its OWN spies — shared mocks would make counts lie. */
  overrides?: () => {
    envelope?: Partial<HostDeferredCommandEnvelopeResolverEnvelopePort>
    receipt?: Partial<HostDeferredCommandEnvelopeResolverReceiptPort>
  }
  expected: NonVerifiedExpectation
  /** Quarantine asymmetry is the contract: only actor-confirmed verification failures rewrite. */
  quarantines: boolean
}

function withEnvelopeRecord(
  record: HostDeferredCommandEnvelopeRecord
): () => { envelope: Partial<HostDeferredCommandEnvelopeResolverEnvelopePort> } {
  return () => ({
    envelope: { getByCommandId: vi.fn().mockReturnValue({ kind: 'found', record }) }
  })
}

function withEnvelopeLookup(
  lookup: HostDeferredCommandEnvelopeLookupResult
): () => { envelope: Partial<HostDeferredCommandEnvelopeResolverEnvelopePort> } {
  return () => ({
    envelope: { getByCommandId: vi.fn().mockReturnValue(lookup) }
  })
}

function withReceiptLookup(
  lookup: HostCommandReceiptLookupResult
): () => { receipt: Partial<HostDeferredCommandEnvelopeResolverReceiptPort> } {
  return () => ({
    receipt: { getByCommandId: vi.fn().mockReturnValue(lookup) }
  })
}

function withReceipt(
  overrides: Partial<HostCommandReceiptRecord>
): () => { receipt: Partial<HostDeferredCommandEnvelopeResolverReceiptPort> } {
  return withReceiptLookup({ kind: 'found', receipt: makeReceiptRecord(overrides) })
}

const TERMINAL_STATUSES: HostCommandReceiptStatus[] = [
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'conflict'
]

function nonVerifiedScenarios(): VerifyScenario[] {
  const originalFingerprint = fingerprintHostCommand(makeCommand()).fingerprint
  const driftedCommand = makeCommand({ target: { threadId: 'thread-2' } })
  const foreignCommand = makeCommand({ commandId: '99999999-9999-4999-8999-999999999999' })
  const foreignFingerprint = fingerprintHostCommand(foreignCommand).fingerprint

  return [
    // --- Input validation (no store was ever consulted) ---------------------
    {
      name: 'null input',
      input: null as any,
      expected: { kind: 'indeterminate', code: 'envelope_corrupt' },
      quarantines: false
    },
    {
      name: 'deferredId is not a UUID',
      input: validInput({ deferredId: 'not-a-uuid' }),
      expected: { kind: 'indeterminate', code: 'envelope_corrupt' },
      quarantines: false
    },
    {
      name: 'input carries an unknown field',
      input: { ...validInput(), unexpected: true } as any,
      expected: { kind: 'indeterminate', code: 'envelope_corrupt' },
      quarantines: false
    },
    {
      name: 'idempotency key is bound to another client',
      input: validInput({
        idempotencyKey: 'desktop:other-client:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      }),
      expected: { kind: 'indeterminate', code: 'envelope_actor_mismatch' },
      quarantines: false
    },

    // --- Envelope load ------------------------------------------------------
    {
      name: 'envelope store unavailable',
      input: validInput(),
      overrides: withEnvelopeLookup({ kind: 'unavailable' }),
      expected: { kind: 'indeterminate', code: 'store_unavailable' },
      quarantines: false
    },
    {
      name: 'envelope lookup throws',
      input: validInput(),
      overrides: () => ({
        envelope: {
          getByCommandId: vi.fn(() => {
            throw new Error('secret envelope body')
          })
        }
      }),
      expected: { kind: 'indeterminate', code: 'store_unavailable' },
      quarantines: false
    },
    {
      name: 'envelope not found',
      input: validInput(),
      overrides: withEnvelopeLookup({ kind: 'not_found' }),
      expected: { kind: 'indeterminate', code: 'envelope_not_found' },
      quarantines: false
    },
    {
      name: 'envelope actor mismatch',
      input: validInput(),
      overrides: withEnvelopeLookup({ kind: 'actor_mismatch' }),
      expected: { kind: 'indeterminate', code: 'envelope_actor_mismatch' },
      quarantines: false
    },
    {
      name: 'consumed envelope is never rewritten',
      input: validInput(),
      overrides: withEnvelopeRecord(makeEnvelopeRecord({ state: 'consumed' })),
      expected: { kind: 'indeterminate', code: 'envelope_not_stored' },
      quarantines: false
    },
    {
      name: 'quarantined envelope is never rewritten',
      input: validInput(),
      overrides: withEnvelopeRecord(
        makeEnvelopeRecord({ state: 'quarantined', command: undefined })
      ),
      expected: { kind: 'indeterminate', code: 'envelope_not_stored' },
      quarantines: false
    },
    {
      name: 'stored envelope without a body',
      input: validInput(),
      overrides: withEnvelopeRecord(makeEnvelopeRecord({ command: undefined } as any)),
      expected: { kind: 'indeterminate', code: 'envelope_body_missing' },
      quarantines: true
    },

    // --- Correlation --------------------------------------------------------
    {
      name: 'deferredId correlation mismatch',
      input: validInput({ deferredId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
      expected: { kind: 'indeterminate', code: 'envelope_correlation_mismatch' },
      quarantines: true
    },
    {
      name: 'challengeId correlation mismatch',
      input: validInput({ challengeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
      expected: { kind: 'indeterminate', code: 'envelope_correlation_mismatch' },
      quarantines: true
    },

    // --- Durable body re-decode / refingerprint -----------------------------
    {
      name: 'undecodable stored body',
      input: validInput(),
      overrides: withEnvelopeRecord(
        makeEnvelopeRecord({ command: { ...makeCommand(), type: 'bad' } as any })
      ),
      expected: { kind: 'indeterminate', code: 'command_decode_failed' },
      quarantines: true
    },
    {
      name: 'stored body with invalid arguments',
      input: validInput(),
      overrides: withEnvelopeRecord(
        makeEnvelopeRecord({ command: makeCommand({ arguments: { unexpected: true } as never }) })
      ),
      expected: { kind: 'indeterminate', code: 'command_validation_failed' },
      quarantines: true
    },
    {
      name: 'recomputed fingerprint differs from the envelope',
      input: validInput({ commandFingerprint: originalFingerprint }),
      overrides: withEnvelopeRecord(
        makeEnvelopeRecord({
          commandFingerprint: originalFingerprint,
          command: driftedCommand
        })
      ),
      expected: { kind: 'indeterminate', code: 'command_fingerprint_mismatch' },
      quarantines: true
    },
    {
      name: 'stored body identity differs from the envelope',
      input: validInput({ commandFingerprint: foreignFingerprint }),
      overrides: withEnvelopeRecord(
        makeEnvelopeRecord({
          commandFingerprint: foreignFingerprint,
          command: foreignCommand
        })
      ),
      expected: { kind: 'indeterminate', code: 'command_identity_mismatch' },
      quarantines: true
    },

    // --- Receipt ------------------------------------------------------------
    {
      name: 'receipt not found',
      input: validInput(),
      overrides: withReceiptLookup({ kind: 'not_found' }),
      expected: { kind: 'indeterminate', code: 'receipt_not_found' },
      quarantines: true
    },
    {
      name: 'receipt lookup throws',
      input: validInput(),
      overrides: () => ({
        receipt: {
          getByCommandId: vi.fn(() => {
            throw new Error('secret receipt body')
          })
        }
      }),
      expected: { kind: 'indeterminate', code: 'store_unavailable' },
      quarantines: false
    },
    {
      name: 'receipt actor mismatch',
      input: validInput(),
      overrides: withReceiptLookup({ kind: 'actor_mismatch' }),
      expected: { kind: 'indeterminate', code: 'receipt_actor_mismatch' },
      quarantines: false
    },
    {
      name: 'receipt incomplete',
      input: validInput(),
      overrides: withReceiptLookup({ kind: 'incomplete' }),
      expected: { kind: 'indeterminate', code: 'receipt_incomplete' },
      quarantines: true
    },
    {
      name: 'receipt correlation mismatch',
      input: validInput(),
      overrides: withReceipt({ commandId: '99999999-9999-4999-8999-999999999999' }),
      expected: { kind: 'indeterminate', code: 'receipt_correlation_mismatch' },
      quarantines: true
    },
    {
      name: 'receipt already indeterminate',
      input: validInput(),
      overrides: withReceipt({ status: 'indeterminate' }),
      expected: { kind: 'indeterminate', code: 'receipt_already_indeterminate' },
      quarantines: false
    },
    {
      name: 'receipt status unrecognized',
      input: validInput(),
      overrides: withReceipt({ status: 'weird' as any }),
      expected: { kind: 'indeterminate', code: 'receipt_not_pending' },
      quarantines: false
    },
    {
      name: 'pending receipt is not deferred',
      input: validInput(),
      overrides: withReceipt({ authority: { decision: 'allowed', reason: 'already authorized' } }),
      expected: { kind: 'indeterminate', code: 'receipt_not_deferred' },
      quarantines: true
    },

    // --- Terminal receipts: resolved already, and never quarantined ---------
    ...TERMINAL_STATUSES.map((receiptStatus) => ({
      name: `receipt already ${receiptStatus}`,
      input: validInput(),
      overrides: withReceipt({ status: receiptStatus }),
      expected: { kind: 'already_terminal' as const, receiptStatus },
      quarantines: false
    }))
  ]
}

describe('HostDeferredCommandEnvelopeResolver.verifyCommand', () => {
  // --- The anti-vacuous proof ----------------------------------------------
  //
  // A "zero H calls" assertion is worthless unless the SAME spy is also proven
  // to record a call. This test drives one resolver through both methods and
  // watches the counter go 0 → 1, so a mis-wired executor cannot pass it.

  it('makes zero H calls verifying and exactly one executing, on one live spy', async () => {
    const { resolver, executeMock } = makeHarness()

    const verified = resolver.verifyCommand(validInput())
    expect(verified.kind).toBe('verified')
    expect(executeMock).toHaveBeenCalledTimes(0)

    const executed = await resolver.executeCommand(validInput())
    expect(executed.kind).toBe('executed')
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('is synchronous, so no executor call can hide behind an await', () => {
    const { resolver, executeMock } = makeHarness()
    const verified: HostDeferredCommandEnvelopeResolverVerifyResult =
      resolver.verifyCommand(validInput())

    expect(verified).not.toBeInstanceOf(Promise)
    expect(verified.kind).toBe('verified')
    expect(executeMock).not.toHaveBeenCalled()
  })

  // --- executeCommand delegates: one verification, one execution ------------

  it('executeCommand verifies exactly once and executes the exact verified object', async () => {
    const { resolver, executeMock } = makeHarness()
    const verifySpy = vi.spyOn(resolver, 'verifyCommand')

    const result = await resolver.executeCommand(validInput())

    expect(verifySpy).toHaveBeenCalledTimes(1)
    expect(executeMock).toHaveBeenCalledTimes(1)

    const verified = verifySpy.mock.results[0]?.value as
      | HostDeferredCommandEnvelopeResolverVerifyResult
      | undefined
    expect(verified?.kind).toBe('verified')

    // Object identity, not deep equality: a re-decode between verify and
    // execute would hand over an equal-but-different command and let
    // fingerprint/identity drift straight past the envelope check.
    if (verified?.kind === 'verified' && result.kind === 'executed') {
      expect(executeMock.mock.calls[0]?.[0]).toBe(verified.command)
      expect(result.command).toBe(verified.command)
    }
  })

  it('executes with the validated actor and a body whose fingerprint still matches', async () => {
    const { resolver, executeMock } = makeHarness()

    await resolver.executeCommand(validInput())

    const [passedCommand, passedOptions] = executeMock.mock.calls[0] ?? []
    expect(passedOptions).toEqual({ actor: ACTOR })
    expect(fingerprintHostCommand(passedCommand).fingerprint).toBe(validInput().commandFingerprint)
  })

  it('returns the verification result itself when verification does not pass', async () => {
    const { resolver } = makeHarness({
      receipt: { getByCommandId: vi.fn().mockReturnValue({ kind: 'not_found' }) }
    })
    const verifySpy = vi.spyOn(resolver, 'verifyCommand')

    const result = await resolver.executeCommand(validInput())

    // Same object, not merely the same shape — nothing re-wraps or re-maps the
    // non-verified outcome on its way out of executeCommand.
    expect(result).toBe(verifySpy.mock.results[0]?.value)
  })

  // --- The full non-verified matrix ----------------------------------------

  it('returns the same body-free outcome as executeCommand, with zero H, on every non-verified path', async () => {
    const scenarios = nonVerifiedScenarios()
    expect(scenarios).toHaveLength(30)

    for (const scenario of scenarios) {
      const verifyHarness = makeHarness(scenario.overrides?.())
      const verified = verifyHarness.resolver.verifyCommand(scenario.input)

      expect(verified, scenario.name).toEqual(scenario.expected)
      expect(verifyHarness.executeMock, scenario.name).not.toHaveBeenCalled()

      // executeCommand must remain byte-compatible with the pre-split module:
      // identical outcome, still zero H.
      const executeHarness = makeHarness(scenario.overrides?.())
      const executed = await executeHarness.resolver.executeCommand(scenario.input)

      expect(executed, scenario.name).toEqual(scenario.expected)
      expect(executeHarness.executeMock, scenario.name).not.toHaveBeenCalled()
    }
  })

  it('preserves the quarantine asymmetry exactly', async () => {
    for (const scenario of nonVerifiedScenarios()) {
      const { resolver, markQuarantined } = makeHarness(scenario.overrides?.())
      resolver.verifyCommand(scenario.input)

      if (scenario.quarantines) {
        expect(markQuarantined, scenario.name).toHaveBeenCalledTimes(1)
      } else {
        expect(markQuarantined, scenario.name).not.toHaveBeenCalled()
      }
    }
  })

  it('never quarantines or executes H for a receipt that is already terminal', async () => {
    for (const receiptStatus of TERMINAL_STATUSES) {
      const { resolver, markQuarantined, executeMock } = makeHarness(
        withReceipt({ status: receiptStatus })()
      )

      const verified = resolver.verifyCommand(validInput())

      expect(verified, receiptStatus).toEqual({ kind: 'already_terminal', receiptStatus })
      expect(markQuarantined, receiptStatus).not.toHaveBeenCalled()
      expect(executeMock, receiptStatus).not.toHaveBeenCalled()
    }
  })

  it('surfaces quarantine_failed without executing H when quarantine itself fails', () => {
    const { resolver, executeMock } = makeHarness({
      envelope: {
        markQuarantined: vi.fn(() => {
          throw new Error('secret quarantine body')
        })
      },
      receipt: { getByCommandId: vi.fn().mockReturnValue({ kind: 'not_found' }) }
    })

    const verified = resolver.verifyCommand(validInput())

    expect(verified).toEqual({ kind: 'indeterminate', code: 'quarantine_failed' })
    expect(JSON.stringify(verified)).not.toContain('secret quarantine body')
    expect(executeMock).not.toHaveBeenCalled()
  })

  // --- Body-free reporting --------------------------------------------------

  it('leaks no store error text and no command body through any non-verified result', async () => {
    for (const scenario of nonVerifiedScenarios()) {
      const { resolver } = makeHarness(scenario.overrides?.())
      const verified = resolver.verifyCommand(scenario.input)
      const serialised = JSON.stringify(verified)

      expect(serialised, scenario.name).not.toContain('secret')
      expect(serialised, scenario.name).not.toContain('thread-1')
      expect(serialised, scenario.name).not.toContain('host.command')

      const keys = Object.keys(verified).sort()
      expect(keys, scenario.name).toEqual(
        verified.kind === 'already_terminal' ? ['kind', 'receiptStatus'] : ['code', 'kind']
      )
    }
  })
})
