import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_AGENT_IPC_CHANNELS,
  type ChannelAgentIpcEnrollInput,
  type ChannelAgentIpcGrantInput,
  type ChannelAgentIpcOverviewInput,
  type ChannelAgentIpcRevokeInput,
  type ChannelAgentIpcRotateInput
} from '../shared/collaboration/ChannelAgentIpc'
import {
  createChannelAgentIpcBridge,
  type ChannelAgentIpcRendererPort
} from './channelAgentIpcBridge'

function fixture() {
  const invoke = vi.fn(async (channel: string) => ({ ok: true, value: channel }))
  const bridge = createChannelAgentIpcBridge({ invoke } as ChannelAgentIpcRendererPort)
  return { bridge, invoke }
}

describe('Channel agent IPC preload bridge', () => {
  it('exposes only the five closed invokes and preserves exact payload identity', async () => {
    const target = fixture()
    expect(Object.keys(target.bridge)).toEqual(['overview', 'enroll', 'grant', 'revoke', 'rotate'])
    expect(Object.isFrozen(target.bridge)).toBe(true)

    const overview: ChannelAgentIpcOverviewInput = { channelId: 'channel-a' }
    const enroll: ChannelAgentIpcEnrollInput = {
      requestId: 'request-enroll-1',
      channelId: 'channel-a',
      agentSeatId: 'pooled-agent-preload-proof'
    }
    const grant: ChannelAgentIpcGrantInput = {
      ...enroll,
      requestId: 'request-grant-1',
      permissionPresetId: 'read_only',
      allowedMentionerMemberIds: ['owner-member'],
      ttlMs: 300_000,
      maxDispatches: 1
    }
    const revoke: ChannelAgentIpcRevokeInput = {
      ...enroll,
      requestId: 'request-revoke-1'
    }
    const rotate: ChannelAgentIpcRotateInput = {
      ...enroll,
      requestId: 'request-rotate-1',
      reEnrollChannelIds: ['channel-b']
    }

    await target.bridge.overview(overview)
    await target.bridge.enroll(enroll)
    await target.bridge.grant(grant)
    await target.bridge.revoke(revoke)
    await target.bridge.rotate(rotate)

    expect(target.invoke.mock.calls).toEqual([
      [CHANNEL_AGENT_IPC_CHANNELS.overview, overview],
      [CHANNEL_AGENT_IPC_CHANNELS.enroll, enroll],
      [CHANNEL_AGENT_IPC_CHANNELS.grant, grant],
      [CHANNEL_AGENT_IPC_CHANNELS.revoke, revoke],
      [CHANNEL_AGENT_IPC_CHANNELS.rotate, rotate]
    ])
  })

  it('rejects a missing renderer invoke port without exposing event or generic IPC methods', () => {
    expect(() => createChannelAgentIpcBridge(undefined as never)).toThrow(
      'requires an IPC renderer port'
    )
    const target = fixture()
    expect(target.bridge).not.toHaveProperty('invoke')
    expect(target.bridge).not.toHaveProperty('onChanged')
    expect(target.bridge).not.toHaveProperty('send')
  })

  it('is mounted and declared as the isolated typed window API', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const declaration = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')
    expect(preload).toContain(
      "import { createChannelAgentIpcBridge } from './channelAgentIpcBridge'"
    )
    expect(preload).toContain('channelAgents: createChannelAgentIpcBridge(ipcRenderer)')
    expect(declaration).toContain(
      "import type { ChannelAgentIpcApi } from '../shared/collaboration/ChannelAgentIpc'"
    )
    expect(declaration).toMatch(/channelAgents:\s*ChannelAgentIpcApi/)
  })
})
