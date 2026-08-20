import { describe, expect, it, vi } from 'vitest'
import { resolvePackagedBridgeDaemonPath } from './BridgeDaemonBinaryPath'

describe('resolvePackagedBridgeDaemonPath', () => {
  it('prefers the macOS helper location over the legacy resource location', () => {
    const pathExists = vi.fn(() => true)

    expect(
      resolvePackagedBridgeDaemonPath('/Applications/TaskWraith.app/Contents/Resources', pathExists)
    ).toBe('/Applications/TaskWraith.app/Contents/Helpers/TaskWraithBridgeDaemon')
    expect(pathExists).toHaveBeenCalledTimes(1)
  })

  it('retains the resource path only as an older-package fallback', () => {
    const pathExists = vi.fn((candidate: string) => candidate.includes('/Resources/bridge/'))

    expect(
      resolvePackagedBridgeDaemonPath('/Applications/TaskWraith.app/Contents/Resources', pathExists)
    ).toBe('/Applications/TaskWraith.app/Contents/Resources/bridge/TaskWraithBridgeDaemon')
  })

  it('returns null when no packaged daemon exists', () => {
    expect(resolvePackagedBridgeDaemonPath(undefined)).toBeNull()
    expect(
      resolvePackagedBridgeDaemonPath(
        '/Applications/TaskWraith.app/Contents/Resources',
        () => false
      )
    ).toBeNull()
  })
})
