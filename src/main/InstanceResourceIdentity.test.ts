import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { resolveInstanceLaunchPosture } from './InstanceLaunchPosture'
import {
  createInstanceResourceEpoch,
  createInstanceResourceIdentity
} from './InstanceResourceIdentity'

const appDataPath = '/Users/example/Library/Application Support'
const primaryUserDataPath = join(appDataPath, 'TaskWraith')
const firstInstanceId = 'a'.repeat(32)
const secondInstanceId = 'b'.repeat(32)

function isolatedPosture(instanceId: string) {
  return resolveInstanceLaunchPosture({
    isPackaged: true,
    argv: [`--taskwraith-isolated-instance=${instanceId}`],
    appDataPath
  })
}

describe('createInstanceResourceIdentity', () => {
  it('generates a validated opaque per-process resource epoch', () => {
    expect(createInstanceResourceEpoch(() => 'e'.repeat(48))).toBe('e'.repeat(48))
    expect(() => createInstanceResourceEpoch(() => 'instance-epoch-1')).toThrow(
      'Generated instance resource epoch is invalid.'
    )
  })

  it('derives profile-local broker and bridge-log resources without filesystem effects', () => {
    const posture = isolatedPosture(firstInstanceId)
    const identity = createInstanceResourceIdentity({
      posture,
      userDataPath: join(appDataPath, 'TaskWraith Instances', firstInstanceId)
    })

    expect(identity).toMatchObject({
      postureKind: 'packaged-isolated',
      isPrivateProfile: true,
      userDataPath: join(appDataPath, 'TaskWraith Instances', firstInstanceId),
      geminiMcpSocketPath: join(
        appDataPath,
        'TaskWraith Instances',
        firstInstanceId,
        'taskwraith-gemini-mcp.sock'
      ),
      bridgeLogDirectory: join(appDataPath, 'TaskWraith Instances', firstInstanceId, 'bridge-logs'),
      bridgeLogPath: join(
        appDataPath,
        'TaskWraith Instances',
        firstInstanceId,
        'bridge-logs',
        'bridge-subprocess.log'
      ),
      bridgeLogEpochPath: join(
        appDataPath,
        'TaskWraith Instances',
        firstInstanceId,
        'bridge-logs',
        'bridge-subprocess.log.epoch'
      )
    })
    expect(identity.scopeId).not.toContain(firstInstanceId)
    expect(identity.bridgeLogEpochNamespace).toBe(`bridge-log:${identity.scopeId}`)
  })

  it('assigns independent sockets, logs, and epoch namespaces to independent profiles', () => {
    const first = createInstanceResourceIdentity({
      posture: isolatedPosture(firstInstanceId),
      userDataPath: join(appDataPath, 'TaskWraith Instances', firstInstanceId)
    })
    const second = createInstanceResourceIdentity({
      posture: isolatedPosture(secondInstanceId),
      userDataPath: join(appDataPath, 'TaskWraith Instances', secondInstanceId)
    })

    expect(first.geminiMcpSocketPath).not.toBe(second.geminiMcpSocketPath)
    expect(first.bridgeLogPath).not.toBe(second.bridgeLogPath)
    expect(first.bridgeLogEpochPath).not.toBe(second.bridgeLogEpochPath)
    expect(first.bridgeLogEpochNamespace).not.toBe(second.bridgeLogEpochNamespace)
  })

  it('allows primary production resources while rejecting a private posture/path mismatch', () => {
    const production = resolveInstanceLaunchPosture({ isPackaged: true, argv: [] })
    const primary = createInstanceResourceIdentity({
      posture: production,
      userDataPath: primaryUserDataPath
    })

    expect(primary.isPrivateProfile).toBe(false)
    expect(primary.geminiMcpSocketPath).toBe(
      join(primaryUserDataPath, 'taskwraith-gemini-mcp.sock')
    )
    expect(() =>
      createInstanceResourceIdentity({
        posture: isolatedPosture(firstInstanceId),
        userDataPath: primaryUserDataPath
      })
    ).toThrow('Private launch posture does not match the selected userData path.')
  })

  it('rejects invalid postures and root userData targets', () => {
    const invalidPosture = resolveInstanceLaunchPosture({
      isPackaged: true,
      argv: ['--taskwraith-isolated-instance'],
      appDataPath
    })
    const production = resolveInstanceLaunchPosture({ isPackaged: true, argv: [] })

    expect(() =>
      createInstanceResourceIdentity({ posture: invalidPosture, userDataPath: primaryUserDataPath })
    ).toThrow('Invalid launch posture cannot own instance resources.')
    expect(() =>
      createInstanceResourceIdentity({ posture: production, userDataPath: '/' })
    ).toThrow('Instance userData path must be an absolute non-root directory.')
  })
})
