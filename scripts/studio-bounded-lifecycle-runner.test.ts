import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  adjudicateLifecycleEvidence,
  assertExplicitOpenJournalDelta,
  assertFocusHandoff,
  assertHydrationEvidence,
  assertNoVisibleSourceWindow,
  assertUnchangedJournalAcrossReplacement,
  parseLifecycleCli,
  probeNativeWindowIncludingZero,
  waitForExactMediaObservation
} =
  require('./studio-bounded-lifecycle-runner.cjs') as {
    adjudicateLifecycleEvidence: (evidence: Record<string, any>) => Record<string, any>
    assertExplicitOpenJournalDelta: (
      before: Array<Record<string, any>>,
      after: Array<Record<string, any>>,
      asset: Record<string, any>
    ) => Record<string, any>
    assertFocusHandoff: (
      before: Record<string, any>,
      after: Record<string, any>,
      oldPid: number,
      newPid: number
    ) => Record<string, any>
    assertHydrationEvidence: (
      hydration: Record<string, any>,
      expectedPid: number,
      expectedRevision: number,
      asset: Record<string, any>
    ) => Record<string, any>
    assertNoVisibleSourceWindow: (
      companion: Record<string, any>,
      probe: (pid: number) => Promise<Record<string, any>>
    ) => Promise<Record<string, any>>
    assertUnchangedJournalAcrossReplacement: (
      before: Array<Record<string, any>>,
      after: Array<Record<string, any>>
    ) => Record<string, any>
    parseLifecycleCli: (argv: string[]) => Record<string, any>
    probeNativeWindowIncludingZero: (
      pid: number,
      run: (command: string, args: string[], options: Record<string, any>) => Record<string, any>
    ) => Record<string, any>
    waitForExactMediaObservation: (
      plan: Record<string, any>,
      target: Record<string, any>,
      name: string,
      options: Record<string, any>
    ) => Promise<Record<string, any>>
  }

const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
const assetPath = '/tmp/asset.mp4'

function focus(targetPid: number) {
  return {
    frontmostPid: 111,
    frontmostBundleIdentifier: 'com.openai.codex',
    targetPid,
    targetIsActive: false,
    cursorX: 400,
    cursorY: 300
  }
}

function truthfulEvidence() {
  const beforeFocus = focus(7_002)
  const afterFocus = focus(7_003)
  return {
    electronPid: 7_001,
    electronPgid: 7_001,
    expectedAssetId: assetId,
    expectedAssetPath: assetPath,
    oldProcessDisappeared: true,
    hiddenReplacement: {
      sourceWindowPresentedBeforeExplicitOpen: false,
      journalUnchangedAcrossReplacement: true,
      windowProbe: { pid: 7_003, visibleWindowCount: 0, windows: [] },
      journal: {
        beforeCount: 4,
        afterCount: 4,
        beforeDigest: 'a'.repeat(64),
        afterDigest: 'a'.repeat(64)
      },
      hydration: {
        expectedPid: 7_003,
        expectedRevision: 4,
        helloIndex: 0,
        documentIndex: 1,
        eventIndex: 2,
        hydratedAsset: { assetId },
        relevantHits: [
          { childPid: 7_003, kind: 'request-response', method: 'studio/hello' },
          {
            childPid: 7_003,
            kind: 'request-response',
            method: 'studio/getDocument'
          },
          {
            childPid: 7_003,
            kind: 'hydration-served-event',
            method: 'studio/getDocument',
            hydrationRevision: 4,
            responseRevision: 4,
            hydratedChildMatches: true,
            supervisorStatus: { pid: 7_003 },
            document: { assets: [{ assetId, path: assetPath }] }
          }
        ],
        hydratedDocument: { assets: [{ assetId, path: assetPath }] }
      }
    },
    explicitPresentation: {
      journalDelta: {
        appendedCount: 1,
        assetId,
        sameAssetOpenMedia: true,
        beforeCount: 4,
        afterCount: 5,
        beforeDigest: 'a'.repeat(64),
        afterDigest: 'b'.repeat(64),
        appendedEntries: [
          { revision: 5, op: { type: 'open_media', asset: { assetId, path: assetPath } } }
        ]
      }
    },
    focus: assertFocusHandoff(beforeFocus, afterFocus, 7_002, 7_003),
    before: {
      process: { pid: 7_002, ppid: 7_001, pgid: 7_001 },
      journalCount: 4,
      journalLastRevision: 4,
      journalDigest: 'a'.repeat(64),
      journalPrefixCount: 4,
      journalPrefixDigest: 'a'.repeat(64),
      windowTitle: 'TaskWraith Studio',
      assetMatch: {
        matched: true,
        expected: assetId.toLowerCase(),
        distance: 0
      }
    },
    after: {
      process: { pid: 7_003, ppid: 7_001, pgid: 7_001 },
      journalCount: 5,
      journalLastRevision: 5,
      journalDigest: 'b'.repeat(64),
      journalPrefixCount: 4,
      journalPrefixDigest: 'a'.repeat(64),
      windowTitle: 'TaskWraith Studio',
      assetMatch: {
        matched: true,
        expected: assetId.toLowerCase(),
        distance: 0
      }
    }
  }
}

describe('bounded Studio lifecycle adjudication', () => {
  it('accepts one exact invisible replacement and hydrated asset', () => {
    expect(adjudicateLifecycleEvidence(truthfulEvidence())).toMatchObject({
      ok: true,
      electronPid: 7_001,
      oldCompanionPid: 7_002,
      newCompanionPid: 7_003,
      oldProcessDisappeared: true,
      expectedAssetId: assetId
    })
  })

  it.each([
    [
      'same process',
      (evidence: Record<string, any>) => {
        evidence.after.process.pid = evidence.before.process.pid
      }
    ],
    [
      'old survivor',
      (evidence: Record<string, any>) => {
        evidence.oldProcessDisappeared = false
      }
    ],
    [
      'foreign parent',
      (evidence: Record<string, any>) => {
        evidence.after.process.ppid = 9_999
      }
    ],
    [
      'fuzzy asset',
      (evidence: Record<string, any>) => {
        evidence.after.assetMatch.distance = 1
      }
    ],
    [
      'journal mutation',
      (evidence: Record<string, any>) => {
        evidence.after.journalPrefixDigest = 'b'.repeat(64)
      }
    ],
    [
      'visible before explicit reopen',
      (evidence: Record<string, any>) => {
        evidence.hiddenReplacement.windowProbe.windows = [{ title: 'TaskWraith Studio' }]
      }
    ],
    [
      'hidden journal mutation',
      (evidence: Record<string, any>) => {
        evidence.hiddenReplacement.journal.afterDigest = 'b'.repeat(64)
      }
    ],
    [
      'bad explicit open delta',
      (evidence: Record<string, any>) => {
        evidence.explicitPresentation.journalDelta.appendedEntries[0].op.asset.assetId = 'other'
      }
    ],
    [
      'focus theft',
      (evidence: Record<string, any>) => {
        evidence.focus.ok = false
      }
    ]
  ])('rejects %s', (_name, mutate) => {
    const evidence = truthfulEvidence()
    mutate(evidence)
    expect(() => adjudicateLifecycleEvidence(evidence)).toThrow()
  })

  it('does not trust derived lifecycle summary fields over raw evidence', () => {
    const evidence = truthfulEvidence()
    evidence.hiddenReplacement.sourceWindowPresentedBeforeExplicitOpen = true
    evidence.hiddenReplacement.journalUnchangedAcrossReplacement = false
    evidence.explicitPresentation.journalDelta.sameAssetOpenMedia = false
    expect(adjudicateLifecycleEvidence(evidence)).toMatchObject({ ok: true })
  })

  it('rejects changed foreground ownership or cursor position', () => {
    const before = focus(7_002)
    const after = { ...focus(7_003), frontmostPid: 222 }
    expect(() => assertFocusHandoff(before, after, 7_002, 7_003)).toThrow(/focus/)
  })

  it('requires no visible Source window before explicit reopen', async () => {
    await expect(
      assertNoVisibleSourceWindow({ pid: 7_003 }, async () => ({
        pid: 7_003,
        visibleWindowCount: 1,
        windows: [{ title: 'TaskWraith Studio', windowId: 42 }]
      }))
    ).rejects.toThrow(/before explicit reopen/)
    await expect(
      assertNoVisibleSourceWindow({ pid: 7_003 }, async () => {
        throw new Error('No on-screen native Studio window for exact pid 7003')
      })
    ).resolves.toMatchObject({ sourceWindowPresentedBeforeExplicitOpen: false })
  })

  it('retains the raw zero-window probe instead of fabricating a visible-window receipt', () => {
    const observed = probeNativeWindowIncludingZero(7_003, () => ({
      stdout: JSON.stringify({ pid: 7_003, visibleWindowCount: 0, windows: [] })
    }))
    expect(observed).toEqual({ pid: 7_003, visibleWindowCount: 0, windows: [] })
    expect(() =>
      probeNativeWindowIncludingZero(7_003, () => ({
        stdout: JSON.stringify({ pid: 7_003, visibleWindowCount: 1, windows: [] })
      }))
    ).toThrow(/raw window probe returned invalid data/)
  })

  it.each([
    ['wrong replacement pid', { expectedPid: 7_004 }],
    ['wrong hydrated revision', { expectedRevision: 3 }],
    ['wrong callback order', { eventIndex: 1 }],
    ['wrong hydrated asset', { hydratedDocument: { assets: [{ assetId: 'other', path: '/tmp/asset.mp4' }] } }]
  ])('rejects %s hydration evidence', (_label, mutation) => {
    const hydration = {
      expectedPid: 7_003,
      expectedRevision: 4,
      helloIndex: 0,
      documentIndex: 1,
      eventIndex: 2,
      hydratedDocument: { assets: [{ assetId, path: '/tmp/asset.mp4' }] }
    }
    Object.assign(hydration, mutation)
    expect(() => assertHydrationEvidence(hydration, 7_003, 4, { sha256: assetId, assetPath: '/tmp/asset.mp4' })).toThrow()
  })

  it('requires exactly one same-asset open_media explicit reopen delta', () => {
    const before = [{ revision: 4, op: { type: 'open_media' } }]
    const asset = { sha256: assetId, assetPath: '/tmp/asset.mp4' }
    const after = [
      ...before,
      {
        revision: 5,
        op: {
          type: 'open_media',
          asset: { assetId, path: asset.assetPath }
        }
      }
    ]
    expect(assertExplicitOpenJournalDelta(before, after, asset)).toMatchObject({
      appendedCount: 1,
      assetId,
      sameAssetOpenMedia: true
    })
    expect(() =>
      assertExplicitOpenJournalDelta(before, [...after, after[1]], asset)
    ).toThrow(/exactly one same-asset open_media/)
    expect(() =>
      assertExplicitOpenJournalDelta(before, [
        ...before,
        { revision: 5, op: { type: 'open_media', asset: { assetId: 'other', path: asset.assetPath } } }
      ], asset)
    ).toThrow(/exactly one same-asset open_media/)
  })

  it('requires the hidden journal to remain byte-for-byte equivalent', () => {
    const before = [{ revision: 4, op: { type: 'open_media' } }]
    expect(assertUnchangedJournalAcrossReplacement(before, structuredClone(before))).toMatchObject({
      journalUnchangedAcrossReplacement: true
    })
    expect(() =>
      assertUnchangedJournalAcrossReplacement(before, [
        ...before,
        { revision: 5, op: { type: 'unexpected' } }
      ])
    ).toThrow(/changed the durable journal/)
  })

  it('requires one explicit fresh artifact root argument', () => {
    expect(parseLifecycleCli(['--artifact-root=/tmp/lifecycle-a'])).toEqual({
      help: false,
      artifactRoot: '/tmp/lifecycle-a'
    })
    expect(parseLifecycleCli(['--help'])).toEqual({ help: true, artifactRoot: null })
    expect(() => parseLifecycleCli([])).toThrow(/artifact-root is required/)
  })

  it('waits boundedly for exact media adoption instead of sampling the initial No media frame', async () => {
    let attempts = 0
    const observation = { assetMatch: { matched: true, distance: 0 } }
    await expect(
      waitForExactMediaObservation({}, {}, 'lifecycle-before', {
        timeoutMs: 100,
        intervalMs: 0,
        observe: async () => {
          attempts += 1
          if (attempts < 3) throw new Error('does not show the exact generated asset')
          return observation
        }
      })
    ).resolves.toBe(observation)
    expect(attempts).toBe(3)
  })
})
