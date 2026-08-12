import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '../store/types'
import {
  ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE,
  hasAntigravityPermissionDenialEvidence,
  isAntigravityBlockingPermissionClaim,
  isUnsupportedAntigravityPermissionClaim,
  qualifyUnsupportedAntigravityPermissionClaim
} from './AntigravityPermissionClaimEvidence'

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    ...overrides
  }
}

describe('AntiGravity permission-claim evidence', () => {
  const falseRefusal =
    'I cannot complete BOARD.md because my read access was denied. I require explicit host approval and will wait for the grant.'

  it('recognizes a first-person permission blocker but not hypothetical guidance', () => {
    expect(isAntigravityBlockingPermissionClaim(falseRefusal)).toBe(true)
    expect(
      isAntigravityBlockingPermissionClaim(
        'If permission is denied, report the exact path and wait for the user.'
      )
    ).toBe(false)
    expect(
      isAntigravityBlockingPermissionClaim(
        'The file is outside-workspace and requires explicit host approval before proceeding.'
      )
    ).toBe(true)
  })

  it('does not treat successful or unrelated failed tools as denial evidence', () => {
    expect(hasAntigravityPermissionDenialEvidence([activity()])).toBe(false)
    expect(
      hasAntigravityPermissionDenialEvidence([
        activity({ status: 'error', resultSummary: 'ENOENT: file not found' })
      ])
    ).toBe(false)
    expect(isUnsupportedAntigravityPermissionClaim(falseRefusal, [activity()])).toBe(true)
  })

  it('accepts an explicit permission-denied terminal tool result as evidence', () => {
    const denied = activity({
      status: 'error',
      resultSummary: 'TaskWraith declined this command under the current permission tier.'
    })
    expect(hasAntigravityPermissionDenialEvidence([denied])).toBe(true)
    expect(isUnsupportedAntigravityPermissionClaim(falseRefusal, [denied])).toBe(false)
  })

  it('qualifies unsupported history without deleting it and is idempotent', () => {
    const qualified = qualifyUnsupportedAntigravityPermissionClaim(falseRefusal, [activity()])
    expect(qualified).toContain(ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE)
    expect(qualified).toContain(falseRefusal)
    expect(qualifyUnsupportedAntigravityPermissionClaim(qualified, [activity()])).toBe(qualified)
  })
})
