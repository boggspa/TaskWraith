import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  armSharedWorkspaceIntentExpiry,
  retireSharedWorkspaceIntent
} from './SharedWorkspaceIntentClaims'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tw-intent-expiry-'))
  roots.push(root)
  const marker = join(root, 'claim.md')
  const archive = join(root, 'archive')
  writeFileSync(marker, 'original intent')
  writeFileSync(join(root, 'recovery.json'), 'preserved recovery')
  return { root, marker, archive }
}
describe('contribution intent expiry', () => {
  it('archives the exact projection while preserving recovery data', () => {
    const { root, marker, archive } = fixture()
    expect(retireSharedWorkspaceIntent(marker, 'original intent', archive)).toBe(true)
    expect(readFileSync(join(archive, readdirSync(archive)[0]), 'utf8')).toBe('original intent')
    expect(readFileSync(join(root, 'recovery.json'), 'utf8')).toBe('preserved recovery')
    expect(() => readFileSync(marker)).toThrow()
  })
  it('leaves a renewed marker untouched', () => {
    const { marker, archive } = fixture()
    writeFileSync(marker, 'renewed intent')
    expect(retireSharedWorkspaceIntent(marker, 'original intent', archive)).toBe(false)
    expect(readFileSync(marker, 'utf8')).toBe('renewed intent')
  })
  it('replaces the previous expiry timer on renewal', () => {
    vi.useFakeTimers()
    const { marker, archive } = fixture()
    armSharedWorkspaceIntentExpiry(marker, 'original intent', archive, Date.now() + 100)
    writeFileSync(marker, 'renewed intent')
    armSharedWorkspaceIntentExpiry(marker, 'renewed intent', archive, Date.now() + 200)
    vi.advanceTimersByTime(101)
    expect(readFileSync(marker, 'utf8')).toBe('renewed intent')
    vi.advanceTimersByTime(100)
    expect(() => readFileSync(marker)).toThrow()
  })
})
