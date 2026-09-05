import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import {
  taskWraithGatewayDirectToolNamesForProfile,
  taskWraithGatewayHiddenToolNamesForProfile
} from './McpToolProfiles'
import { isTaskWraithMcpProfileId } from './McpSessionProfileFence'
import { resolveToolDispatchContractStrict } from '../../shared/providerActionTaxonomy'

describe('continuity tool profile boundaries', () => {
  it('leaves old catalogues unchanged and adds new tools only to new profiles', () => {
    for (const old of [
      'taskwraith-gateway-v19',
      'taskwraith-gateway-v19-mesh',
      'taskwraith-gateway-solo-v3'
    ] as const) {
      const tools = [
        ...taskWraithGatewayDirectToolNamesForProfile(old),
        ...taskWraithGatewayHiddenToolNamesForProfile(old)
      ]
      expect(tools).not.toContain('tw_checkpoint')
      expect(tools).not.toContain('tw_history_read')
    }
    for (const current of [
      'taskwraith-gateway-v20',
      'taskwraith-gateway-v20-mesh',
      'taskwraith-gateway-solo-v4'
    ] as const) {
      expect(isTaskWraithMcpProfileId(current)).toBe(true)
      expect(taskWraithGatewayDirectToolNamesForProfile(current)).toContain('tw_checkpoint')
      expect(taskWraithGatewayHiddenToolNamesForProfile(current)).toEqual(
        expect.arrayContaining(['tw_history_search', 'tw_history_read'])
      )
    }
  })
  it('has callable schemas and explicit dispatch ownership for each new tool', () => {
    const definitions = createTaskWraithMcpToolDefinitions()
    for (const name of ['tw_checkpoint', 'tw_history_search', 'tw_history_read']) {
      expect(definitions.find((d) => d.name === name)?.inputSchema).toBeDefined()
      const resolution = resolveToolDispatchContractStrict(name)
      expect(resolution.ok).toBe(true)
      if (!resolution.ok) throw new Error('Missing dispatch contract')
      expect(resolution.dispatchOwner).toBe('thread-continuity')
    }
  })
})
