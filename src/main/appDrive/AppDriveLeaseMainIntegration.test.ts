import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('AppDrive lease main integration', () => {
  it('shares one lease registry across web and Simulator controllers', () => {
    expect(mainSource).toContain('const appDriveSurfaceLeases = new AppDriveLeaseRegistry()')
    expect(mainSource).toContain('appDriveLeases: appDriveSurfaceLeases')
    expect(mainSource).toContain('leases: appDriveSurfaceLeases')
  })

  it('binds approval, execution, invalidation, and run-terminal seams', () => {
    expect(mainSource).toContain('appDriveLeaseRuntime.prepareApproval(')
    expect(mainSource).toContain('appDriveLeaseRuntime.authorize({')
    expect(mainSource).toContain('appDriveLeaseRuntime.invalidateWebSurface(input)')
    expect(mainSource).toContain('appDriveLeaseRuntime.revokeRun(event.session.runId)')
  })

  it('removes exact grants when Simulator human takeover invalidates a lease', () => {
    expect(mainSource).toContain('onAuthorityInvalidated: (token) => {')
    expect(mainSource).toContain("'simulatorCanvas',")
    expect(mainSource).toContain('token.surfaceId')
  })
})
