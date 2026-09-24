import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../store/types'
import {
  clampAwaitTimeoutSeconds,
  clampLaneResultMaxChars,
  ENSEMBLE_AWAIT_DEFAULT_TIMEOUT_SECONDS,
  ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS,
  ENSEMBLE_AWAIT_MUSE_TIMEOUT_CEILING_SECONDS,
  ensembleAwaitTimeoutCeilingSeconds,
  ENSEMBLE_LANE_RESULT_DEFAULT_MAX_CHARS,
  ENSEMBLE_LANE_RESULT_MAX_CHARS,
  fanoutPolicyAllowsRead,
  fanoutPolicyAllowsWriters,
  fanoutPolicyEnablesConcurrent,
  fanoutTargetStageLabel,
  fanoutTargetStageMatches,
  isBackgroundParticipant,
  isEnsembleFanoutPolicy,
  isRosterEditAction,
  normalizeFanoutIsolation,
  normalizeFanoutMode,
  normalizeFanoutTargetStage,
  normalizeLaneIdList,
  resolveEnsembleFanoutPolicy,
  resolveRequestedEnsembleFanoutPolicy
} from './EnsembleFanoutPolicy'

function participant(stageRole?: EnsembleParticipant['stageRole']): EnsembleParticipant {
  return {
    id: 'p1',
    provider: 'codex',
    role: 'Worker',
    enabled: true,
    order: 1,
    instructions: '',
    permissionPresetId: 'default',
    ...(stageRole ? { stageRole } : {})
  } as EnsembleParticipant
}

describe('normalizeFanoutMode', () => {
  it('defaults omitted or empty values to read_only', () => {
    expect(normalizeFanoutMode(undefined)).toBe('read_only')
    expect(normalizeFanoutMode(null)).toBe('read_only')
    expect(normalizeFanoutMode('')).toBe('read_only')
  })

  it('accepts the two live modes and rejects everything else', () => {
    expect(normalizeFanoutMode('read_only')).toBe('read_only')
    expect(normalizeFanoutMode('locked_writers')).toBe('locked_writers')
    expect(normalizeFanoutMode('all')).toBeNull()
    expect(normalizeFanoutMode('off')).toBeNull()
    expect(normalizeFanoutMode('READ_ONLY')).toBeNull()
    expect(normalizeFanoutMode(1)).toBeNull()
  })
})

describe('normalizeFanoutIsolation', () => {
  it('treats omitted or empty values as inherit (undefined)', () => {
    expect(normalizeFanoutIsolation(undefined)).toBeUndefined()
    expect(normalizeFanoutIsolation(null)).toBeUndefined()
    expect(normalizeFanoutIsolation('')).toBeUndefined()
  })

  it('accepts worktree/off and rejects other values as invalid', () => {
    expect(normalizeFanoutIsolation('worktree')).toBe('worktree')
    expect(normalizeFanoutIsolation('off')).toBe('off')
    expect(normalizeFanoutIsolation('on')).toBeNull()
    expect(normalizeFanoutIsolation('WORKTREE')).toBeNull()
  })
})

describe('normalizeLaneIdList', () => {
  it('returns undefined when the field is omitted', () => {
    expect(normalizeLaneIdList(undefined)).toBeUndefined()
    expect(normalizeLaneIdList(null)).toBeUndefined()
  })

  it('rejects non-arrays and empty-after-trim lists', () => {
    expect(normalizeLaneIdList('lane-1')).toBeNull()
    expect(normalizeLaneIdList([])).toBeNull()
    expect(normalizeLaneIdList(['', '  ', 1])).toBeNull()
  })

  it('trims, drops blanks, and dedupes while preserving first-seen order', () => {
    expect(normalizeLaneIdList([' lane-1 ', 'lane-2', 'lane-1', '', 'lane-2'])).toEqual([
      'lane-1',
      'lane-2'
    ])
  })
})

describe('clampAwaitTimeoutSeconds', () => {
  it('defaults to 45 seconds and allows up to 10 minutes per explicit call', () => {
    expect(clampAwaitTimeoutSeconds(undefined)).toBe(ENSEMBLE_AWAIT_DEFAULT_TIMEOUT_SECONDS)
    expect(clampAwaitTimeoutSeconds(Number.NaN)).toBe(45)
    expect(clampAwaitTimeoutSeconds('45')).toBe(45)
    expect(clampAwaitTimeoutSeconds(600)).toBe(ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS)
    expect(clampAwaitTimeoutSeconds(6000)).toBe(600)
    expect(clampAwaitTimeoutSeconds(1)).toBe(5)
    expect(clampAwaitTimeoutSeconds(45)).toBe(45)
    expect(clampAwaitTimeoutSeconds(5.4)).toBe(5)
    expect(clampAwaitTimeoutSeconds(5.6)).toBe(6)
  })
})

describe('clampLaneResultMaxChars', () => {
  it('defaults to 20k and clamps to 1k..60k', () => {
    expect(clampLaneResultMaxChars(undefined)).toBe(ENSEMBLE_LANE_RESULT_DEFAULT_MAX_CHARS)
    expect(clampLaneResultMaxChars(Number.NaN)).toBe(20_000)
    expect(clampLaneResultMaxChars(500)).toBe(1_000)
    expect(clampLaneResultMaxChars(1_000)).toBe(1_000)
    expect(clampLaneResultMaxChars(60_000)).toBe(ENSEMBLE_LANE_RESULT_MAX_CHARS)
    expect(clampLaneResultMaxChars(120_000)).toBe(60_000)
    expect(clampLaneResultMaxChars(20_000.4)).toBe(20_000)
  })
})

describe('normalizeFanoutTargetStage', () => {
  it('treats omitted or empty values as unspecified', () => {
    expect(normalizeFanoutTargetStage(undefined)).toBeUndefined()
    expect(normalizeFanoutTargetStage(null)).toBeUndefined()
    expect(normalizeFanoutTargetStage('')).toBeUndefined()
  })

  it('normalizes aliases, spacing, and punctuation to the five stages', () => {
    expect(normalizeFanoutTargetStage('all')).toBe('all')
    expect(normalizeFanoutTargetStage('Any Typed')).toBe('all')
    expect(normalizeFanoutTargetStage('typed')).toBe('all')
    expect(normalizeFanoutTargetStage('Scout')).toBe('scouts')
    expect(normalizeFanoutTargetStage('readers')).toBe('scouts')
    expect(normalizeFanoutTargetStage('recon')).toBe('scouts')
    expect(normalizeFanoutTargetStage('writer')).toBe('workers')
    expect(normalizeFanoutTargetStage('Workers')).toBe('workers')
    expect(normalizeFanoutTargetStage('review')).toBe('reviewers')
    expect(normalizeFanoutTargetStage('REVIEWER')).toBe('reviewers')
    expect(normalizeFanoutTargetStage('bg')).toBe('backgrounds')
    expect(normalizeFanoutTargetStage('back_ground')).toBe('backgrounds')
    expect(normalizeFanoutTargetStage('backgrounds')).toBe('backgrounds')
  })

  it('rejects unknown stages', () => {
    expect(normalizeFanoutTargetStage('captains')).toBeNull()
    expect(normalizeFanoutTargetStage('management')).toBeNull()
    expect(normalizeFanoutTargetStage(0)).toBeNull()
  })
})

describe('fanoutTargetStageLabel', () => {
  it('labels each typed stage and falls back for unspecified', () => {
    expect(fanoutTargetStageLabel('scouts')).toBe('Scout fan-out')
    expect(fanoutTargetStageLabel('workers')).toBe('Worker fan-out')
    expect(fanoutTargetStageLabel('reviewers')).toBe('Review fan-out')
    expect(fanoutTargetStageLabel('backgrounds')).toBe('Background fan-out')
    expect(fanoutTargetStageLabel('all')).toBe('Ensemble fan-out')
    expect(fanoutTargetStageLabel(undefined)).toBe('Parallel fan-out')
  })
})

describe('fanoutTargetStageMatches', () => {
  it('matches everyone when the stage is unspecified', () => {
    expect(fanoutTargetStageMatches(participant(), undefined)).toBe(true)
    expect(fanoutTargetStageMatches(participant('scout'), undefined)).toBe(true)
  })

  it('restricts targetStage=all to typed stage roles', () => {
    expect(fanoutTargetStageMatches(participant('scout'), 'all')).toBe(true)
    expect(fanoutTargetStageMatches(participant('worker'), 'all')).toBe(true)
    expect(fanoutTargetStageMatches(participant('reviewer'), 'all')).toBe(true)
    expect(fanoutTargetStageMatches(participant('background'), 'all')).toBe(true)
    expect(fanoutTargetStageMatches(participant(), 'all')).toBe(false)
  })

  it('matches one stage at a time', () => {
    expect(fanoutTargetStageMatches(participant('scout'), 'scouts')).toBe(true)
    expect(fanoutTargetStageMatches(participant('worker'), 'scouts')).toBe(false)
    expect(fanoutTargetStageMatches(participant('worker'), 'workers')).toBe(true)
    expect(fanoutTargetStageMatches(participant('reviewer'), 'reviewers')).toBe(true)
    expect(fanoutTargetStageMatches(participant('background'), 'backgrounds')).toBe(true)
    expect(fanoutTargetStageMatches(participant('scout'), 'backgrounds')).toBe(false)
  })
})

describe('isBackgroundParticipant', () => {
  it('is true only for background stageRole', () => {
    expect(isBackgroundParticipant(participant('background'))).toBe(true)
    expect(isBackgroundParticipant(participant('worker'))).toBe(false)
    expect(isBackgroundParticipant(participant())).toBe(false)
  })
})

describe('fanout policy predicates', () => {
  it('allows read on read_only and all only', () => {
    expect(fanoutPolicyAllowsRead('read_only')).toBe(true)
    expect(fanoutPolicyAllowsRead('all')).toBe(true)
    expect(fanoutPolicyAllowsRead('off')).toBe(false)
    expect(fanoutPolicyAllowsRead('locked_writers_with_boss')).toBe(false)
    expect(fanoutPolicyAllowsRead('locked_writers_user_preflight')).toBe(false)
  })

  it('allows writers on all and the retired locked-writer levels', () => {
    expect(fanoutPolicyAllowsWriters('all')).toBe(true)
    expect(fanoutPolicyAllowsWriters('locked_writers_with_boss')).toBe(true)
    expect(fanoutPolicyAllowsWriters('locked_writers_user_preflight')).toBe(true)
    expect(fanoutPolicyAllowsWriters('read_only')).toBe(false)
    expect(fanoutPolicyAllowsWriters('off')).toBe(false)
  })

  it('enables concurrent for every policy except off', () => {
    expect(fanoutPolicyEnablesConcurrent('off')).toBe(false)
    expect(fanoutPolicyEnablesConcurrent('read_only')).toBe(true)
    expect(fanoutPolicyEnablesConcurrent('all')).toBe(true)
    expect(fanoutPolicyEnablesConcurrent('locked_writers_with_boss')).toBe(true)
  })
})

describe('isRosterEditAction', () => {
  it('accepts the three roster-edit actions and rejects others', () => {
    expect(isRosterEditAction('add_participant')).toBe(true)
    expect(isRosterEditAction('remove_participant')).toBe(true)
    expect(isRosterEditAction('edit_participant')).toBe(true)
    expect(isRosterEditAction('import_preset')).toBe(false)
    expect(isRosterEditAction('register_in_agent_pool')).toBe(false)
    expect(isRosterEditAction('')).toBe(false)
  })
})

describe('isEnsembleFanoutPolicy', () => {
  it('recognizes the five stored policy strings', () => {
    expect(isEnsembleFanoutPolicy('off')).toBe(true)
    expect(isEnsembleFanoutPolicy('read_only')).toBe(true)
    expect(isEnsembleFanoutPolicy('all')).toBe(true)
    expect(isEnsembleFanoutPolicy('locked_writers_with_boss')).toBe(true)
    expect(isEnsembleFanoutPolicy('locked_writers_user_preflight')).toBe(true)
    expect(isEnsembleFanoutPolicy('locked_writers')).toBe(false)
    expect(isEnsembleFanoutPolicy('On')).toBe(false)
    expect(isEnsembleFanoutPolicy(undefined)).toBe(false)
  })
})

describe('resolveEnsembleFanoutPolicy', () => {
  it('preserves off and collapses every other recognized level to all', () => {
    expect(resolveEnsembleFanoutPolicy({ fanoutPolicy: 'off' })).toBe('off')
    expect(resolveEnsembleFanoutPolicy({ fanoutPolicy: 'all' })).toBe('all')
    expect(resolveEnsembleFanoutPolicy({ fanoutPolicy: 'read_only' })).toBe('all')
    expect(resolveEnsembleFanoutPolicy({ fanoutPolicy: 'locked_writers_with_boss' })).toBe('all')
    expect(resolveEnsembleFanoutPolicy({ fanoutPolicy: 'locked_writers_user_preflight' })).toBe(
      'all'
    )
  })

  it('treats legacy concurrent booleans as On when policy is unrecognized', () => {
    expect(resolveEnsembleFanoutPolicy({ concurrentMode: true })).toBe('all')
    expect(resolveEnsembleFanoutPolicy({ concurrentModeEnabled: true })).toBe('all')
    expect(resolveEnsembleFanoutPolicy({ concurrentMode: false })).toBe('off')
    expect(resolveEnsembleFanoutPolicy(null)).toBe('off')
    expect(resolveEnsembleFanoutPolicy(undefined)).toBe('off')
    expect(resolveEnsembleFanoutPolicy({ fanoutPolicy: 'bogus' })).toBe('off')
  })

  it('does not let a concurrent boolean override an explicit off policy', () => {
    expect(resolveEnsembleFanoutPolicy({ fanoutPolicy: 'off', concurrentMode: true })).toBe('off')
  })
})

describe('resolveRequestedEnsembleFanoutPolicy', () => {
  const config = { fanoutPolicy: 'off' as const, concurrentModeEnabled: false }

  it('prefers an explicit requested policy, then concurrentMode, then config', () => {
    expect(resolveRequestedEnsembleFanoutPolicy(config, { fanoutPolicy: 'read_only' })).toBe('all')
    expect(resolveRequestedEnsembleFanoutPolicy(config, { concurrentMode: true })).toBe('all')
    expect(resolveRequestedEnsembleFanoutPolicy(config, {})).toBe('off')
    expect(resolveRequestedEnsembleFanoutPolicy(config)).toBe('off')
  })

  it('does not fall through to concurrentMode when fanoutPolicy is present', () => {
    expect(
      resolveRequestedEnsembleFanoutPolicy(config, {
        fanoutPolicy: 'bogus',
        concurrentMode: true
      })
    ).toBe('off')
  })
})

describe('ensembleAwaitTimeoutCeilingSeconds', () => {
  // Muse's MCP client drops the stdio server when one tool call outlives its
  // own budget (QA 2026-09-15: a 300 s ensemble_await from the Muse Boss came
  // back "timeout" and every later brokered call failed with "MCP stdio
  // connection is closed"). A Muse caller therefore gets a lower per-call
  // ceiling and re-invokes; everyone else keeps the 10-minute ceiling.
  it('caps a Muse caller below its MCP client budget and leaves others at the max', () => {
    expect(ensembleAwaitTimeoutCeilingSeconds('muse')).toBe(
      ENSEMBLE_AWAIT_MUSE_TIMEOUT_CEILING_SECONDS
    )
    expect(ENSEMBLE_AWAIT_MUSE_TIMEOUT_CEILING_SECONDS).toBeLessThan(300)
    expect(ENSEMBLE_AWAIT_MUSE_TIMEOUT_CEILING_SECONDS).toBeGreaterThan(
      ENSEMBLE_AWAIT_DEFAULT_TIMEOUT_SECONDS
    )
    expect(ensembleAwaitTimeoutCeilingSeconds('codex')).toBe(ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS)
    expect(ensembleAwaitTimeoutCeilingSeconds(undefined)).toBe(ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS)
    expect(ensembleAwaitTimeoutCeilingSeconds(null)).toBe(ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS)
  })

  it('clamps an explicit request and the default to the caller ceiling without ever widening', () => {
    expect(clampAwaitTimeoutSeconds(300, 240)).toBe(240)
    expect(clampAwaitTimeoutSeconds(600, ENSEMBLE_AWAIT_MUSE_TIMEOUT_CEILING_SECONDS)).toBe(
      ENSEMBLE_AWAIT_MUSE_TIMEOUT_CEILING_SECONDS
    )
    expect(clampAwaitTimeoutSeconds(120, 240)).toBe(120)
    expect(clampAwaitTimeoutSeconds(undefined, 30)).toBe(30)
    expect(clampAwaitTimeoutSeconds(undefined, 240)).toBe(ENSEMBLE_AWAIT_DEFAULT_TIMEOUT_SECONDS)
    expect(clampAwaitTimeoutSeconds(6000, 6000)).toBe(ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS)
    expect(clampAwaitTimeoutSeconds(1, 240)).toBe(5)
  })
})
