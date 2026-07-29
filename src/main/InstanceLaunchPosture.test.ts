import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import {
  buildInstanceLaunchBootstrapArgs,
  createPackagedIsolatedInstanceId,
  PACKAGE_SMOKE_ARG,
  PACKAGE_SMOKE_USER_DATA_ARG,
  PACKAGED_ISOLATED_INSTANCE_ARG,
  resolveInstanceLaunchPosture
} from './InstanceLaunchPosture'

// Production resolves this path, so the expectations must too: on Windows
// `resolve()` prefixes the current drive (`D:\\Users\\...`) while `join()`
// does not, and the literal POSIX form matched neither.
const appDataPath = '/Users/example/Library/Application Support'
const temporaryDirectory = '/tmp'
const isolatedInstanceId = 'a'.repeat(32)

describe('resolveInstanceLaunchPosture', () => {
  it('keeps packaged production on the ordinary Electron profile despite ambient dev identity', () => {
    expect(
      resolveInstanceLaunchPosture({
        isPackaged: true,
        argv: [],
        appDataPath,
        ambientDevInstanceId: 'dev-42'
      })
    ).toEqual({ kind: 'production', isPackaged: true, isPrivateProfile: false })
  })

  it('preserves the existing unpackaged dev naming and sanitization behavior', () => {
    expect(
      resolveInstanceLaunchPosture({
        isPackaged: false,
        argv: [],
        appDataPath,
        ambientDevInstanceId: '  verify!@@@  '
      })
    ).toEqual({
      kind: 'development',
      isPackaged: false,
      isPrivateProfile: true,
      appName: 'TaskWraith Dev verify',
      userDataPath: resolve(appDataPath, 'TaskWraith Dev verify'),
      devInstanceId: 'verify'
    })
  })

  it('accepts one explicit packaged isolated-instance token and derives a profile below appData', () => {
    const posture = resolveInstanceLaunchPosture({
      isPackaged: true,
      argv: [`${PACKAGED_ISOLATED_INSTANCE_ARG}${isolatedInstanceId}`],
      appDataPath,
      ambientDevInstanceId: 'must-not-matter'
    })

    expect(posture).toEqual({
      kind: 'packaged-isolated',
      isPackaged: true,
      isPrivateProfile: true,
      appName: `TaskWraith Instance ${isolatedInstanceId}`,
      userDataPath: resolve(appDataPath, 'TaskWraith Instances', isolatedInstanceId),
      instanceId: isolatedInstanceId
    })
    expect(buildInstanceLaunchBootstrapArgs(posture)).toEqual([
      `${PACKAGED_ISOLATED_INSTANCE_ARG}${isolatedInstanceId}`
    ])
  })

  it('fails closed for malformed, duplicate, or conflicting packaged private-launch intent', () => {
    const invalidIsolated = resolveInstanceLaunchPosture({
      isPackaged: true,
      argv: ['--taskwraith-isolated-instance'],
      appDataPath
    })
    const duplicateIsolated = resolveInstanceLaunchPosture({
      isPackaged: true,
      argv: [
        `${PACKAGED_ISOLATED_INSTANCE_ARG}${isolatedInstanceId}`,
        `${PACKAGED_ISOLATED_INSTANCE_ARG}${'b'.repeat(32)}`
      ],
      appDataPath
    })
    const conflictingPrivateLaunch = resolveInstanceLaunchPosture({
      isPackaged: true,
      argv: [
        PACKAGE_SMOKE_ARG,
        `${PACKAGE_SMOKE_USER_DATA_ARG}/tmp/taskwraith-tui-package-smoke-abc`,
        `${PACKAGED_ISOLATED_INSTANCE_ARG}${isolatedInstanceId}`
      ],
      appDataPath,
      temporaryDirectory
    })

    expect(invalidIsolated).toMatchObject({
      kind: 'invalid',
      reason: 'invalid-packaged-isolated-instance'
    })
    expect(duplicateIsolated).toMatchObject({
      kind: 'invalid',
      reason: 'invalid-packaged-isolated-instance'
    })
    expect(conflictingPrivateLaunch).toMatchObject({
      kind: 'invalid',
      reason: 'conflicting-private-launch-arguments'
    })
  })

  it('retains the narrow package-smoke posture and propagates it to trusted helpers', () => {
    // resolvePackagedSmokeUserDataPath returns `resolve(rawPath)`
    // (InstanceLaunchPosture.ts:162,165), so the expectation has to be the
    // resolved form or Windows compares `/tmp/...` against `D:\tmp\...`.
    // Containment is unaffected: production resolves the temporary root too.
    const smokeUserDataPath = resolve('/tmp/taskwraith-tui-package-smoke-abc123')
    const posture = resolveInstanceLaunchPosture({
      isPackaged: true,
      argv: [PACKAGE_SMOKE_ARG, `${PACKAGE_SMOKE_USER_DATA_ARG}${smokeUserDataPath}`],
      temporaryDirectory
    })

    expect(posture).toEqual({
      kind: 'package-smoke',
      isPackaged: true,
      isPrivateProfile: true,
      appName: 'TaskWraith Package Smoke',
      userDataPath: smokeUserDataPath
    })
    expect(buildInstanceLaunchBootstrapArgs(posture)).toEqual([
      PACKAGE_SMOKE_ARG,
      `${PACKAGE_SMOKE_USER_DATA_ARG}${smokeUserDataPath}`
    ])
  })

  it('does not downgrade an invalid package-smoke path to production', () => {
    expect(
      resolveInstanceLaunchPosture({
        isPackaged: true,
        argv: [PACKAGE_SMOKE_ARG, `${PACKAGE_SMOKE_USER_DATA_ARG}/Users/example/not-a-smoke`],
        temporaryDirectory
      })
    ).toMatchObject({ kind: 'invalid', reason: 'invalid-package-smoke-profile' })
  })

  it('generates only validated opaque isolated identifiers', () => {
    expect(createPackagedIsolatedInstanceId(() => 'c'.repeat(48))).toBe('c'.repeat(48))
    expect(() => createPackagedIsolatedInstanceId(() => 'short')).toThrow(
      'Generated packaged isolated instance id is invalid.'
    )
  })
})
