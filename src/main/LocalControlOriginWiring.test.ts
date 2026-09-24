import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Source-shape contract for the host-stamped `origin` that rides a prompt
 * from the local-control socket into the transcript. `src/main/index.ts` is
 * the only place the bridge action meets the chat seed, the run payload, the
 * queued-prompt request and the ensemble steer lanes, and nothing imports it
 * under test — so the wiring is pinned by shape. Each assertion names its
 * seam; wrapped-call mutation tests remove only that seam's origin spread.
 */
const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const parsedMain = ts.createSourceFile('index.ts', main, ts.ScriptTarget.Latest, true)

const ORIGIN_FROM_ACTION = '...(action.origin ? { origin: action.origin } : {})'
const WRAPPED_CALLS = {
  queue: {
    anchor: 'const queued = await queueRemoteComposerPrompt(',
    callee: 'queueRemoteComposerPrompt'
  },
  ensemble: {
    anchor: 'const result = dispatchObservedHostBridgeRound(',
    callee: 'dispatchObservedHostBridgeRound'
  }
} as const

function once(anchor: string, source = main): number {
  const first = source.indexOf(anchor)
  expect(first, `anchor missing: ${anchor}`).toBeGreaterThan(-1)
  expect(source.indexOf(anchor, first + 1), `anchor not unique: ${anchor}`).toBe(-1)
  return first
}

function windowAfter(anchor: string, span: number): string {
  const at = once(anchor)
  return main.slice(at, at + span)
}

function expectWrappedCallOrigin(source: ts.SourceFile, seam: keyof typeof WRAPPED_CALLS): ts.Node {
  const { anchor, callee } = WRAPPED_CALLS[seam]
  const start = once(anchor, source.text) + anchor.indexOf(callee)
  let call: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.getStart(source) === start) {
      call = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!call) throw new Error(`${seam}: wrapped call missing`)

  if (seam === 'ensemble') {
    const callback = call.arguments[1]
    if (!callback || !ts.isArrowFunction(callback) || !ts.isCallExpression(callback.body)) {
      throw new Error('ensemble: round dispatch callback missing')
    }
    call = callback.body
    expect(call.expression.getText(source)).toBe('ensembleOrchestratorRef?.startRound')
  }

  const request = call.arguments[0]
  if (!request || !ts.isObjectLiteralExpression(request)) {
    throw new Error(`${seam}: request object missing`)
  }
  // Inspect only direct request properties: a sibling argument, another call
  // or a nested object must not satisfy this forwarding contract.
  const origin = request.properties.find(
    (property) => ts.isSpreadAssignment(property) && property.getText(source) === ORIGIN_FROM_ACTION
  )
  if (!origin) throw new Error(`${seam}: request must forward action.origin`)
  return origin
}

describe('local-control origin wiring in src/main/index.ts', () => {
  it('imports the ChatMessageOrigin type from the shared module', () => {
    expect(main).toContain("import type { ChatMessageOrigin } from '../shared/messageOrigin'")
  })

  it('prepareIosComposerPromptChat accepts a host-stamped origin and stamps it on the seeded user row', () => {
    const args = windowAfter('function prepareIosComposerPromptChat(args: {', 1400)
    expect(args).toContain('origin?: ChatMessageOrigin')
    const row = windowAfter('id: `ios-user-${randomUUID()}`', 700)
    expect(row).toContain('|| args.origin')
    expect(row).toContain('...(args.origin ? { origin: args.origin } : {})')
  })

  it('composerPromptFn forwards action.origin into the chat seed and the run payload', () => {
    const seed = windowAfter('let chat = prepareIosComposerPromptChat({', 320)
    expect(seed).toContain(ORIGIN_FROM_ACTION)
    const payload = windowAfter(
      '...(iosImagePaths.length ? { imagePaths: iosImagePaths } : {}),',
      240
    )
    expect(payload).toContain(ORIGIN_FROM_ACTION)
  })

  it('a queued phone or socket prompt keeps its origin in the run-queue request', () => {
    const enqueue = windowAfter('const queueJob = {', 3600)
    const remoteComposer = enqueue.indexOf('remoteComposer: {')
    expect(remoteComposer, 'queueJob.request.remoteComposer missing').toBeGreaterThan(-1)
    expect(enqueue.slice(remoteComposer)).toContain(ORIGIN_FROM_ACTION)
    expectWrappedCallOrigin(parsedMain, 'queue')
  })

  it('attributes the solo turn prompt, so a single-provider chat is told too', () => {
    expect(main).toContain("import { externalAgentAttribution } from '../shared/messageOrigin'")
    const build = windowAfter(
      'const soloOriginAttribution = externalAgentAttribution(',
      520
    ).replace(/\s+/g, ' ')
    // The attribution wraps the RESOLVED body, so a queued prompt flushed
    // later is attributed exactly like one that arrived live.
    expect(build).toContain('internalQueueDispatch?.providerPrompt ??')
    expect(build).toContain(
      'const providerPrompt = soloOriginAttribution ? `${soloOriginAttribution}\\n${providerPromptBody}` : providerPromptBody'
    )
  })

  it('ensembleSteerFn forwards action.origin to absorbMidRunSteering and startRound', () => {
    const absorb = windowAfter(
      'const absorbed = ensembleOrchestratorRef?.absorbMidRunSteering({',
      900
    )
    expect(absorb).toContain(ORIGIN_FROM_ACTION)
    expectWrappedCallOrigin(parsedMain, 'ensemble')
  })

  it.each(['queue', 'ensemble'] as const)(
    'rejects removal of origin from the exact %s request even when other forwards remain',
    (seam) => {
      const origin = expectWrappedCallOrigin(parsedMain, seam)
      const end = origin.end + (main[origin.end] === ',' ? 1 : 0)
      const withoutOrigin = main.slice(0, origin.getStart(parsedMain)) + main.slice(end)
      expect(withoutOrigin).toContain(ORIGIN_FROM_ACTION)
      const parsed = ts.createSourceFile('index.ts', withoutOrigin, ts.ScriptTarget.Latest, true)
      expect(() => expectWrappedCallOrigin(parsed, seam)).toThrow(
        `${seam}: request must forward action.origin`
      )
    }
  )

  it('the appendMidRunSteering dep forwards origin into the live-round steer row', () => {
    const dep = windowAfter(
      'appendMidRunSteering: ({ chatId, text, imageAttachments, imageThumbnails, origin }) =>',
      260
    ).replace(/\s+/g, ' ')
    expect(dep).toContain(
      'appendEnsembleSteerIntoLiveRound(chatId, text, { imageAttachments, imageThumbnails, origin })'
    )
    const live = windowAfter('function appendEnsembleSteerIntoLiveRound(', 1600)
    expect(live).toContain('origin?: ChatMessageOrigin')
    expect(live).toContain('...(extras?.origin ? { origin: extras.origin } : {})')
  })
})
