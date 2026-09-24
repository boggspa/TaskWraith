import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createIdentityHandoffBootstrap,
  reconcileReleaseIdentityUpdateChannel
} from './IdentityHandoffBootstrap'
import type { IdentityHandoffSnapshot } from './IdentityHandoffService'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'identity-handoff-bootstrap-'))
  roots.push(value)
  return value
}

describe('IdentityHandoffBootstrap', () => {
  it('keeps the runtime seam disabled behind the explicit staging override', () => {
    const bootstrap = createIdentityHandoffBootstrap({
      appPath: '/app.asar',
      currentVersion: '1.9.9',
      userDataPath: root(),
      envOverride: 'off',
      readPackageText: () =>
        JSON.stringify({
          taskwraithDistributionIdentity: 'beta',
          taskwraithAppId: 'com.chrisizatt.taskwraith',
          taskwraithUpdateFeedChannel: 'latest'
        }),
      fetcher: vi.fn(),
      quit: vi.fn()
    })
    expect(bootstrap.distribution).toMatchObject({ series: 'beta', valid: true })
    expect(bootstrap.service).toBeUndefined()
  })

  it('maps every target profile to the stable/Release setting once', () => {
    const updateChannel = vi.fn()
    const reread = vi.fn(() => ({ updateChannel: 'stable', marker: 'reread' }))
    const snapshot = {
      phase: 'complete'
    } as IdentityHandoffSnapshot
    const result = reconcileReleaseIdentityUpdateChannel(
      {
        distribution: {
          series: 'release',
          appId: 'com.taskwraith.desktop',
          stableUpdateChannel: 'release',
          valid: true
        },
        service: { snapshot: () => snapshot } as any
      },
      { updateChannel: 'nightly', marker: 'before' },
      updateChannel,
      reread
    )

    expect(updateChannel).toHaveBeenCalledWith('stable')
    expect(reread).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ updateChannel: 'stable', marker: 'reread' })
  })

  it('leaves already-stable Release profiles alone', () => {
    const updateChannel = vi.fn()
    const current = { updateChannel: 'stable' }
    expect(
      reconcileReleaseIdentityUpdateChannel(
        {
          distribution: {
            series: 'release',
            appId: 'com.taskwraith.desktop',
            stableUpdateChannel: 'release',
            valid: true
          }
        },
        current,
        updateChannel,
        () => current
      )
    ).toBe(current)
    expect(updateChannel).not.toHaveBeenCalled()
  })
})
