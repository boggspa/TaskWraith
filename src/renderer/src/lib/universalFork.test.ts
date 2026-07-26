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

  it('marks Cursor as emulated fork (Path-B live seat)', () => {
    const capability = buildStaticForkCapability('cursor')
    expect(capability.kind).toBe('emulated')
    expect(forkActionLabel(capability)).toBe('Fork (emulated)')
  })

  it('marks an already-admitted AntiGravity chat as emulated rather than retired', () => {
    const capability = buildStaticForkCapability('antigravity')
    expect(capability.kind).toBe('emulated')
    expect(capability.detail).not.toContain('retired')
  })

  it('marks Pi as emulated rather than falling through to an unsupported live provider', () => {
    expect(buildStaticForkCapability('pi').kind).toBe('emulated')
  })

  it('marks retired Gemini forks as unsupported', () => {
    const capability = buildStaticForkCapability('gemini')
    expect(capability.kind).toBe('unsupported')
    expect(capability.detail).toContain('retired')
  })
})
