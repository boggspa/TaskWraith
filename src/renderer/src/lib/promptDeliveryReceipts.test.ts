import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { promptDeliveryReceiptMetadataPatch } from './promptDeliveryReceipts'

describe('promptDeliveryReceiptMetadataPatch', () => {
  it('persists every admitted candidate under its stable metadata key', () => {
    expect(
      promptDeliveryReceiptMetadataPatch(
        {
          workInvariants: { provider: 'codex', value: 'work-v1' },
          skillDiscovery: { provider: 'codex', value: 'skills-sha' },
          sessionStartContext: { provider: 'codex', value: 'hook-sha' },
          workspaceDoctrine: { provider: 'codex', value: 'doctrine-sha' }
        },
        'codex'
      )
    ).toEqual({
      taskWraithWorkInvariantsVersion: 'work-v1',
      taskWraithWorkInvariantsProvider: 'codex',
      taskWraithSkillDiscoveryDigest: 'skills-sha',
      taskWraithSkillDiscoveryProvider: 'codex',
      taskWraithSessionStartContextDigest: 'hook-sha',
      taskWraithSessionStartContextProvider: 'codex',
      taskWraithWorkspaceDoctrineDigest: 'doctrine-sha',
      taskWraithWorkspaceDoctrineProvider: 'codex'
    })
  })

  it('ignores candidates for another provider and blank values', () => {
    expect(
      promptDeliveryReceiptMetadataPatch(
        {
          workInvariants: { provider: 'claude', value: 'work-v1' },
          skillDiscovery: { provider: 'codex', value: ' ' }
        },
        'codex'
      )
    ).toEqual({})
  })

  it('persists candidates only after the provider admits run_started', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const runStarted = appSource.indexOf("event.type === 'run_started'")
    const runFinished = appSource.indexOf("event.type === 'run_finished'", runStarted)
    expect(runStarted).toBeGreaterThan(0)
    expect(runFinished).toBeGreaterThan(runStarted)
    const call = 'const promptDeliveryPatch = promptDeliveryReceiptMetadataPatch('
    expect(appSource.slice(0, runStarted)).not.toContain(call)
    expect(appSource.slice(runStarted, runFinished)).toContain(call)
  })
})
