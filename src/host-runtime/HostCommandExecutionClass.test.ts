import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import type { HostCommandName } from '../shared/hostProtocol'
import {
  HOST_COMMAND_EXECUTION_CLASS,
  HOST_EXECUTING_COMMAND_NAMES,
  TASKWRAITH_HOST_TXN_PERSIST_ENV,
  classifyHostCommandExecution,
  hostCommandExecutionClassFor,
  isHostTxnRecordPersistEnabled,
  type HostCommandExecutionClass,
  type HostCommandExecutionFlags
} from './HostCommandExecutionClass'
import { HOST_COMMAND_NAMES, HOST_SETUP_MUTATION_COMMAND_NAMES } from './HostCommandRouting'

/** Each executing command's class with both flags on (test oracle). */
const EXPECTED: Readonly<Record<string, HostCommandExecutionClass>> = {
  'thread.record.persist': 'txn-record-persist',
  'composer.send': 'queued-start',
  'run.cancel': 'control',
  'question.answer': 'control',
  'approval.decide': 'control',
  'ensemble.seat.toggle': 'legacy-observed',
  'thread.record.delete': 'legacy-observed',
  'thread.select': 'legacy-observed',
  'channel.member.revoke': 'legacy-observed',
  'channel.close': 'legacy-observed',
  'workspace.record.upsert': 'legacy-observed',
  'workspace.record.remove': 'legacy-observed',
  'workspace.records.clear': 'legacy-observed',
  'workspace.register': 'setup',
  'thread.create': 'setup',
  'thread.configure': 'setup',
  'thread.archive': 'setup',
  'provider.auth.begin': 'setup',
  'provider.auth.cancel': 'setup'
}
const READ_ALIASES: readonly HostCommandName[] = [
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'ping'
]
/** The commands whose target is a thread (`HostCommandFingerprint` target rules). */
const THREAD_TARGETED: readonly HostCommandName[] = [
  'composer.send',
  'run.cancel',
  'ensemble.seat.toggle',
  'thread.record.persist',
  'thread.record.delete',
  'thread.select',
  'thread.configure',
  'thread.archive'
]
const BOTH_ON: HostCommandExecutionFlags = { txnRecordPersist: true, queuedStart: true }
const BOTH_OFF: HostCommandExecutionFlags = { txnRecordPersist: false, queuedStart: false }

describe('HostCommandExecutionClass', () => {
  it('gives every executing command exactly one class, and no read alias one', () => {
    expect([...HOST_EXECUTING_COMMAND_NAMES].sort()).toEqual(Object.keys(EXPECTED).sort())
    expect(HOST_EXECUTING_COMMAND_NAMES.length + READ_ALIASES.length).toBe(
      HOST_COMMAND_NAMES.length
    )
    expect(new Set<string>([...HOST_EXECUTING_COMMAND_NAMES, ...READ_ALIASES])).toEqual(
      new Set<string>(HOST_COMMAND_NAMES)
    )
    for (const name of HOST_COMMAND_NAMES) {
      expect(classifyHostCommandExecution(name, BOTH_ON)).toBe(EXPECTED[name] ?? null)
    }
  })

  it.each(Object.entries(EXPECTED))('%s runs as %s with both flags on', (name, expected) => {
    expect(HOST_COMMAND_EXECUTION_CLASS[name as keyof typeof HOST_COMMAND_EXECUTION_CLASS]).toBe(
      expected
    )
    expect(classifyHostCommandExecution(name, BOTH_ON)).toBe(expected)
  })

  it('keeps each flagged command on today’s legacy path while its own flag is off', () => {
    const classes = (flags: HostCommandExecutionFlags) =>
      Object.fromEntries(
        HOST_EXECUTING_COMMAND_NAMES.map((name) => [
          name,
          hostCommandExecutionClassFor(name, flags)
        ])
      )
    expect(classes(BOTH_OFF)).toEqual({
      ...EXPECTED,
      'thread.record.persist': 'legacy-observed',
      'composer.send': 'legacy-observed'
    })
    expect(classes({ txnRecordPersist: true, queuedStart: false })).toEqual({
      ...EXPECTED,
      'composer.send': 'legacy-observed'
    })
    expect(classes({ txnRecordPersist: false, queuedStart: true })).toEqual({
      ...EXPECTED,
      'thread.record.persist': 'legacy-observed'
    })
    // Only `true` enables: a truthy non-boolean from an untyped caller does not.
    const loose = {
      txnRecordPersist: 'yes',
      queuedStart: 1
    } as unknown as HostCommandExecutionFlags
    expect(hostCommandExecutionClassFor('thread.record.persist', loose)).toBe('legacy-observed')
    expect(hostCommandExecutionClassFor('composer.send', loose)).toBe('legacy-observed')
  })

  it('admits nothing by target: of the thread-targeted commands only the persist is transactional', () => {
    const transactional = THREAD_TARGETED.filter(
      (name) => classifyHostCommandExecution(name, BOTH_ON) === 'txn-record-persist'
    )
    expect(transactional).toEqual(['thread.record.persist'])
    expect(
      new Set(THREAD_TARGETED.map((name) => classifyHostCommandExecution(name, BOTH_ON)))
    ).toEqual(
      new Set(['txn-record-persist', 'queued-start', 'control', 'legacy-observed', 'setup'])
    )
  })

  it('agrees with the routing partition: the setup class is exactly the setup mutations', () => {
    const setup = HOST_EXECUTING_COMMAND_NAMES.filter(
      (name) => HOST_COMMAND_EXECUTION_CLASS[name] === 'setup'
    )
    expect([...setup].sort()).toEqual([...HOST_SETUP_MUTATION_COMMAND_NAMES].sort())
  })

  it('fails closed on unknown names, read aliases and non-strings', () => {
    for (const value of [
      ...READ_ALIASES,
      'thread.persist',
      'THREAD.RECORD.PERSIST',
      ' thread.record.persist',
      '',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      42,
      null,
      undefined,
      {},
      ['thread.record.persist']
    ]) {
      expect(classifyHostCommandExecution(value, BOTH_ON)).toBeNull()
    }
  })

  it('reads the transactional flag from the exact token 1 only', () => {
    expect(TASKWRAITH_HOST_TXN_PERSIST_ENV).toBe('TASKWRAITH_HOST_TXN_PERSIST')
    expect(isHostTxnRecordPersistEnabled({ TASKWRAITH_HOST_TXN_PERSIST: '1' })).toBe(true)
    for (const value of [undefined, '', '0', 'true', 'TRUE', 'on', '01', ' 1', '1 ', '1\n']) {
      expect(isHostTxnRecordPersistEnabled({ TASKWRAITH_HOST_TXN_PERSIST: value })).toBe(false)
    }
    expect(isHostTxnRecordPersistEnabled({})).toBe(false)
    expect(isHostTxnRecordPersistEnabled({ TASKWRAITH_HOST_QUEUED_START: '1' })).toBe(false)
  })
})

/**
 * The map describes today's routing until the integration slice routes the
 * authority through it. A structural read of `AppStoreHostAuthority`, which
 * throws when its subject moves rather than passing over nothing.
 */
describe('HostCommandExecutionClass against the authority’s routing today', () => {
  const file = 'src/host-runtime/AppStoreHostAuthority.ts'
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL('./AppStoreHostAuthority.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )

  function method(className: string, name: string): ts.MethodDeclaration {
    let found: ts.MethodDeclaration | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name?.text === className) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name.getText(source) === name) {
            found = member
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (!found?.body) {
      throw new Error(`${file} declares no ${className}.${name}; update this test to its successor`)
    }
    return found
  }

  /** String literals compared with `command?.name ===` anywhere inside `scope`. */
  function namesComparedIn(scope: ts.Node): string[] {
    const names: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        node.left.getText(source).replace(/\s+/g, '') === 'command?.name' &&
        ts.isStringLiteral(node.right)
      ) {
        names.push(node.right.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(scope)
    return names
  }

  function firstIf(scope: ts.Node): ts.IfStatement {
    let found: ts.IfStatement | undefined
    const visit = (node: ts.Node): void => {
      if (found) return
      if (ts.isIfStatement(node)) {
        found = node
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(scope)
    if (!found) throw new Error(`${file}: command() no longer opens with its FIFO bypass`)
    return found
  }

  it('its FIFO bypass is the control class plus the queued start', () => {
    const bypass = firstIf(method('AppStoreHostAuthority', 'command').body!)
    const control = HOST_EXECUTING_COMMAND_NAMES.filter(
      (name) => HOST_COMMAND_EXECUTION_CLASS[name] === 'control'
    )
    expect(namesComparedIn(bypass.expression).sort()).toEqual([...control].sort())
    // The rest of the bypass is the queued start, which covers composer.send only.
    expect(bypass.expression.getText(source)).toContain('this.usesQueuedComposerSend(command)')
    const queued = HOST_EXECUTING_COMMAND_NAMES.filter(
      (name) => HOST_COMMAND_EXECUTION_CLASS[name] === 'queued-start'
    )
    expect(
      namesComparedIn(method('AppStoreHostAuthority', 'usesQueuedComposerSend').body!)
    ).toEqual(queued)
  })
})
