import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { composeRunPrompt } from '../PromptComposition'
import { COMPUTER_USE_ACTIONS } from './ComputerUseToolExecutor'
import { COMPUTER_USE_TOOL_DEFINITION } from './ComputerUseToolDefinition'
import { MCP_AUTO_ALLOWED_TOOLS, READ_ONLY_MCP_ADVERTISE_TOOLS } from './McpAutoAllowedTools'
import { resolveGatewayInvocation, searchGatewayCapabilities } from './McpToolGateway'
import {
  taskWraithGatewayDirectToolNamesForProfile,
  taskWraithGatewayHiddenToolNamesForProfile,
  taskWraithMcpAdvertisedToolNamesForProfile
} from './McpToolProfiles'
import {
  isGatewayTaskWraithMcpProfile,
  isGatewayV13DirectTaskWraithMcpProfile,
  isMeshCanvasDirectTaskWraithMcpProfile,
  isMeshTopologyDirectTaskWraithMcpProfile,
  isPermissionOpportunityDirectTaskWraithMcpProfile,
  isPortableEnsembleControlMcpProfile,
  isSketchCanvasDirectTaskWraithMcpProfile,
  isSoloTaskWraithMcpProfile,
  isTaskWraithMcpProfileId,
  resolveTaskWraithMcpProfile
} from './McpSessionProfileFence'

const successors = [
  ['taskwraith-gateway-v21', 'taskwraith-gateway-v20'],
  ['taskwraith-gateway-v21-mesh', 'taskwraith-gateway-v20-mesh'],
  ['taskwraith-gateway-solo-v5', 'taskwraith-gateway-solo-v4']
] as const

describe('Computer Use integration', () => {
  it.each(successors)('adds discovery in %s without changing %s', (next, previous) => {
    expect(isTaskWraithMcpProfileId(next)).toBe(true)
    const oldHidden = taskWraithGatewayHiddenToolNamesForProfile(previous)
    expect(oldHidden).not.toContain('computer_use')
    expect(taskWraithGatewayHiddenToolNamesForProfile(next)).toEqual([...oldHidden, 'computer_use'])
    expect(taskWraithGatewayDirectToolNamesForProfile(next)).toEqual(
      taskWraithGatewayDirectToolNamesForProfile(previous)
    )
    for (const predicate of [
      isGatewayTaskWraithMcpProfile,
      isGatewayV13DirectTaskWraithMcpProfile,
      isMeshCanvasDirectTaskWraithMcpProfile,
      isMeshTopologyDirectTaskWraithMcpProfile,
      isPermissionOpportunityDirectTaskWraithMcpProfile,
      isPortableEnsembleControlMcpProfile,
      isSketchCanvasDirectTaskWraithMcpProfile,
      isSoloTaskWraithMcpProfile
    ])
      expect(predicate(next)).toBe(predicate(previous))
    expect(
      resolveTaskWraithMcpProfile({
        provider: 'claude',
        providerSessionId: 'existing',
        receipt: {
          schemaVersion: 1,
          profileId: previous,
          provider: 'claude',
          providerSessionId: 'existing',
          pinnedAt: '2026-09-23T00:00:00Z'
        }
      }).profileId
    ).toBe(previous)
  })

  it('keeps the full fallback additive and the wrapper out of automatic approval', () => {
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-full-v4')).toEqual([
      ...taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-full-v3'),
      'computer_use'
    ])
    expect(MCP_AUTO_ALLOWED_TOOLS.has('computer_use')).toBe(false)
    expect(READ_ONLY_MCP_ADVERTISE_TOOLS).toContain('computer_use')
    expect(isPortableEnsembleControlMcpProfile('taskwraith-full-v4')).toBe(true)
  })

  it.each([
    ['taskwraith-full-v4', 'use computer_use directly'],
    ['taskwraith-gateway-v21', 'discover computer_use with capability_search'],
    ['taskwraith-gateway-v21-mesh', 'discover computer_use with capability_search'],
    ['taskwraith-gateway-solo-v5', 'discover computer_use with capability_search']
  ] as const)('gives %s a usable Computer Use entry point', (profileId, entryPoint) => {
    const result = composeRunPrompt({
      instructionContext: null,
      provider: 'claude',
      finalPrompt: 'Inspect the selected app window.',
      messages: [],
      chatContextTurns: 6,
      codexHandoffsApplied: [],
      isGlobalRun: false,
      approvalMode: 'default',
      providerLabel: 'Claude',
      taskWraithMcpAdvertised: true,
      taskWraithMcpProfileId: profileId
    })
    const hint = result.envelopeLayers.find((layer) => layer.id === 'computer_use_tools')
    expect(hint?.content).toContain(entryPoint)
    expect(result.contextualPrompt).toContain(hint?.content)
    if (profileId === 'taskwraith-full-v4') {
      expect(hint?.content).not.toContain('capability_search')
    }
  })

  it('finds one compact schema and keeps old receipt discovery unchanged', () => {
    const definitions = createTaskWraithMcpToolDefinitions()
    const eligibleToolNames = taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v21')
    const search = searchGatewayCapabilities({
      query: 'computer use',
      definitions,
      eligibleToolNames
    })
    expect(search.ok).toBe(true)
    expect(search.matches[0].name).toBe('computer_use')
    expect(
      resolveGatewayInvocation({
        name: 'computer_use',
        arguments: { action: 'list' },
        definitions,
        eligibleToolNames
      }).ok
    ).toBe(true)
    expect(
      resolveGatewayInvocation({
        name: 'computer_use',
        arguments: { action: 'list' },
        definitions,
        eligibleToolNames: taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v20')
      }).ok
    ).toBe(false)
    const properties = COMPUTER_USE_TOOL_DEFINITION.inputSchema?.properties as Record<
      string,
      { enum?: string[] }
    >
    expect(properties.action.enum).toEqual([...COMPUTER_USE_ACTIONS])
  })

  it('re-enters canonical dispatch before wrapper approval, preserving the original caller', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8')
    const start = source.indexOf("if (toolName === 'computer_use')")
    const branch = source.slice(
      start,
      source.indexOf('toolName === TOOL_PERMISSION_RETRY_TOOL_NAME &&', start)
    )
    expect(start).toBeGreaterThan(source.indexOf('const argumentPreflight ='))
    expect(branch).toContain("markDispatchHandled('computer-use')")
    expect(branch).toContain('executeComputerUseTool(args,')
    expect(branch).toContain('if (!isCanvasMcpToolName(name))')
    expect(branch).toContain(
      'executeGeminiMcpTool(name, targetArgs, effectiveRoute, parentProvider, callerContext,'
    )
    expect(branch).not.toContain('requestAgenticServiceApproval(')
    expect(branch).not.toContain('workspaceLockMcpAdmissionCoordinator.admit(')
    expect(
      source.match(
        /return \{ text: result\.text, isError: result\.isError, content: result\.content \}/g
      )
    ).toHaveLength(2)
  })
})
