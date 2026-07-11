import { describe, expect, it, vi } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { FULL_MCP_ADVERTISE_TOOLS, GATEWAY_MCP_DIRECT_TOOLS } from './McpToolProfiles'
import { resolveGatewayInvocation, selectGatewayHiddenToolNames } from './McpToolGateway'
import { dispatchResolvedGatewayTarget } from './McpGatewayTargetDispatch'

describe('dispatchResolvedGatewayTarget', () => {
  it('routes a hidden mutation through canonical approval and returns its rich result unchanged', async () => {
    const targetArguments = { path: 'old.txt', newName: 'new.txt' }
    const resolution = resolveGatewayInvocation({
      name: 'rename_path',
      arguments: targetArguments,
      definitions: createTaskWraithMcpToolDefinitions(),
      eligibleToolNames: selectGatewayHiddenToolNames({
        fullToolNames: FULL_MCP_ADVERTISE_TOOLS,
        directToolNames: GATEWAY_MCP_DIRECT_TOOLS
      })
    })
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)

    const route = { appRunId: 'run-1', appChatId: 'chat-1' }
    const callerContext = { approvalMode: 'default', callerCwd: '/workspace' }
    const approvalRequest = vi.fn()
    const richResult = {
      text: 'renamed',
      structuredContent: { from: 'old.txt', to: 'new.txt' },
      trustedMediaRefs: [{ kind: 'image', ref: 'preview-1' }]
    }
    const executeCanonical = vi.fn(
      async (
        targetName: string,
        receivedArguments: Record<string, unknown>,
        receivedRoute: typeof route,
        parentProvider: string,
        receivedCallerContext: typeof callerContext,
        marker: { viaGateway: true; gatewayToolName: 'capability_invoke' }
      ) => {
        approvalRequest(targetName, receivedCallerContext.approvalMode)
        expect(receivedArguments).toBe(targetArguments)
        expect(receivedRoute).toBe(route)
        expect(parentProvider).toBe('codex')
        expect(receivedCallerContext).toBe(callerContext)
        expect(marker).toEqual({ viaGateway: true, gatewayToolName: 'capability_invoke' })
        return richResult
      }
    )

    const result = await dispatchResolvedGatewayTarget({
      targetName: resolution.name,
      targetArguments: resolution.arguments,
      route,
      parentProvider: 'codex',
      callerContext,
      executeCanonical
    })

    expect(executeCanonical).toHaveBeenCalledOnce()
    expect(approvalRequest).toHaveBeenCalledWith('rename_path', 'default')
    expect(approvalRequest).not.toHaveBeenCalledWith('capability_invoke', expect.anything())
    expect(result).toBe(richResult)
  })
})
