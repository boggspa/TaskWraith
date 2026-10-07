import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../../../main/mainSourceProbe.testutil'
import { preDispatchFailurePrompt } from './preDispatchFailureRows'

const base = {
  dispatchAccepted: false,
  ensembleRoundIpcInvoked: false,
  promptRowWritten: false,
  prompt: '  summarise the diff  '
}

describe('which prompt a pre-dispatch failure lands before its error row', () => {
  it('lands a solo prompt that threw before dispatch', () => {
    expect(preDispatchFailurePrompt({ ...base, chatKind: 'single' })).toBe('summarise the diff')
  })

  it('prefers the display prompt over the wire prompt', () => {
    expect(
      preDispatchFailurePrompt({ ...base, chatKind: 'single', displayPrompt: 'shown text' })
    ).toBe('shown text')
  })

  // THE INCIDENT: hydrating an ensemble thread threw "TaskWraith Host
  // disconnected." before runEnsembleRound, and the prompt survived only in
  // the composer because ensemble chats were excluded wholesale.
  it('lands an ensemble prompt when the round IPC was never invoked', () => {
    expect(preDispatchFailurePrompt({ ...base, chatKind: 'ensemble' })).toBe('summarise the diff')
  })

  it('lands nothing extra when the ensemble round IPC was invoked and threw', () => {
    expect(
      preDispatchFailurePrompt({ ...base, chatKind: 'ensemble', ensembleRoundIpcInvoked: true })
    ).toBeNull()
  })

  it('lands nothing extra once main accepted the ensemble dispatch', () => {
    expect(
      preDispatchFailurePrompt({
        ...base,
        chatKind: 'ensemble',
        dispatchAccepted: true,
        ensembleRoundIpcInvoked: true
      })
    ).toBeNull()
  })

  it('lands nothing for an existing prompt (edit-and-resend / retry)', () => {
    for (const chatKind of ['single', 'ensemble']) {
      expect(
        preDispatchFailurePrompt({ ...base, chatKind, existingPrompt: 'summarise the diff' })
      ).toBeNull()
    }
  })

  it('lands nothing when the prompt row is already written', () => {
    for (const chatKind of ['single', 'ensemble']) {
      expect(preDispatchFailurePrompt({ ...base, chatKind, promptRowWritten: true })).toBeNull()
    }
  })

  it('lands nothing for an empty prompt', () => {
    expect(preDispatchFailurePrompt({ ...base, chatKind: 'ensemble', prompt: '   ' })).toBeNull()
  })
})

/**
 * App.tsx has no DOM test environment, so this pins executeRun's wiring: the
 * flag must be raised as the statement directly before the round IPC (any
 * earlier and a pre-IPC throw would land nothing; any later and an IPC throw
 * would land a duplicate), and the outer catch must consult it.
 */
describe('executeRun wires the round-IPC flag into its outer catch', () => {
  const probe = new MainSourceProbe('App.tsx', new URL('../App.tsx', import.meta.url))
  const executeRun = probe.fn('executeRun')

  it('raises ensembleRoundIpcInvoked immediately before runEnsembleRound', () => {
    const [call] = probe.callsTo(executeRun, 'runEnsembleRound')
    expect(call).toBeDefined()
    let statement: ts.Node = call
    while (!ts.isBlock(statement.parent)) statement = statement.parent
    const block = statement.parent as ts.Block
    const index = block.statements.indexOf(statement as ts.Statement)
    expect(index).toBeGreaterThan(0)
    expect(probe.text(block.statements[index - 1])).toBe('ensembleRoundIpcInvoked = true')
  })

  it('passes the flag and dispatch acceptance to preDispatchFailurePrompt', () => {
    const [call] = probe.callsTo(executeRun, 'preDispatchFailurePrompt')
    expect(call).toBeDefined()
    expect(probe.propText(call, 0, 'ensembleRoundIpcInvoked')).toBe('ensembleRoundIpcInvoked')
    expect(probe.propText(call, 0, 'dispatchAccepted')).toBe('dispatchAccepted')
    expect(probe.propText(call, 0, 'promptRowWritten')).toBe('promptRowWritten')
  })
})
