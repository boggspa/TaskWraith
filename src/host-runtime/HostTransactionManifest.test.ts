import { describe, expect, it } from 'vitest'

import type { HostReceiptStatus } from '../shared/hostProtocol'
import {
  HOST_EXECUTING_COMMAND_NAMES,
  hostCommandExecutionClassFor
} from './HostCommandExecutionClass'
import {
  decideHostTransactionRecovery,
  hostCommitWitness,
  hostTransactionRecordsCompactable,
  parseHostTransactionRecord,
  sameHostFileIdentity,
  type HostFileIdentity,
  type HostTransactionGroup,
  type HostTransactionPrepareRecord,
  type HostTransactionRecoveryAction,
  type HostTransactionRecoveryInput,
  type HostTransactionTerminalRecord
} from './HostTransactionManifest'

const PRIOR: HostFileIdentity = { dev: '16777232', ino: '1001', size: 4_096 }
const RESULTING: HostFileIdentity = { dev: '16777232', ino: '2002', size: 5_120 }
const OTHER: HostFileIdentity = { dev: '16777232', ino: '3003', size: 5_120 }
const DIGEST = 'a'.repeat(64)
const EPOCH = { hostIncarnation: 'b'.repeat(64), deleteCounter: 0 }
const END = { generation: 1, cursor: 40 }
/** Where a generation reset leaves the delta store. */
const RESET = { generation: 2, cursor: 1 }
const GROUP: HostTransactionGroup = { count: 3, setDigest: DIGEST, end: END }

function published(position = END): HostTransactionTerminalRecord {
  return { kind: 'published', commandId: 'cmd-1', position, at: 6 }
}
const PUBLISHED = published()
const ABORTED: HostTransactionTerminalRecord = {
  kind: 'abort',
  commandId: 'cmd-1',
  reason: 'interrupted',
  at: 5
}
const INDETERMINATE: HostTransactionTerminalRecord = {
  kind: 'indeterminate',
  commandId: 'cmd-1',
  reason: 'unknown_identity',
  at: 7
}

function prepareValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'prepare',
    commandId: 'cmd-1',
    threadId: 'chat-1',
    epoch: EPOCH,
    expectedRevision: 13,
    resultingRevision: 14,
    prior: PRIOR,
    resulting: RESULTING,
    effects: { count: 3, setDigest: DIGEST },
    preparedAt: 1_000,
    ...overrides
  }
}

function prepare(overrides: Record<string, unknown> = {}): HostTransactionPrepareRecord {
  const parsed = parseHostTransactionRecord(prepareValue(overrides))
  if (!parsed.ok || parsed.record.kind !== 'prepare') throw new Error('fixture is not a prepare')
  return parsed.record
}

function receipt(status: HostReceiptStatus) {
  return { status, recoveryState: null, commandClass: 'txn-record-persist' as const }
}

/** A pending receipt the store promoted when it reopened. */
function recoverable() {
  return {
    status: 'indeterminate' as const,
    recoveryState: 'recoverable-indeterminate' as const,
    commandClass: 'txn-record-persist' as const
  }
}

/** A persist that prepared a replacement of chat-1 and crashed; override what recovery finds. */
function found(
  overrides: Partial<HostTransactionRecoveryInput> = {}
): HostTransactionRecoveryInput {
  return {
    receipt: receipt('pending'),
    prepare: prepare(),
    terminal: null,
    observed: PRIOR,
    group: null,
    ...overrides
  }
}

describe('the commit witness', () => {
  it('is the chat file’s identity: the artifact’s means committed, the prior one’s means not', () => {
    const replacing = prepare()
    expect(hostCommitWitness(replacing, RESULTING)).toBe('committed')
    expect(hostCommitWitness(replacing, PRIOR)).toBe('not_committed')
    expect(hostCommitWitness(replacing, OTHER)).toBe('indeterminate')
    expect(hostCommitWitness(replacing, null)).toBe('indeterminate')
    // The size is part of the identity; the device number, which follows
    // mount order across a reboot, is not.
    expect(hostCommitWitness(replacing, { ...RESULTING, size: 5_121 })).toBe('indeterminate')
    expect(hostCommitWitness(replacing, { ...RESULTING, dev: '1' })).toBe('committed')
    expect(hostCommitWitness(replacing, { ...PRIOR, dev: '1' })).toBe('not_committed')

    // A thread with no file before: still absent means not committed.
    const creating = prepare({ prior: null })
    expect(hostCommitWitness(creating, null)).toBe('not_committed')
    expect(hostCommitWitness(creating, RESULTING)).toBe('committed')
    expect(hostCommitWitness(creating, OTHER)).toBe('indeterminate')
    expect(sameHostFileIdentity(PRIOR, { ...PRIOR })).toBe(true)
  })
})

describe('manifest records', () => {
  it('parses each kind strictly, and copies what it keeps', () => {
    const value = prepareValue()
    const parsed = parseHostTransactionRecord(value)
    expect(parsed).toEqual({ ok: true, record: value })
    ;(value.prior as { ino: string }).ino = '9'
    expect(parsed.ok && parsed.record.kind === 'prepare' && parsed.record.prior?.ino).toBe('1001')
    expect(parseHostTransactionRecord(prepareValue({ prior: null }))).toMatchObject({
      ok: true,
      record: { prior: null }
    })
    // A thread created by thread.create exists at revision 0: a persist over
    // it still has a prior file.
    expect(
      parseHostTransactionRecord(prepareValue({ expectedRevision: 0, resultingRevision: 1 }))
    ).toMatchObject({ ok: true })

    for (const record of [
      { kind: 'abort', commandId: 'cmd-1', reason: 'interrupted', at: 5 },
      { kind: 'published', commandId: 'cmd-1', position: END, at: 6 },
      { kind: 'indeterminate', commandId: 'cmd-1', reason: 'unknown_identity', at: 7 }
    ]) {
      expect(parseHostTransactionRecord(record)).toEqual({ ok: true, record })
    }
  })

  it('refuses malformed records with a reason', () => {
    const refusals: Array<[unknown, string]> = [
      [null, 'record_invalid'],
      [[], 'record_invalid'],
      [prepareValue({ commandId: '' }), 'record_invalid'],
      [prepareValue({ commandId: `c${String.fromCharCode(10)}` }), 'record_invalid'],
      [prepareValue({ kind: 'commit' }), 'kind_invalid'],
      [prepareValue({ threadId: '' }), 'prepare_invalid'],
      [prepareValue({ epoch: { hostIncarnation: '', deleteCounter: 0 } }), 'prepare_invalid'],
      [prepareValue({ epoch: { ...EPOCH, deleteCounter: -1 } }), 'prepare_invalid'],
      [prepareValue({ expectedRevision: 1.5 }), 'prepare_invalid'],
      [prepareValue({ resultingRevision: 13 }), 'prepare_invalid'],
      [prepareValue({ prior: { ...PRIOR, ino: '01' } }), 'prepare_invalid'],
      [prepareValue({ prior: { ...PRIOR, dev: 16777232 } }), 'prepare_invalid'],
      [prepareValue({ prior: undefined }), 'prepare_invalid'],
      [prepareValue({ resulting: null }), 'prepare_invalid'],
      [prepareValue({ resulting: { ...RESULTING, size: -1 } }), 'prepare_invalid'],
      [prepareValue({ effects: { count: 3, setDigest: 'A'.repeat(64) } }), 'prepare_invalid'],
      [prepareValue({ effects: { count: -1, setDigest: DIGEST } }), 'prepare_invalid'],
      [prepareValue({ preparedAt: -1 }), 'prepare_invalid'],
      [prepareValue({ resulting: { ...PRIOR } }), 'prepare_witnesses_nothing'],
      [prepareValue({ resulting: { ...PRIOR, dev: '1' } }), 'prepare_witnesses_nothing'],
      [{ kind: 'abort', commandId: 'cmd-1', reason: '', at: 5 }, 'abort_invalid'],
      [{ kind: 'abort', commandId: 'cmd-1', reason: 'x', at: 1.5 }, 'abort_invalid'],
      [
        { kind: 'indeterminate', commandId: 'cmd-1', reason: 'x'.repeat(257), at: 5 },
        'indeterminate_invalid'
      ],
      [
        { kind: 'published', commandId: 'cmd-1', position: { generation: 1 }, at: 5 },
        'published_invalid'
      ],
      [{ kind: 'published', commandId: 'cmd-1', position: END, at: -5 }, 'published_invalid']
    ]
    for (const [value, reason] of refusals) {
      expect(parseHostTransactionRecord(value)).toEqual({ ok: false, reason })
    }
  })
})

describe('recovery per Appendix D', () => {
  it('D1: a committed record whose effects were never published completes at a generation reset', () => {
    expect(decideHostTransactionRecovery(found({ observed: RESULTING }))).toEqual({
      action: 'reset_and_complete',
      row: 'D1'
    })
    // A created thread the same way.
    expect(
      decideHostTransactionRecovery(
        found({ prepare: prepare({ prior: null }), observed: RESULTING })
      )
    ).toEqual({ action: 'reset_and_complete', row: 'D1' })
    // Recorded published at the reset, the receipt not yet completed: it
    // completes there, with no group to find. The record says where, not any
    // group recovery might also find.
    for (const group of [null, GROUP]) {
      expect(
        decideHostTransactionRecovery(
          found({ observed: RESULTING, terminal: published(RESET), group })
        )
      ).toEqual({
        action: 'complete_at_position',
        row: 'D3',
        position: RESET,
        markPublished: false
      })
    }
  })

  it('D2: a torn group line is never visible, so it resolves as D1', () => {
    // The delta store drops a torn last line: recovery finds no group.
    expect(decideHostTransactionRecovery(found({ observed: RESULTING, group: null }))).toEqual({
      action: 'reset_and_complete',
      row: 'D1'
    })
  })

  it('D3: published effects complete the receipt where they were published, never twice', () => {
    expect(decideHostTransactionRecovery(found({ observed: RESULTING, group: GROUP }))).toEqual({
      action: 'complete_at_position',
      row: 'D3',
      position: END,
      markPublished: true
    })
    // The group carries the rows the change displaced from other threads, so
    // its set is not the prepare's: the group is its own witness.
    const displacing = { count: 7, setDigest: 'c'.repeat(64), end: END }
    expect(
      decideHostTransactionRecovery(found({ observed: RESULTING, group: displacing }))
    ).toEqual({ action: 'complete_at_position', row: 'D3', position: END, markPublished: true })
    // The receipt completed; only the manifest's mark was left.
    expect(
      decideHostTransactionRecovery(
        found({ observed: RESULTING, group: GROUP, receipt: receipt('succeeded') })
      )
    ).toEqual({ action: 'mark_published', row: 'D3', position: END })
    // Marked published before the receipt: the record says where, with or
    // without the group, which compaction may have dropped.
    for (const group of [GROUP, displacing, null]) {
      expect(decideHostTransactionRecovery(found({ terminal: PUBLISHED, group }))).toEqual({
        action: 'complete_at_position',
        row: 'D3',
        position: END,
        markPublished: false
      })
    }
  })

  it('D4: interrupted before the commit fails as interrupted, with nothing published', () => {
    // Prepared, the chat file still the prior one.
    expect(decideHostTransactionRecovery(found())).toEqual({
      action: 'fail_interrupted',
      row: 'D4',
      writeAbort: true,
      completeReceipt: true
    })
    // Prepared a create, the file still absent.
    expect(
      decideHostTransactionRecovery(found({ prepare: prepare({ prior: null }), observed: null }))
    ).toEqual({ action: 'fail_interrupted', row: 'D4', writeAbort: true, completeReceipt: true })
    // Admitted and never prepared: no manifest to abort.
    expect(decideHostTransactionRecovery(found({ prepare: null }))).toEqual({
      action: 'fail_interrupted',
      row: 'D4',
      writeAbort: false,
      completeReceipt: true
    })
    // Aborted, the receipt not yet completed.
    expect(decideHostTransactionRecovery(found({ terminal: ABORTED }))).toEqual({
      action: 'fail_interrupted',
      row: 'D4',
      writeAbort: false,
      completeReceipt: true
    })
    // The receipt failed before the abort was recorded.
    expect(decideHostTransactionRecovery(found({ receipt: receipt('failed') }))).toEqual({
      action: 'fail_interrupted',
      row: 'D4',
      writeAbort: true,
      completeReceipt: false
    })
  })

  it('decides a receipt the store promoted when it reopened as a pending one', () => {
    expect(
      decideHostTransactionRecovery(found({ receipt: recoverable(), observed: RESULTING }))
    ).toEqual({ action: 'reset_and_complete', row: 'D1' })
    expect(
      decideHostTransactionRecovery(
        found({ receipt: recoverable(), observed: RESULTING, group: GROUP })
      )
    ).toEqual({ action: 'complete_at_position', row: 'D3', position: END, markPublished: true })
    expect(decideHostTransactionRecovery(found({ receipt: recoverable() }))).toEqual({
      action: 'fail_interrupted',
      row: 'D4',
      writeAbort: true,
      completeReceipt: true
    })
    expect(decideHostTransactionRecovery(found({ receipt: recoverable(), prepare: null }))).toEqual(
      { action: 'fail_interrupted', row: 'D4', writeAbort: false, completeReceipt: true }
    )
    expect(
      decideHostTransactionRecovery(found({ receipt: recoverable(), observed: OTHER }))
    ).toEqual({ action: 'indeterminate', reason: 'unknown_identity' })
  })

  it('D6: a persist the lane refused behind a delete never prepared, and needs nothing', () => {
    expect(
      decideHostTransactionRecovery(found({ prepare: null, receipt: receipt('failed') }))
    ).toEqual({ action: 'none' })
  })

  it('does nothing for a command that finished, whatever has written the file since', () => {
    for (const observed of [RESULTING, PRIOR, OTHER, null]) {
      expect(
        decideHostTransactionRecovery(
          found({ terminal: PUBLISHED, group: GROUP, receipt: receipt('succeeded'), observed })
        )
      ).toEqual({ action: 'none' })
      expect(
        decideHostTransactionRecovery(
          found({ terminal: ABORTED, receipt: receipt('failed'), observed })
        )
      ).toEqual({ action: 'none' })
    }
    // Compaction dropped the manifest of a finished command.
    expect(
      decideHostTransactionRecovery(
        found({ prepare: null, group: GROUP, receipt: receipt('succeeded') })
      )
    ).toEqual({ action: 'none' })
    // Compaction dropped the group, or the receipt, of a finished command.
    expect(
      decideHostTransactionRecovery(
        found({ terminal: PUBLISHED, group: null, receipt: receipt('succeeded') })
      )
    ).toEqual({ action: 'none' })
    for (const terminal of [PUBLISHED, ABORTED, INDETERMINATE]) {
      expect(decideHostTransactionRecovery(found({ receipt: null, terminal }))).toEqual({
        action: 'none'
      })
    }
    // Nothing began.
    expect(decideHostTransactionRecovery(found({ receipt: null, prepare: null }))).toEqual({
      action: 'none'
    })
  })

  it('is indeterminate wherever the evidence contradicts itself or witnesses nothing', () => {
    const cases: Array<[Partial<HostTransactionRecoveryInput>, string]> = [
      [{ receipt: null }, 'receipt_missing'],
      [{ prepare: null, group: GROUP }, 'group_without_manifest'],
      [{ terminal: ABORTED, observed: RESULTING }, 'aborted_but_committed'],
      [{ terminal: ABORTED, group: GROUP }, 'aborted_but_published'],
      [{ terminal: ABORTED, receipt: receipt('succeeded') }, 'aborted_but_succeeded'],
      [
        { terminal: PUBLISHED, group: GROUP, receipt: receipt('failed') },
        'published_but_receipt_failed'
      ],
      [
        { terminal: published(RESET), receipt: receipt('cancelled') },
        'published_but_receipt_failed'
      ],
      [{ observed: PRIOR, group: GROUP }, 'group_without_commit'],
      [
        { observed: RESULTING, group: GROUP, receipt: receipt('failed') },
        'group_but_receipt_failed'
      ],
      [{ observed: RESULTING, receipt: receipt('conflict') }, 'committed_but_receipt_failed'],
      // Completed before its reset was recorded: not the order D1 takes.
      [{ observed: RESULTING, receipt: receipt('succeeded') }, 'succeeded_without_group'],
      [{ observed: OTHER }, 'unknown_identity'],
      [{ observed: null }, 'unknown_identity']
    ]
    for (const [overrides, reason] of cases) {
      expect(decideHostTransactionRecovery(found(overrides))).toEqual({
        action: 'indeterminate',
        reason
      })
    }
  })

  it('treats indeterminate as final', () => {
    expect(
      decideHostTransactionRecovery(found({ observed: OTHER, terminal: INDETERMINATE }))
    ).toEqual({ action: 'none' })
    expect(
      decideHostTransactionRecovery(found({ observed: OTHER, receipt: receipt('indeterminate') }))
    ).toEqual({ action: 'none' })
    expect(
      decideHostTransactionRecovery(found({ receipt: null, terminal: INDETERMINATE }))
    ).toEqual({ action: 'none' })
    // Recorded without a prepare: recovery found a group and no manifest.
    expect(
      decideHostTransactionRecovery(
        found({ receipt: recoverable(), prepare: null, group: GROUP, terminal: INDETERMINATE })
      )
    ).toEqual({ action: 'none' })
    expect(
      decideHostTransactionRecovery(
        found({ receipt: recoverable(), observed: OTHER, terminal: INDETERMINATE })
      )
    ).toEqual({ action: 'none' })
  })

  it('leaves every other class to the existing recovery', () => {
    const flags = { txnRecordPersist: false, queuedStart: true }
    const others = new Set(
      HOST_EXECUTING_COMMAND_NAMES.map((name) => hostCommandExecutionClassFor(name, flags))
    )
    expect(others.has('txn-record-persist')).toBe(false)
    for (const commandClass of others) {
      expect(
        decideHostTransactionRecovery(
          found({
            receipt: { status: 'pending', recoveryState: null, commandClass },
            observed: RESULTING
          })
        )
      ).toEqual({ action: 'not_transactional' })
    }
  })
})

describe('manifest compaction', () => {
  it('keeps a command’s records until its receipt is terminal', () => {
    for (const status of ['succeeded', 'failed', 'denied', 'cancelled', 'conflict'] as const) {
      expect(hostTransactionRecordsCompactable(receipt(status))).toBe(true)
    }
    // Receipt compaction drops only terminal receipts.
    expect(hostTransactionRecordsCompactable(null)).toBe(true)
    // An indeterminate decision is final only through its manifest record.
    expect(hostTransactionRecordsCompactable(receipt('pending'))).toBe(false)
    expect(hostTransactionRecordsCompactable(recoverable())).toBe(false)
    expect(hostTransactionRecordsCompactable(receipt('indeterminate'))).toBe(false)
  })
})

/**
 * What the recovery driver does for each action, over the state recovery
 * reads: the receipt, the manifest's terminal record and the group.
 */
function apply(
  input: HostTransactionRecoveryInput,
  action: HostTransactionRecoveryAction
): HostTransactionRecoveryInput {
  // Completing a receipt clears the store's recoverable mark.
  const complete = (status: HostReceiptStatus) =>
    input.receipt === null
      ? null
      : { status, recoveryState: null, commandClass: input.receipt.commandClass }
  switch (action.action) {
    case 'none':
    case 'not_transactional':
      return input
    case 'reset_and_complete':
      // The reset clears every group of the old generation.
      return {
        ...input,
        group: null,
        terminal: published(RESET),
        receipt: complete('succeeded')
      }
    case 'complete_at_position':
      return {
        ...input,
        receipt: complete('succeeded'),
        ...(action.markPublished ? { terminal: published(action.position) } : {})
      }
    case 'mark_published':
      return { ...input, terminal: published(action.position) }
    case 'fail_interrupted':
      return {
        ...input,
        ...(action.writeAbort ? { terminal: ABORTED } : {}),
        ...(action.completeReceipt ? { receipt: complete('failed') } : {})
      }
    case 'indeterminate':
      // The store marks a pending receipt recoverable indeterminate; the
      // manifest's record is what makes it final.
      return {
        ...input,
        terminal: INDETERMINATE,
        ...(input.receipt?.status === 'pending' ? { receipt: recoverable() } : {})
      }
  }
}

/** The statuses receipt compaction may drop. */
const TERMINAL_RECEIPTS = new Set<HostReceiptStatus>([
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'conflict'
])

/**
 * Every state compaction may leave: the delta store drops any group, the
 * receipt store drops only terminal receipts, and the manifest drops a
 * command's records only as `hostTransactionRecordsCompactable` allows.
 */
function compactions(state: HostTransactionRecoveryInput): HostTransactionRecoveryInput[] {
  const compactable = hostTransactionRecordsCompactable(state.receipt)
  const receiptDroppable = state.receipt !== null && TERMINAL_RECEIPTS.has(state.receipt.status)
  const states: HostTransactionRecoveryInput[] = []
  for (const group of state.group === null ? [null] : [state.group, null]) {
    for (const receiptState of receiptDroppable ? [state.receipt, null] : [state.receipt]) {
      for (const manifest of compactable ? [true, false] : [true]) {
        states.push({
          ...state,
          group,
          receipt: receiptState,
          ...(manifest ? {} : { prepare: null, terminal: null })
        })
      }
    }
  }
  return states
}

describe('recovery twice', () => {
  it('decides nothing the second time, for every state recovery can find', () => {
    const receipts: HostTransactionRecoveryInput['receipt'][] = [
      null,
      ...(
        ['pending', 'succeeded', 'failed', 'cancelled', 'conflict', 'indeterminate'] as const
      ).map(receipt),
      recoverable()
    ]
    const prepares = [null, prepare(), prepare({ prior: null })]
    const terminals = [null, ABORTED, PUBLISHED, published(RESET), INDETERMINATE]
    const observations = [null, PRIOR, RESULTING, OTHER]
    const groups = [null, GROUP, { ...GROUP, setDigest: 'c'.repeat(64) }]
    let states = 0
    let compacted = 0
    const actions = new Set<string>()
    for (const receiptState of receipts) {
      for (const prepareState of prepares) {
        for (const terminal of terminals) {
          // A terminal record belongs to a prepared command, except an
          // indeterminate one recovery wrote without a prepare.
          if (prepareState === null && terminal !== null && terminal.kind !== 'indeterminate') {
            continue
          }
          for (const observed of observations) {
            for (const group of groups) {
              const state = {
                receipt: receiptState,
                prepare: prepareState,
                terminal,
                observed,
                group
              }
              const first = decideHostTransactionRecovery(state)
              actions.add(first.action)
              // Recovery again, after whatever compaction the rules allow.
              for (const after of compactions(apply(state, first))) {
                const second = decideHostTransactionRecovery(after)
                expect({ state, first, after, second: second.action }).toEqual({
                  state,
                  first,
                  after,
                  second: 'none'
                })
                compacted += 1
              }
              states += 1
            }
          }
        }
      }
    }
    expect(states).toBeGreaterThan(500)
    expect(compacted).toBeGreaterThan(2 * states)
    // Every action the table has was reached.
    expect([...actions].sort()).toEqual([
      'complete_at_position',
      'fail_interrupted',
      'indeterminate',
      'mark_published',
      'none',
      'reset_and_complete'
    ])
  })
})
