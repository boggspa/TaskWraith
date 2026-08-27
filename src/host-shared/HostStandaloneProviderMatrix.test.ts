import { describe, expect, it } from 'vitest'

import { LIVE_SELECTABLE_PROVIDER_IDS } from '../shared/retiredProviders'
import { PI_UPSTREAM_KEY_ENV } from './pi/PiModelPolicy'
import {
  hostStandaloneAntigravityStatus,
  hostStandaloneComposedProviderIds,
  hostStandaloneProviderMatrix
} from './HostStandaloneProviderMatrix'

describe('HostStandaloneProviderMatrix', () => {
  it('composes exactly the live-selectable set and no others', () => {
    expect(hostStandaloneComposedProviderIds()).toEqual([...LIVE_SELECTABLE_PROVIDER_IDS])
    expect(hostStandaloneComposedProviderIds()).not.toContain('antigravity')

    const liveRows = hostStandaloneProviderMatrix().filter((row) => row.kind === 'live')
    expect(liveRows.map((row) => row.providerId)).toEqual([...LIVE_SELECTABLE_PROVIDER_IDS])
    expect(liveRows.every((row) => row.standaloneHost === 'composed')).toBe(true)
  })

  it('projects AntiGravity as desktop-conditional and standalone-unavailable', () => {
    const status = hostStandaloneAntigravityStatus()
    expect(status).toMatchObject({
      providerId: 'antigravity',
      kind: 'conditional',
      standaloneHost: 'unavailable',
      run: 'unavailable'
    })
    expect(status.detail).toMatch(/does not compose or admit AntiGravity/)

    const row = hostStandaloneProviderMatrix().find((entry) => entry.providerId === 'antigravity')
    expect(row).toMatchObject({
      providerId: 'antigravity',
      kind: 'conditional',
      standaloneHost: 'unavailable',
      run: 'unavailable',
      catalogManualFlow: false,
      envKeys: []
    })
    expect(hostStandaloneComposedProviderIds()).not.toContain('antigravity')
  })

  it('advertises Grok manual login plus env-key alternative without inventing a Pi login', () => {
    const grok = hostStandaloneProviderMatrix().find((row) => row.providerId === 'grok')
    expect(grok).toMatchObject({
      kind: 'live',
      standaloneHost: 'composed',
      run: 'available',
      catalogManualFlow: true,
      envKeys: ['XAI_API_KEY', 'GROK_API_KEY']
    })
    expect(grok?.detail).toMatch(/grok login/)
    expect(grok?.detail).toMatch(/XAI_API_KEY/)

    const pi = hostStandaloneProviderMatrix().find((row) => row.providerId === 'pi')
    expect(pi).toMatchObject({
      kind: 'live',
      standaloneHost: 'composed',
      run: 'available',
      catalogManualFlow: false
    })
    expect(pi?.envKeys).toEqual(Object.values(PI_UPSTREAM_KEY_ENV))
    expect(pi?.detail).toMatch(/No terminal login/)

    const ollama = hostStandaloneProviderMatrix().find((row) => row.providerId === 'ollama')
    expect(ollama).toMatchObject({
      kind: 'live',
      standaloneHost: 'composed',
      run: 'available',
      catalogManualFlow: false,
      envKeys: []
    })
    expect(ollama?.detail).toMatch(/No terminal login/)
    expect(ollama?.detail).toMatch(/daemon reachability/)
  })

  it('keeps Cursor setup-only rather than runnable', () => {
    const cursor = hostStandaloneProviderMatrix().find((row) => row.providerId === 'cursor')
    expect(cursor).toMatchObject({
      kind: 'live',
      standaloneHost: 'composed',
      run: 'setup-only',
      catalogManualFlow: true
    })
    expect(cursor?.detail).toMatch(/hard-stopped/)
  })
})
