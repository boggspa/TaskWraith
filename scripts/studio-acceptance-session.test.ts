import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  assertWindowServerSessionAvailable,
  hudAssetIdentityToken,
  hudContainsAsset,
  parseBytes,
  resourceSample
} = require('./studio-acceptance-session.cjs') as {
  assertWindowServerSessionAvailable: (
    sampleIndex: number,
    phase: string,
    state: Record<string, unknown>
  ) => Record<string, unknown>
  hudContainsAsset: (
    hud: { observations: Array<{ text: string }> },
    assetId: string
  ) => Record<string, unknown>
  hudAssetIdentityToken: (assetId: string) => string
  parseBytes: (text: string) => number
  resourceSample: (
    pid: number,
    index: number,
    elapsedSeconds: number,
    adapters: Record<string, unknown>
  ) => Record<string, any>
}

describe('tracked Studio acceptance session', () => {
  it('requires an exact full HUD asset digest', () => {
    const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
    const token = hudAssetIdentityToken(assetId)
    expect(hudContainsAsset({ observations: [{ text: token }] }, assetId)).toMatchObject({
      matched: true,
      distance: 0,
      comparedLength: 64,
      threshold: 0
    })
    expect(
      hudContainsAsset(
        {
          observations: [
            {
              text: `2${token.slice(1)}`
            }
          ]
        },
        assetId
      )
    ).toMatchObject({ matched: false })
  })

  it('fails closed when WindowServer evidence is unavailable', () => {
    expect(() =>
      assertWindowServerSessionAvailable(2, 'diagnostics', {
        screenLocked: true,
        onConsole: true,
        loginDone: true,
        windowServerEvidenceAvailable: false
      })
    ).toThrow(/WindowServer session unavailable/)
  })

  it('parses allocation classes and exact-process resource receipts', () => {
    const pid = 4_321
    const commands: string[] = []
    const summary =
      'Physical footprint: 100M\n' +
      'Physical footprint (peak): 120M\n' +
      'IOSurface 10M 0B 8M 3\n' +
      'MALLOC ZONE\n' +
      'TOTAL 0 0 0 0 0 64M\n'
    const detailed =
      'IOSurface 1000-2000 4K 4K SurfaceID: 0xabc\n' +
      'IOSurface 3000-4000 4K 4K CoreUI image IOSurface SurfaceID: 0xdef\n'
    const sample = resourceSample(pid, 3, 12.5, {
      runExact: (command: string, args: string[]) => {
        commands.push([command, ...args].join(' '))
        const stdout =
          command === '/usr/bin/vmmap'
            ? args[0] === '-summary'
              ? summary
              : detailed
            : command === '/usr/bin/top'
              ? '4321 1.2 100M 0.5 00:01.00 TaskWraithStudioCompanion\n'
              : '4321 1.2 102400 204800 00:01.00\n'
        return {
          command: [command, ...args],
          exitCode: 0,
          stdout,
          stderr: ''
        }
      }
    })

    expect(parseBytes('1.5G')).toBe(1_610_612_736)
    expect(sample).toMatchObject({
      index: 3,
      elapsedSeconds: 12.5,
      physicalFootprintBytes: 104_857_600,
      peakPhysicalFootprintBytes: 125_829_120,
      mallocAllocatedBytes: 67_108_864,
      iosurfaceVirtualBytes: 10_485_760,
      iosurfaceResidentBytes: 8_388_608,
      iosurfaceRegionCount: 3,
      productSurfaceIds: ['0xabc'],
      mappedRegionIdentities: ['0xabc'],
      ps: {
        pid,
        rssKilobytes: 102_400,
        virtualKilobytes: 204_800
      }
    })
    expect(commands).toHaveLength(4)
    expect(sample.rawReceipts.vmmapSummarySha256).toMatch(/^[a-f0-9]{64}$/)
  })
})
