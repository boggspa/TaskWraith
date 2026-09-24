import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../../../main/mainSourceProbe.testutil'

/**
 * An ensemble send consumes the composer draft at gesture time.
 *
 * `runEnsembleRound` resolves only after main's round-start durability barrier,
 * which on a large thread is a full-record Host write measured in seconds.
 * Clearing the draft after that await left the submitted text sitting in the
 * composer for the whole write, so Enter looked ignored. The steer lane already
 * consumes the draft up front with edit-aware rollback; the ordinary send must
 * do the same.
 *
 * App.tsx has no DOM test environment, so this pins the wiring by call
 * position inside `executeRun`. The rollback behaviour itself is tested in
 * composerDraftSubmission.test.ts.
 */
describe('ensemble send consumes the composer draft before main acknowledges', () => {
  const probe = new MainSourceProbe('App.tsx', new URL('../App.tsx', import.meta.url))
  const executeRun = probe.fn('executeRun')
  // Scope every claim to the ensemble branch: the solo branch below it has its
  // own queue-time clear that this change deliberately leaves alone.
  const ensembleBranch = ((): ts.IfStatement => {
    let found: ts.IfStatement | undefined
    const visit = (node: ts.Node): void => {
      if (
        !found &&
        ts.isIfStatement(node) &&
        probe.text(node.expression) === "runChat.chatKind === 'ensemble'"
      ) {
        found = node
      }
      ts.forEachChild(node, visit)
    }
    visit(executeRun)
    if (!found) throw new Error("executeRun has no `runChat.chatKind === 'ensemble'` branch")
    return found
  })()
  const start = (node: ts.Node): number => node.getStart(probe.source)
  const callsTo = (name: string): ts.CallExpression[] => probe.callsTo(ensembleBranch, name)
  const onlyCall = (name: string): ts.CallExpression => {
    const calls = callsTo(name)
    expect(calls).toHaveLength(1)
    return calls[0]
  }
  const receiptCalls = (method: string): ts.CallExpression[] =>
    callsTo(method).filter((call) => probe.text(call.expression).startsWith('ensembleSendDraft'))

  it('clears the draft before the round IPC and before the seat-change wait', () => {
    const begin = onlyCall('beginComposerDraftSubmission')
    const dispatch = onlyCall('runEnsembleRound')
    const seatWait = probe
      .callsTo(ensembleBranch, 'get')
      .find((call) => probe.text(call).includes('authoritativeParticipantSeatChangeQueueRef'))
    expect(seatWait).toBeDefined()
    expect(start(begin)).toBeLessThan(start(seatWait!))
    expect(start(begin)).toBeLessThan(start(dispatch))
    expect(probe.text(begin)).toContain('setDraft: setChatPromptDraft')
  })

  it('never consumes a draft the request did not read', () => {
    const begin = probe.text(onlyCall('beginComposerDraftSubmission'))
    const declaration = probe.text(ensembleBranch)
    const at = declaration.indexOf(begin)
    const guard = declaration.slice(Math.max(0, at - 240), at)
    expect(guard).toContain('request.existingPrompt')
    expect(guard).toContain('request.preserveComposer')
  })

  it('restores the draft on a refusal and on a throw, and commits on acceptance', () => {
    const dispatch = start(onlyCall('runEnsembleRound'))
    const restores = receiptCalls('restoreIfUntouched')
    const commits = receiptCalls('commit')
    expect(restores).toHaveLength(2)
    expect(commits).toHaveLength(1)
    for (const call of [...restores, ...commits]) {
      expect(start(call)).toBeGreaterThan(dispatch)
    }
    expect(
      restores.some((call) => isInsideCatchClause(call)),
      'the catch clause must restore the draft'
    ).toBe(true)
  })

  it('keeps the post-acceptance clear only for a draft it could not consume', () => {
    const clears = probe
      .callsTo(ensembleBranch, 'setChatPromptDraft')
      .filter((call) => probe.text(call).includes("runChat.appChatId, ''"))
    expect(clears).toHaveLength(1)
    const declaration = probe.text(ensembleBranch)
    const at = declaration.indexOf(probe.text(clears[0]))
    expect(declaration.slice(Math.max(0, at - 200), at)).toContain('!ensembleSendDraft')
  })
})

function isInsideCatchClause(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCatchClause(current)) return true
  }
  return false
}
