import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source-shape contract for the host-stamped `origin` that rides a prompt
 * from the local-control socket into the transcript. `src/main/index.ts` is
 * the only place the bridge action meets the chat seed, the run payload, the
 * queued-prompt request and the ensemble steer lanes, and nothing imports it
 * under test — so the wiring is pinned by shape. Each `it` names one seam;
 * deleting that seam reds exactly that test.
 */
const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

const ORIGIN_FROM_ACTION = '...(action.origin ? { origin: action.origin } : {})'

function once(anchor: string): number {
  const first = main.indexOf(anchor)
  expect(first, `anchor missing: ${anchor}`).toBeGreaterThan(-1)
  expect(main.indexOf(anchor, first + 1), `anchor not unique: ${anchor}`).toBe(-1)
  return first
}

function windowAfter(anchor: string, span: number): string {
  const at = once(anchor)
  return main.slice(at, at + span)
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
    const queueCall = windowAfter('const queued = await queueRemoteComposerPrompt({', 1400)
    expect(queueCall).toContain(ORIGIN_FROM_ACTION)
  })

  it('ensembleSteerFn forwards action.origin to absorbMidRunSteering and startRound', () => {
    const absorb = windowAfter(
      'const absorbed = ensembleOrchestratorRef?.absorbMidRunSteering({',
      900
    )
    expect(absorb).toContain(ORIGIN_FROM_ACTION)
    const start = windowAfter('const result = ensembleOrchestratorRef?.startRound({', 1300)
    expect(start).toContain(ORIGIN_FROM_ACTION)
  })

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
