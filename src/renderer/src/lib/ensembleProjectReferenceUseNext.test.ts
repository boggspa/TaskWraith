import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const layoutSource = readFileSync(
  new URL('../app/views/MainAppLayout.tsx', import.meta.url),
  'utf8'
)
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const dockSource = readFileSync(
  new URL('../components/ProjectReferencesDockPanel.tsx', import.meta.url),
  'utf8'
)
const dispatchAcceptance = readFileSync(
  new URL('./projectReferenceContextDispatch.test.ts', import.meta.url),
  'utf8'
)
const preloadTypes = readFileSync(new URL('../../../preload/index.d.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')
const roundSource = readFileSync(
  new URL('../../../main/ipc/ensembleRoundHandlers.ts', import.meta.url),
  'utf8'
)

describe('P1 F6 ensemble Use-next enablement', () => {
  it('enables ProjectReferencesDockPanel context selection for ensemble chats', () => {
    // P0 gated ensemble with an explicit false; F6 must not reintroduce that.
    expect(layoutSource).not.toContain(
      "contextSelectionEnabled={currentChat?.chatKind !== 'ensemble'}"
    )
    const dockCall = layoutSource.slice(
      layoutSource.indexOf('<ProjectReferencesDockPanel'),
      layoutSource.indexOf('<ProjectReferencesDockPanel') + 700
    )
    expect(dockCall).not.toContain("chatKind !== 'ensemble'")
    // Fallback copy may remain for other callers that pass false.
    expect(dockSource).toContain(
      'Reference context for Ensemble turns is not available in this version.'
    )
  })

  it('allows Composer reference-only send in ensemble chats', () => {
    expect(appSource).not.toContain(
      'currentProjectReferenceContextSelection?.referenceIds.length && !isCurrentEnsembleChat'
    )
    expect(appSource).not.toContain('!paneIsEnsembleChat &&')
    expect(dispatchAcceptance).toContain(
      'enables the Composer for an explicit reference-only solo or ensemble send'
    )
  })

  it('threads projectReferenceContextSelection through ensemble round dispatch', () => {
    expect(preloadTypes).toContain(
      'projectReferenceContextSelection?: ProjectReferenceContextSelection'
    )
    // The run-ensemble-round callback body (with the selection parse +
    // thread-through) moved to ensembleRoundHandlers.ts; the ipcMain.handle
    // registration stays in index.ts by design.
    expect(mainSource).toContain("ipcMain.handle(\n      'run-ensemble-round'")
    expect(roundSource).toContain('projectReferenceContextSelection')
    expect(appSource).toContain(
      'projectReferenceContextSelection: request.projectReferenceContextSelection'
    )
    // Ensemble accept must settle the one-send claim the same way solo does.
    // Sliced to the accept-path terminator, not a char window: the branch
    // outgrew the old 4500-char window as dispatch legs landed.
    const ensembleDispatchStart = appSource.indexOf("if (runChat.chatKind === 'ensemble')")
    const ensembleDispatchEnd = appSource.indexOf('dispatchAccepted = true', ensembleDispatchStart)
    expect(ensembleDispatchStart).toBeGreaterThanOrEqual(0)
    expect(ensembleDispatchEnd).toBeGreaterThan(ensembleDispatchStart)
    const ensembleDispatch = appSource.slice(ensembleDispatchStart, ensembleDispatchEnd)
    expect(ensembleDispatch).toContain(
      "settleProjectReferenceContextForRequest(request, 'accepted')"
    )
  })
})
