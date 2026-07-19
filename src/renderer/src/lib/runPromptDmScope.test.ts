import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  resolveComposerRunDmTarget,
  withExplicitEnsembleDmTarget
} from './runPromptDmScope'

const participants: EnsembleParticipant[] = [
  {
    id: 'boss-id',
    provider: 'grok',
    role: 'Boss',
    instructions: '',
    order: 1,
    enabled: true,
    model: 'grok-4.5',
    permissionPresetId: 'default'
  }
]

describe('resolveComposerRunDmTarget', () => {
  it('infers the directed seat for central shortcut submissions', () => {
    expect(
      resolveComposerRunDmTarget({
        prompt: '@Boss queued shortcut prompt',
        participants,
        inferFromPrompt: true
      })
    ).toBe('boss-id')
  })

  it('preserves an explicit target ahead of prompt inference', () => {
    expect(
      resolveComposerRunDmTarget({
        explicitParticipantId: 'selected-id',
        prompt: '@Boss queued shortcut prompt',
        participants,
        inferFromPrompt: true
      })
    ).toBe('selected-id')
  })

  it('does not infer targets for internal existing-prompt dispatches', () => {
    expect(
      resolveComposerRunDmTarget({
        prompt: '@Boss internal prompt',
        participants,
        inferFromPrompt: false
      })
    ).toBeUndefined()
  })

  it('keeps direct composer Steer on the resolved participant with fan-out off', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const steerStart = appSource.indexOf('const handleSteer = async')
    const steerEnd = appSource.indexOf('// Guard: if there\'s no active run', steerStart)
    expect(steerStart).toBeGreaterThanOrEqual(0)
    expect(steerEnd).toBeGreaterThan(steerStart)

    const ensembleSteer = appSource.slice(steerStart, steerEnd)
    expect(ensembleSteer).toContain('const dmTargetParticipantId = resolveComposerRunDmTarget({')
    expect(ensembleSteer).toContain(
      'const fanoutPolicy: EnsembleFanoutPolicy = dmTargetParticipantId'
    )
    expect(ensembleSteer).toContain("? 'off'")
    expect(ensembleSteer).toContain(
      '...(dmTargetParticipantId ? { dmTargetParticipantId } : {})'
    )
  })
})

describe('withExplicitEnsembleDmTarget', () => {
  it('stamps Retry/chip identity into the prompt so old aliases cannot retarget it', () => {
    const retryPrompt = withExplicitEnsembleDmTarget({
      prompt: '@OtherRole was in the original request',
      participantId: 'boss-id',
      participants
    })
    expect(retryPrompt).toBe(
      '[@Boss](ensemble-dm://boss-id) @OtherRole was in the original request'
    )
  })

  it('keeps a stale exact id visible for MAIN to reject against its current roster', () => {
    expect(
      withExplicitEnsembleDmTarget({
        prompt: 'Retry this',
        participantId: 'removed-seat',
        participants
      })
    ).toBe('[@removed-seat](ensemble-dm://removed-seat) Retry this')
  })

  it('replaces a conflicting old structured target while preserving its visible label', () => {
    expect(
      withExplicitEnsembleDmTarget({
        prompt: 'Ask [@Reviewer](ensemble-dm://old-seat) to verify it',
        participantId: 'boss-id',
        participants
      })
    ).toBe('[@Boss](ensemble-dm://boss-id) Ask @Reviewer to verify it')
  })
})
