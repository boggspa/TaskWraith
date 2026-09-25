/**
 * Controls reach a chat record only through the run port (Independent
 * Threads M4, slice 13b; NH-3 as revised by §23.1).
 *
 * Controls keep their FIFO bypass and take no thread lane. That is safe
 * because nothing in a control's branch writes a chat record itself: the one
 * record write a control causes is a provider's cancel callback calling
 * `runPort.updateRun` (Codex, Devin, Grok, Kimi, Mistral), a synchronous
 * run-port write the transaction's synchronous check-and-rename already
 * orders against.
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { MainSourceProbe } from '../main/mainSourceProbe.testutil'

/** Every store method that writes a chat file (the recon's list, §23.1). */
const STORE_WRITERS = [
  'createThread',
  'configureThread',
  'setThreadKind',
  'archiveThread',
  'deleteThreadRecord',
  'persistThreadRecord',
  'appendTranscript',
  'recordRunTool',
  'updateRun',
  'writeThread'
] as const

const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['run.cancel', 'cancelThread'],
  ['approval.decide', 'decide'],
  ['question.answer', 'answer']
]

/** Body of `class Name { method(...) {...} }`. Throws when absent. */
function methodBody(probe: MainSourceProbe, className: string, method: string): ts.Node {
  let found: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === method &&
          member.body
        ) {
          found = member.body
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(probe.source)
  if (!found) {
    throw new Error(`${className}.${method} is gone; update this closure to what replaced it`)
  }
  return found
}

describe('controls write no chat record inside the command (M4 slice 13b, NH-3)', () => {
  const ports = new MainSourceProbe(
    'HostNodeDomainPorts.ts',
    new URL('./HostNodeDomainPorts.ts', import.meta.url)
  )

  for (const [name, entry] of CONTROLS) {
    it(`${name} calls no store writer, only its own entry point`, () => {
      const execute = methodBody(ports, 'HostNodeDomainPorts', 'executeCommand')
      const branch = ports.guard(execute, `command.name === '${name}'`)
      // Not vacuous: the branch is the control's, calling what it should.
      expect(ports.callsTo(branch, entry).length).toBeGreaterThan(0)
      for (const writer of STORE_WRITERS) {
        expect(ports.callsTo(branch, writer).map((call) => ports.text(call))).toEqual([])
      }
    })
  }

  it('the run port cancels without writing a record itself', () => {
    const runPort = new MainSourceProbe(
      'HostNodeProfileRunPort.ts',
      new URL('./HostNodeProfileRunPort.ts', import.meta.url)
    )
    const cancel = methodBody(runPort, 'HostNodeProfileRunPort', 'cancelThread')
    expect(runPort.callsTo(cancel, 'cancel').length).toBeGreaterThan(0)
    for (const writer of STORE_WRITERS) {
      expect(runPort.callsTo(cancel, writer).map((call) => runPort.text(call))).toEqual([])
    }
  })
})
