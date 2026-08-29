import { describe, expect, it, vi } from 'vitest'

import { WebSiteProfileRegistry } from './WebSiteProfileRegistry'
import type { CanvasBrowserProfileController } from '../canvas/CanvasBrowserProfile'

function fakeProfile(partition: string, surfaces = 0): CanvasBrowserProfileController {
  return {
    partition,
    activeSurfaceCount: surfaces,
    register: () => () => {},
    clearBrowsingData: vi.fn(async () => {})
  }
}

function harness(): {
  registry: WebSiteProfileRegistry
  created: string[]
  profiles: Map<string, CanvasBrowserProfileController>
} {
  const created: string[] = []
  const profiles = new Map<string, CanvasBrowserProfileController>()
  const registry = new WebSiteProfileRegistry({
    createProfile: (partition) => {
      created.push(partition)
      const profile = fakeProfile(partition)
      profiles.set(partition, profile)
      return profile
    }
  })
  return { registry, created, profiles }
}

describe('WebSiteProfileRegistry', () => {
  it('gives each site its own partition', () => {
    const { registry, created } = harness()
    registry.profileFor('example-com')
    registry.profileFor('other-example')
    expect(created).toEqual([
      'persist:taskwraith-site-example-com',
      'persist:taskwraith-site-other-example'
    ])
  })

  it('never hands two sites the same partition', () => {
    const { registry } = harness()
    const a = registry.profileFor('example-com').partition
    const b = registry.profileFor('example-com-2').partition
    expect(a).not.toBe(b)
  })

  it('reuses one profile per site so the jar survives reopening a canvas', () => {
    const { registry, created } = harness()
    const first = registry.profileFor('example-com')
    const second = registry.profileFor('example-com')
    expect(second).toBe(first)
    expect(created).toHaveLength(1)
  })

  it('never touches the app-wide canvas browser partition', () => {
    const { registry, created } = harness()
    registry.profileFor('example-com')
    expect(created.some((partition) => partition.includes('canvas-browser'))).toBe(false)
  })

  it('refuses an id that could escape the partition namespace', () => {
    const { registry, created } = harness()
    for (const bad of ['../escape', 'has space', 'Upper']) {
      expect(() => registry.profileFor(bad)).toThrow(/site login id/i)
    }
    expect(created).toEqual([])
  })

  it('clears only the named site', async () => {
    const { registry, profiles } = harness()
    registry.profileFor('example-com')
    registry.profileFor('other-example')
    await registry.clearSite('example-com')
    expect(
      profiles.get('persist:taskwraith-site-example-com')?.clearBrowsingData
    ).toHaveBeenCalled()
    expect(
      profiles.get('persist:taskwraith-site-other-example')?.clearBrowsingData
    ).not.toHaveBeenCalled()
  })

  it('clearing an unmaterialized site is a no-op, not a throw', async () => {
    const { registry } = harness()
    await expect(registry.clearSite('never-opened')).resolves.toBeUndefined()
  })

  it('forgetting drops the profile so the next sign-in starts clean', async () => {
    const { registry, created } = harness()
    registry.profileFor('example-com')
    await registry.forgetSite('example-com')
    expect(registry.has('example-com')).toBe(false)
    registry.profileFor('example-com')
    expect(created).toHaveLength(2)
  })

  it('surfaces a failed clear rather than swallowing it', async () => {
    const registry = new WebSiteProfileRegistry({
      createProfile: (partition) => ({
        partition,
        activeSurfaceCount: 1,
        register: () => () => {},
        clearBrowsingData: async () => {
          throw new Error('Close all Canvas Browser surfaces before clearing browsing data.')
        }
      })
    })
    registry.profileFor('example-com')
    await expect(registry.clearSite('example-com')).rejects.toThrow(/Close all Canvas Browser/)
  })

  it('names the sites that still have live surfaces', () => {
    const registry = new WebSiteProfileRegistry({
      createProfile: (partition) =>
        fakeProfile(partition, partition.endsWith('busy-example') ? 2 : 0)
    })
    registry.profileFor('busy-example')
    registry.profileFor('idle-example')
    expect(registry.activeSiteIds()).toEqual(['busy-example'])
  })
})
