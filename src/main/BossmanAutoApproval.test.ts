import { describe, expect, it } from 'vitest'
import { evaluateBossmanAutoApproval, type BossmanAutoApprovalContext } from './BossmanAutoApproval'

function makeContext(over: Partial<BossmanAutoApprovalContext> = {}): BossmanAutoApprovalContext {
  return {
    service: 'fileChanges',
    decision: 'ask',
    policy: 'ask',
    neverAutoAllow: false,
    readOnly: false,
    forcePrompt: false,
    hasExternalPathDetection: false,
    bossmanParticipantId: 'boss',
    autoApprovals: {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-06-24T00:00:00.000Z'
    },
    participantIds: ['boss', 'worker'],
    targetParticipantId: 'worker',
    targetProvider: 'codex',
    targetRole: 'Worker',
    roundId: 'round-1',
    ...over
  }
}

describe('evaluateBossmanAutoApproval', () => {
  it('auto-allows a preset-limited shell/file ask for a roster participant', () => {
    const result = evaluateBossmanAutoApproval(makeContext({ service: 'shellCommands' }))
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      mode: 'permission_preset_once',
      confirmedAt: '2026-06-24T00:00:00.000Z',
      bossmanParticipantId: 'boss',
      approvalAuthorityRole: 'boss',
      approvalAuthorityParticipantId: 'boss',
      targetParticipantId: 'worker',
      targetProvider: 'codex',
      targetRole: 'Worker',
      roundId: 'round-1',
      actionClass: 'shellCommands'
    })
    expect(typeof (result as Record<string, unknown>).rationale).toBe('string')
  })

  // --- hard denies are never overridden ---------------------------------
  it('returns null on a hard policy deny (deny always wins)', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ decision: 'deny' }))).toBeNull()
  })

  it('returns null on an explicit allow (handled by the earlier grant branch)', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ decision: 'allow' }))).toBeNull()
  })

  // --- the documented hard guards ---------------------------------------
  it('does not let Bossman authority open a canvasEval surface window', () => {
    expect(
      evaluateBossmanAutoApproval(makeContext({ service: 'canvasEval', neverAutoAllow: true }))
    ).toBeNull()
  })

  it('never widens a read-only run', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ readOnly: true }))).toBeNull()
  })

  it('never approves a forced prompt', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ forcePrompt: true }))).toBeNull()
  })

  it('never approves an external-path escape', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ hasExternalPathDetection: true }))).toBeNull()
  })

  it.each([
    'mcpTools',
    'subThreadDelegation',
    'canvasInteraction',
    'crossThreadRead',
    'mediaEditing',
    'mediaRecording'
  ] as const)('never auto-allows the %s action class (only shell/file are in scope)', (service) => {
    expect(evaluateBossmanAutoApproval(makeContext({ service }))).toBeNull()
  })

  // --- consent + roster membership --------------------------------------
  it('returns null when auto-approvals are not enabled', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({
          autoApprovals: { enabled: false, mode: 'permission_preset_once', confirmedAt: 'x' }
        })
      )
    ).toBeNull()
    expect(evaluateBossmanAutoApproval(makeContext({ autoApprovals: undefined }))).toBeNull()
  })

  it('returns null for an unexpected auto-approval mode', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({ autoApprovals: { enabled: true, mode: 'session', confirmedAt: 'x' } })
      )
    ).toBeNull()
  })

  it('returns null when no Boss is configured', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ bossmanParticipantId: undefined }))).toBeNull()
  })

  it('lets Captain use auto-approval consent only when Boss is unavailable', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({
          secondInCommandParticipantId: 'captain',
          participantIds: ['boss', 'captain', 'worker']
        })
      )
    ).toMatchObject({
      approvalAuthorityRole: 'boss',
      approvalAuthorityParticipantId: 'boss'
    })

    const result = evaluateBossmanAutoApproval(
      makeContext({
        secondInCommandParticipantId: 'captain',
        primaryBossUnavailable: true,
        primaryBossUnavailableReason: 'Boss is disabled',
        participantIds: ['boss', 'captain', 'worker']
      })
    )
    expect(result).toMatchObject({
      approvalAuthorityRole: 'captain',
      approvalAuthorityParticipantId: 'captain',
      secondInCommandParticipantId: 'captain',
      primaryBossUnavailableReason: 'Boss is disabled'
    })
  })

  it('does not treat Captain fallback as a substitute Boss configuration', () => {
    const result = evaluateBossmanAutoApproval(
      makeContext({
        bossmanParticipantId: undefined,
        secondInCommandParticipantId: 'captain',
        primaryBossUnavailable: true,
        primaryBossUnavailableReason: 'no Boss is assigned',
        participantIds: ['captain', 'worker']
      })
    )

    expect(result).toBeNull()
  })

  it('returns null when the Boss is no longer in the roster (stale id)', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ participantIds: ['worker'] }))).toBeNull()
  })

  it('returns null when the requesting participant is not in the roster (replaced/removed)', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({ participantIds: ['boss'], targetParticipantId: 'worker' })
      )
    ).toBeNull()
    expect(evaluateBossmanAutoApproval(makeContext({ targetParticipantId: undefined }))).toBeNull()
  })

  // --- an EXTERNAL human collaborator may never be the approving authority ---
  // Externals never receive approval prompts, so an external authority would
  // see no modal AND silently approve every other seat. These cases must hold
  // as soon as a caller passes an effective roster that seats externals.
  it('refuses an external Boss even though its id IS a live roster member', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({
          bossmanParticipantId: 'olly',
          participantIds: ['olly', 'worker'],
          externalParticipantIds: ['olly']
        })
      )
    ).toBeNull()
  })

  it('refuses when the external set cannot be enumerated (null), not just when it is malformed', () => {
    // Regression pin, and it passes on the runtime guard that predates this
    // slice — the `!Array.isArray` refusal was already correct. What changed is
    // that the DECLARED type forbade null, so the production caller omitted the
    // key instead, and an omitted key skips the external check entirely. This
    // pins that a Channel authority answering `recovery_blocked` can be handed
    // straight through and is refused rather than read as "no externals".
    expect(
      evaluateBossmanAutoApproval(
        makeContext({
          bossmanParticipantId: 'olly',
          participantIds: ['olly', 'worker'],
          externalParticipantIds: null
        })
      )
    ).toBeNull()
  })

  it('refuses an external Captain on the Boss-unavailable fallback path', () => {
    // Sanity: with no external marking, this exact context DOES auto-approve —
    // so the refusal below is attributable to the external marking alone.
    const captainFallback: Partial<BossmanAutoApprovalContext> = {
      bossmanParticipantId: 'boss',
      secondInCommandParticipantId: 'olly',
      primaryBossUnavailable: true,
      primaryBossUnavailableReason: 'Boss is disabled',
      participantIds: ['boss', 'olly', 'worker']
    }
    expect(evaluateBossmanAutoApproval(makeContext({ ...captainFallback }))).toMatchObject({
      approvalAuthorityRole: 'captain',
      approvalAuthorityParticipantId: 'olly'
    })
    expect(
      evaluateBossmanAutoApproval(
        makeContext({ ...captainFallback, externalParticipantIds: ['olly'] })
      )
    ).toBeNull()
  })

  it('does not route approval around an external acting Captain', () => {
    const result = evaluateBossmanAutoApproval(
      makeContext({
        captainParticipantIds: ['captain-a', 'captain-b', 'captain-c'],
        secondInCommandParticipantId: 'captain-a',
        unavailableCaptainParticipantIds: ['captain-a'],
        externalParticipantIds: ['captain-b'],
        primaryBossUnavailable: true,
        primaryBossUnavailableReason: 'Boss hit a quota wall',
        participantIds: ['boss', 'captain-a', 'captain-b', 'captain-c', 'worker']
      })
    )

    expect(result).toBeNull()
  })

  it('uses roster order rather than physical array order for the acting Captain', () => {
    const result = evaluateBossmanAutoApproval(
      makeContext({
        captainParticipantIds: ['captain-b', 'captain-a'],
        secondInCommandParticipantId: 'captain-b',
        primaryBossUnavailable: true,
        participantIds: ['boss', 'captain-b', 'captain-a', 'worker'],
        authorityParticipants: [
          { id: 'boss', order: 1 },
          { id: 'captain-b', order: 3 },
          { id: 'captain-a', order: 2 },
          { id: 'worker', order: 4 }
        ]
      })
    )

    expect(result).toMatchObject({
      captainParticipantIds: ['captain-a', 'captain-b'],
      secondInCommandParticipantId: 'captain-a',
      approvalAuthorityRole: 'captain',
      approvalAuthorityParticipantId: 'captain-a'
    })
  })

  it('still auto-approves a model Boss when externals sit elsewhere in the roster', () => {
    // Over-blocking is a real regression: it silently stops the feature for
    // legitimate panels. Only the AUTHORITY seat being external is refused.
    expect(
      evaluateBossmanAutoApproval(
        makeContext({
          participantIds: ['boss', 'olly', 'worker'],
          externalParticipantIds: ['olly']
        })
      )
    ).toMatchObject({
      approvalAuthorityRole: 'boss',
      approvalAuthorityParticipantId: 'boss',
      targetParticipantId: 'worker'
    })
  })

  it('still auto-approves a model Boss while an external holds only the Captain seat', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({
          secondInCommandParticipantId: 'olly',
          participantIds: ['boss', 'olly', 'worker'],
          externalParticipantIds: ['olly']
        })
      )
    ).toMatchObject({
      approvalAuthorityRole: 'boss',
      approvalAuthorityParticipantId: 'boss'
    })
  })

  it('treats absent and empty externalParticipantIds identically to today', () => {
    const absent = evaluateBossmanAutoApproval(makeContext())
    const empty = evaluateBossmanAutoApproval(makeContext({ externalParticipantIds: [] }))
    expect(absent).not.toBeNull()
    expect(empty).toEqual(absent)
  })

  it('refuses an id present in BOTH lists (fail-closed precedence)', () => {
    // Roster membership must not be able to buy back the authority that the
    // external marking denies, whichever order a caller supplies them in.
    expect(
      evaluateBossmanAutoApproval(
        makeContext({
          participantIds: ['boss', 'worker'],
          externalParticipantIds: ['worker', 'boss']
        })
      )
    ).toBeNull()
  })

  it('refuses a present-but-malformed externalParticipantIds rather than ignoring it', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({
          externalParticipantIds: 'boss' as unknown as readonly string[]
        })
      )
    ).toBeNull()
  })
})
