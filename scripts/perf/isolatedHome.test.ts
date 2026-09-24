import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  isolatedPathsReferToSameLocation,
  verifyIsolatedHomeAndUserDataViaMainInspector
} = require('./isolatedHome.cjs')

const PRIVATE_HOME = '/private/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1'
const TMP_HOME = '/tmp/tw-evidence-v1/8ec2ed74d/perf-homes/ev1'
const PRIVATE_USERDATA = `${PRIVATE_HOME}/Library/Application Support/TaskWraith Dev ev1-small-2-cold`
const TMP_USERDATA = `${TMP_HOME}/Library/Application Support/TaskWraith Dev ev1-small-2-cold`

function inspectorReturning(value: {
  home: string
  userData: string
  homeRealpath: string
  userDataRealpath: string
}) {
  return {
    post: async () => ({ result: { value } })
  }
}

describe('isolatedPathsReferToSameLocation', () => {
  it('accepts lexical equality without consulting realpaths', () => {
    expect(isolatedPathsReferToSameLocation('/a', '/a', '/x', '/y')).toBe(true)
  })

  it('accepts /tmp vs /private/tmp when canonical realpaths match', () => {
    expect(
      isolatedPathsReferToSameLocation(
        TMP_USERDATA,
        PRIVATE_USERDATA,
        PRIVATE_USERDATA,
        PRIVATE_USERDATA
      )
    ).toBe(true)
    expect(
      isolatedPathsReferToSameLocation(
        PRIVATE_USERDATA,
        TMP_USERDATA,
        PRIVATE_USERDATA,
        PRIVATE_USERDATA
      )
    ).toBe(true)
  })

  it('rejects /tmp vs /private/tmp when realpaths differ or are empty', () => {
    expect(
      isolatedPathsReferToSameLocation(
        TMP_USERDATA,
        PRIVATE_USERDATA,
        '/private/tmp/other',
        PRIVATE_USERDATA
      )
    ).toBe(false)
    expect(isolatedPathsReferToSameLocation(TMP_USERDATA, PRIVATE_USERDATA, '', '')).toBe(false)
  })
})

describe('verifyIsolatedHomeAndUserDataViaMainInspector macOS tmp alias', () => {
  it('verifies --home given as /private/tmp when Electron reports /tmp userData', async () => {
    const probe = await verifyIsolatedHomeAndUserDataViaMainInspector(
      inspectorReturning({
        home: PRIVATE_HOME,
        userData: TMP_USERDATA,
        homeRealpath: PRIVATE_HOME,
        userDataRealpath: PRIVATE_USERDATA
      }),
      {
        home: PRIVATE_HOME,
        userDataPath: PRIVATE_USERDATA,
        homeRealpath: PRIVATE_HOME,
        userDataRealpath: PRIVATE_USERDATA
      }
    )
    expect(probe.ok).toBe(true)
    // The probe reports path.resolve'd forms; on win32 that is drive-qualified
    // and backslashed, so compare against the same shape. The alias semantics
    // under test (lexical /tmp vs /private/tmp, equal realpaths) are unchanged.
    expect(probe.observedUserDataPath).toBe(path.resolve(TMP_USERDATA))
    expect(probe.expectedUserDataPath).toBe(path.resolve(PRIVATE_USERDATA))
    expect(probe.observedUserDataRealpath).toBe(path.resolve(PRIVATE_USERDATA))
  })

  it('verifies --home given as /tmp when expected and observed stay /tmp', async () => {
    const probe = await verifyIsolatedHomeAndUserDataViaMainInspector(
      inspectorReturning({
        home: TMP_HOME,
        userData: TMP_USERDATA,
        homeRealpath: PRIVATE_HOME,
        userDataRealpath: PRIVATE_USERDATA
      }),
      {
        home: TMP_HOME,
        userDataPath: TMP_USERDATA,
        homeRealpath: PRIVATE_HOME,
        userDataRealpath: PRIVATE_USERDATA
      }
    )
    expect(probe.ok).toBe(true)
  })

  it('still refuses a different directory that only shares the /tmp prefix', async () => {
    await expect(
      verifyIsolatedHomeAndUserDataViaMainInspector(
        inspectorReturning({
          home: PRIVATE_HOME,
          userData: '/tmp/other/Library/Application Support/TaskWraith Dev ev1-small-2-cold',
          homeRealpath: PRIVATE_HOME,
          userDataRealpath:
            '/private/tmp/other/Library/Application Support/TaskWraith Dev ev1-small-2-cold'
        }),
        {
          home: PRIVATE_HOME,
          userDataPath: PRIVATE_USERDATA,
          homeRealpath: PRIVATE_HOME,
          userDataRealpath: PRIVATE_USERDATA
        }
      )
    ).rejects.toThrow(/userData.*mismatch/i)
  })

  it('still refuses lexical match when canonical realpaths diverge', async () => {
    await expect(
      verifyIsolatedHomeAndUserDataViaMainInspector(
        inspectorReturning({
          home: PRIVATE_HOME,
          userData: PRIVATE_USERDATA,
          homeRealpath: PRIVATE_HOME,
          userDataRealpath: '/private/tmp/escaped'
        }),
        {
          home: PRIVATE_HOME,
          userDataPath: PRIVATE_USERDATA,
          homeRealpath: PRIVATE_HOME,
          userDataRealpath: PRIVATE_USERDATA
        }
      )
    ).rejects.toThrow(/userData realpath mismatch/i)
  })
})
