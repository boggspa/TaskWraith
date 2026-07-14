import { describe, expect, it } from 'vitest'
import {
  canonicalUnattendedElevation,
  signUnattendedElevation,
  verifyUnattendedElevation,
  type UnattendedElevationTuple
} from './UnattendedElevationSignature'

const SECRET = 'test-secret-key'

const tuple = (over: Partial<UnattendedElevationTuple> = {}): UnattendedElevationTuple => ({
  workflowId: 'wf-1',
  workspacePath: '/repo',
  level: 'full_access',
  acknowledgedApprovalMode: 'auto_edit',
  authorityDigest: 'a'.repeat(64),
  ...over
})

describe('signUnattendedElevation / verifyUnattendedElevation', () => {
  it('round-trips a freshly signed tuple', () => {
    const t = tuple()
    expect(verifyUnattendedElevation(SECRET, t, signUnattendedElevation(SECRET, t))).toBe(true)
  })

  it('is independent of key insertion order (deterministic serialization)', () => {
    const a = canonicalUnattendedElevation({
      workflowId: 'wf-1',
      workspacePath: '/repo',
      level: 'default',
      acknowledgedApprovalMode: 'default',
      authorityDigest: 'a'.repeat(64)
    })
    const b = canonicalUnattendedElevation({
      acknowledgedApprovalMode: 'default',
      level: 'default',
      workspacePath: '/repo',
      workflowId: 'wf-1',
      authorityDigest: 'a'.repeat(64)
    } as UnattendedElevationTuple)
    expect(a).toBe(b)
  })

  it('fails verification when ANY tuple field is tampered', () => {
    const t = tuple()
    const sig = signUnattendedElevation(SECRET, t)
    expect(verifyUnattendedElevation(SECRET, { ...t, workflowId: 'wf-2' }, sig)).toBe(false)
    expect(verifyUnattendedElevation(SECRET, { ...t, workspacePath: '/other' }, sig)).toBe(false)
    expect(verifyUnattendedElevation(SECRET, { ...t, level: 'default' }, sig)).toBe(false)
    expect(verifyUnattendedElevation(SECRET, { ...t, acknowledgedApprovalMode: 'default' }, sig)).toBe(
      false
    )
    expect(
      verifyUnattendedElevation(SECRET, { ...t, authorityDigest: 'b'.repeat(64) }, sig)
    ).toBe(false)
  })

  it('a default-level signature does NOT verify against a full_access tuple (no privilege upgrade)', () => {
    const defaultSig = signUnattendedElevation(SECRET, tuple({ level: 'default' }))
    expect(verifyUnattendedElevation(SECRET, tuple({ level: 'full_access' }), defaultSig)).toBe(false)
  })

  it('fails under a different secret', () => {
    const t = tuple()
    const sig = signUnattendedElevation(SECRET, t)
    expect(verifyUnattendedElevation('other-secret', t, sig)).toBe(false)
  })

  it('rejects a non-hex / empty / null / undefined signature', () => {
    const t = tuple()
    expect(verifyUnattendedElevation(SECRET, t, 'not-hex!!')).toBe(false)
    expect(verifyUnattendedElevation(SECRET, t, '')).toBe(false)
    expect(verifyUnattendedElevation(SECRET, t, null)).toBe(false)
    expect(verifyUnattendedElevation(SECRET, t, undefined)).toBe(false)
  })

  it('rejects a valid-hex but wrong-length signature', () => {
    expect(verifyUnattendedElevation(SECRET, tuple(), 'deadbeef')).toBe(false)
  })
})
