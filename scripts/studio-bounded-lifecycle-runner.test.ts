import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const { adjudicateLifecycleEvidence, assertFocusHandoff, parseLifecycleCli } =
  require('./studio-bounded-lifecycle-runner.cjs') as {
    adjudicateLifecycleEvidence: (evidence: Record<string, any>) => Record<string, any>
    assertFocusHandoff: (
      before: Record<string, any>,
      after: Record<string, any>,
      oldPid: number,
      newPid: number
    ) => Record<string, any>
    parseLifecycleCli: (argv: string[]) => Record<string, any>
  }

const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'

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
    oldProcessDisappeared: true,
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

  it('allows later journal operations while preserving the pre-kill prefix', () => {
    const evidence = truthfulEvidence()
    evidence.after.journalCount = 5
    evidence.after.journalLastRevision = 5
    evidence.after.journalDigest = 'c'.repeat(64)
    expect(adjudicateLifecycleEvidence(evidence)).toMatchObject({ ok: true })
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

  it('rejects changed foreground ownership or cursor position', () => {
    const before = focus(7_002)
    const after = { ...focus(7_003), frontmostPid: 222 }
    expect(() => assertFocusHandoff(before, after, 7_002, 7_003)).toThrow(/focus/)
  })

  it('requires one explicit fresh artifact root argument', () => {
    expect(parseLifecycleCli(['--artifact-root=/tmp/lifecycle-a'])).toEqual({
      help: false,
      artifactRoot: '/tmp/lifecycle-a'
    })
    expect(parseLifecycleCli(['--help'])).toEqual({ help: true, artifactRoot: null })
    expect(() => parseLifecycleCli([])).toThrow(/artifact-root is required/)
  })
})
