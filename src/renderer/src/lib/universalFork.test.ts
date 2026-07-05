import { describe, expect, it } from 'vitest'
import {
  buildStaticForkCapability,
  forkActionLabel,
  forkSlashDescription
} from './universalFork'

describe('universalFork', () => {
  it('marks Codex as native fork', () => {
    const capability = buildStaticForkCapability('codex')
    expect(capability.kind).toBe('native')
    expect(forkActionLabel(capability)).toBe('Fork (native)')
  })

  it('marks Claude as emulated fork', () => {
    const capability = buildStaticForkCapability('claude')
    expect(capability.kind).toBe('emulated')
    expect(forkSlashDescription(capability)).toContain('emulated')
  })

  it('marks retired providers as unsupported', () => {
    const capability = buildStaticForkCapability('gemini')
    expect(capability.kind).toBe('unsupported')
    expect(capability.detail).toContain('retired')
  })
})