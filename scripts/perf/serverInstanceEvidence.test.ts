import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { taskWraithHostSocketPath } from '../../src/shared/taskWraithHostPaths.node'

const require = createRequire(import.meta.url)
const { collectServerInstanceEvidence } = require('./serverInstanceEvidence.cjs')

function fixture(platform = 'linux') {
  const userDataPath = '/synthetic/profile'
  const discovery = {
    pid: 123,
    startedAt: '2026-10-02T13:00:00.000Z',
    hostId: 'host-a',
    socketPath: taskWraithHostSocketPath(userDataPath, platform as NodeJS.Platform),
    tokenPath: '/secret/token'
  }
  const expectedIdentity = {
    instanceId: 'host-a',
    pid: 123,
    generation: 4,
    bootEpoch: 'a'.repeat(64)
  }
  const probeResult = {
    ok: true,
    discovery,
    expectedIdentity,
    token: 'secret-token'
  }
  return {
    discovery,
    expectedIdentity,
    probeResult,
    options: {
      userDataPath,
      platform,
      probe: async () => probeResult,
      readDiscovery: () => ({ ok: true, discovery })
    }
  }
}

describe('G-H authenticated server evidence', () => {
  it.each(['linux', 'darwin', 'win32'])(
    'matches production socket namespaces on %s',
    async (platform) => {
      const input = fixture(platform)
      const result = await collectServerInstanceEvidence(input.options)
      expect(result.ok).toBe(true)
      expect(result.evidence).toMatchObject({
        hostPid: 123,
        hostId: 'host-a',
        generation: 4,
        bootEpoch: 'a'.repeat(64)
      })
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(JSON.stringify(result)).not.toContain('tokenPath')
      expect(JSON.stringify(result)).not.toContain(input.options.userDataPath)
    }
  )

  it('refuses legacy identity without epoch, invalid pid and malformed epoch', async () => {
    for (const override of [{ bootEpoch: undefined }, { pid: 0 }, { bootEpoch: 'bad' }]) {
      const input = fixture()
      Object.assign(input.expectedIdentity, override)
      expect(await collectServerInstanceEvidence(input.options)).toEqual({
        ok: false,
        reason: 'complete_host_identity_required'
      })
    }
  })

  it('refuses discovery changes across authenticated handshake', async () => {
    const input = fixture()
    input.options.readDiscovery = () => ({ ok: true, discovery: { ...input.discovery, pid: 456 } })
    expect(await collectServerInstanceEvidence(input.options)).toEqual({
      ok: false,
      reason: 'discovery_identity_changed'
    })
  })

  it('refuses foreign profile namespace even with valid authentication', async () => {
    const input = fixture()
    input.discovery.socketPath = taskWraithHostSocketPath('/foreign/profile', 'linux')
    expect(await collectServerInstanceEvidence(input.options)).toEqual({
      ok: false,
      reason: 'profile_socket_namespace_mismatch'
    })
  })

  it('contains thrown errors and failed probe details', async () => {
    const input = fixture()
    for (const probe of [
      async () => {
        throw new Error('secret-token')
      },
      async () => ({ ok: false, reason: 'secret-token' })
    ]) {
      const result = await collectServerInstanceEvidence({ ...input.options, probe })
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })

  it('records fresh incarnation identity without treating it as acceptance', async () => {
    const input = fixture()
    const before = await collectServerInstanceEvidence(input.options)
    input.expectedIdentity.bootEpoch = 'b'.repeat(64)
    const after = await collectServerInstanceEvidence(input.options)
    expect(after.evidence.hostId).toBe(before.evidence.hostId)
    expect(after.evidence.bootEpoch).not.toBe(before.evidence.bootEpoch)
    expect(after.evidence.acceptance).toBeUndefined()
  })
})
